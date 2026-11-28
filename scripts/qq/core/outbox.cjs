const crypto = require('node:crypto');
const {normalizeSourceTimestamp} = require('./source_timestamp.cjs');
const {discordContentIdentity,mergeDiscordSnapshot} = require('../../discord_content_identity.cjs');

function createOutbox({state,send,allowed = () => true,onAccepted = () => {},now = Date.now}) {
  state.exec(`CREATE TABLE IF NOT EXISTS sender_outbox (
    task_key TEXT PRIMARY KEY, source TEXT NOT NULL, group_openid TEXT NOT NULL,
    channel_id TEXT NOT NULL, source_message_id TEXT NOT NULL, source_timestamp TEXT NOT NULL,
    message_json TEXT NOT NULL, context_json TEXT NOT NULL,
    status TEXT NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, error TEXT);
    CREATE INDEX IF NOT EXISTS ix_outbox_pending ON sender_outbox(status,next_attempt_at,source_timestamp);
    CREATE INDEX IF NOT EXISTS ix_outbox_identity ON sender_outbox(group_openid,source_message_id,status);`);
  if (!state.prepare('PRAGMA table_info(sender_outbox)').all().some(column => column.name === 'content_identity')) {
    state.exec('ALTER TABLE sender_outbox ADD COLUMN content_identity TEXT');
  }
  state.exec(`CREATE INDEX IF NOT EXISTS ix_outbox_content
    ON sender_outbox(group_openid,channel_id,source_message_id,content_identity);`);
  const terminalStatuses = ['accepted','skipped_duplicate','skipped_attachment','blocked_source','unknown'];
  const hasParts = !!state.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='forward_attempts'").get();
  function equivalents(message,context) {
    if (message.source_message_id.startsWith('telegram:')) return [];
    const rows = state.prepare(`SELECT * FROM sender_outbox WHERE source='discord'
      AND group_openid=? AND channel_id=? AND source_message_id=? AND content_identity=?
      AND NOT (status='skipped_duplicate' AND COALESCE(error,'') LIKE 'Equivalent Discord content; retained task %')`)
      .all(context.group_openid,message.channel_id,message.source_message_id,discordContentIdentity(message));
    for (const row of rows) {
      row.accepted_parts = hasParts ? state.prepare("SELECT COUNT(*) AS n FROM forward_attempts WHERE task_key=? AND status='accepted'")
        .get(row.task_key).n : 0;
    }
    return rows.sort((a,b) => Number(!terminalStatuses.includes(a.status))-Number(!terminalStatuses.includes(b.status))
      || Number(b.status === 'accepted')-Number(a.status === 'accepted')
      || b.accepted_parts-a.accepted_parts || a.updated_at.localeCompare(b.updated_at) || a.task_key.localeCompare(b.task_key));
  }
  function uncertain(message,context) {
    return state.prepare(`SELECT 1 FROM sender_outbox
      WHERE group_openid=? AND source_message_id=? AND status='unknown' LIMIT 1`)
      .get(context.group_openid,message.source_message_id);
  }
  function recover() {
    state.prepare("UPDATE sender_outbox SET status='queued' WHERE status='processing'").run();
    state.exec('BEGIN IMMEDIATE');
    let skipped = 0;
    try {
      for (const row of state.prepare("SELECT task_key,message_json FROM sender_outbox WHERE source='discord' AND content_identity IS NULL").all()) {
        state.prepare('UPDATE sender_outbox SET content_identity=? WHERE task_key=?')
          .run(discordContentIdentity(JSON.parse(row.message_json)),row.task_key);
      }
      const groups = state.prepare(`SELECT message_json,context_json FROM sender_outbox WHERE source='discord'
        AND content_identity IS NOT NULL GROUP BY group_openid,channel_id,source_message_id,content_identity HAVING COUNT(*)>1`).all();
      for (const group of groups) {
        const rows = equivalents(JSON.parse(group.message_json),JSON.parse(group.context_json));
        const keeper = rows[0];
        if (!keeper) continue;
        if (!terminalStatuses.includes(keeper.status)) {
          if (hasParts) {
            // A crash or an older duplicate task may have acknowledged a part
            // under another legacy hash. Preserve those receipts on the keeper.
            for (const row of rows.slice(1)) {
              for (const part of state.prepare("SELECT * FROM forward_attempts WHERE task_key=? AND status='accepted'").all(row.task_key)) {
                const existing = state.prepare('SELECT status FROM forward_attempts WHERE task_key=? AND part_index=?')
                  .get(keeper.task_key,part.part_index);
                if (existing && ['accepted','unknown'].includes(existing.status)) continue;
                const columns = Object.keys(part);
                const assignments = columns.filter(name => !['task_key','part_index'].includes(name))
                  .map(name => `${name}=excluded.${name}`).join(',');
                state.prepare(`INSERT INTO forward_attempts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
                  ON CONFLICT(task_key,part_index) DO UPDATE SET ${assignments}`)
                  .run(...columns.map(name => name === 'task_key' ? keeper.task_key : part[name]));
              }
            }
          }
          let snapshot = JSON.parse(keeper.message_json);
          for (const row of [...rows].sort((a,b) => {
            const left = JSON.parse(a.message_json),right = JSON.parse(b.message_json);
            return String(left.captured_at || a.updated_at).localeCompare(String(right.captured_at || b.updated_at));
          })) snapshot = mergeDiscordSnapshot(snapshot,JSON.parse(row.message_json));
          state.prepare('UPDATE sender_outbox SET message_json=? WHERE task_key=?').run(JSON.stringify(snapshot),keeper.task_key);
        }
        for (const row of rows.slice(1)) {
          if (!['queued','deferred'].includes(row.status)) continue;
          skipped += state.prepare("UPDATE sender_outbox SET status='skipped_duplicate',next_attempt_at=0,updated_at=?,error=? WHERE task_key=?")
            .run(new Date(now()).toISOString(),`Equivalent Discord content; retained task ${keeper.task_key}`,row.task_key).changes;
        }
      }
      state.exec('COMMIT');
    } catch (error) {state.exec('ROLLBACK');throw error;}
    return {skipped_duplicate_tasks:skipped};
  }
  function taskKey(message,context) {
    return crypto.createHash('sha256').update(JSON.stringify([
      context.group_openid,message.channel_id,message.source_message_id,message.content_sha256
    ])).digest('hex');
  }
  function terminal(message,context) {
    if (uncertain(message,context)) return true;
    const equivalent = equivalents(message,context)[0];
    if (equivalent) return terminalStatuses.includes(equivalent.status);
    const row = state.prepare('SELECT status FROM sender_outbox WHERE task_key=?').get(taskKey(message,context));
    return row && ['accepted','skipped_duplicate','skipped_attachment','blocked_source','unknown'].includes(row.status);
  }
  function enqueue(message,context) {
    message = normalizeSourceTimestamp(message);
    const identity = discordContentIdentity(message);
    const equivalent = equivalents(message,context)[0];
    const key = equivalent?.task_key || taskKey(message,context);
    if (equivalent) {
      const previous = JSON.parse(equivalent.message_json);
      // Replanning visits old archives too: preserve the newest usable snapshot.
      message = previous.captured_at && message.captured_at && previous.captured_at > message.captured_at
        ? mergeDiscordSnapshot(message,previous) : mergeDiscordSnapshot(previous,message);
      message.content_sha256 = previous.content_sha256;
    }
    state.prepare(`INSERT INTO sender_outbox
      (task_key,source,group_openid,channel_id,source_message_id,source_timestamp,message_json,context_json,status,updated_at,content_identity)
      VALUES (?,?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(task_key) DO UPDATE SET
      next_attempt_at=CASE WHEN sender_outbox.message_json<>excluded.message_json THEN 0 ELSE sender_outbox.next_attempt_at END,
      source_timestamp=excluded.source_timestamp,message_json=excluded.message_json,context_json=excluded.context_json
      WHERE sender_outbox.status IN ('queued','deferred')`)
      .run(key,message.source_message_id.startsWith('telegram:') ? 'telegram' : 'discord',context.group_openid,
        message.channel_id,message.source_message_id,message.source_timestamp,
        JSON.stringify(message),JSON.stringify(context),new Date(now()).toISOString(),identity);
    return key;
  }
  async function drain(limit = 100) {
    const jobs = state.prepare(`SELECT * FROM sender_outbox WHERE status IN ('queued','deferred')
      AND next_attempt_at<=? ORDER BY next_attempt_at,source_timestamp,task_key LIMIT ?`).all(now(),limit);
    for (const job of jobs) {
      // A snapshot selected before another job completed must still pass the
      // persisted content guard immediately before any network operation.
      const live = state.prepare('SELECT status FROM sender_outbox WHERE task_key=?').get(job.task_key);
      if (!['queued','deferred'].includes(live?.status)) continue;
      let message,context;
      try {
        message = JSON.parse(job.message_json);
        context = JSON.parse(job.context_json);
        if (uncertain(message,context)) {
          state.prepare("UPDATE sender_outbox SET status='unknown',updated_at=?,error=? WHERE task_key=?")
            .run(new Date(now()).toISOString(),'Another version has an uncertain send result',job.task_key);
          continue;
        }
        const equivalent = equivalents(message,context)[0];
        if (equivalent && equivalent.task_key !== job.task_key) {
          state.prepare("UPDATE sender_outbox SET status='skipped_duplicate',updated_at=?,error=? WHERE task_key=?")
            .run(new Date(now()).toISOString(),`Equivalent Discord content; retained task ${equivalent.task_key}`,job.task_key);
          continue;
        }
        if (!allowed(message,context)) {
          state.prepare('UPDATE sender_outbox SET next_attempt_at=? WHERE task_key=?').run(now()+5000,job.task_key);
          continue;
        }
      } catch (error) {
        state.prepare("UPDATE sender_outbox SET status='deferred',next_attempt_at=?,error=? WHERE task_key=?")
          .run(now()+5000,String(error.message).slice(0,1000),job.task_key);
        continue;
      }
      state.prepare("UPDATE sender_outbox SET status='processing',attempts=attempts+1,updated_at=? WHERE task_key=?")
        .run(new Date(now()).toISOString(),job.task_key);
      try {
        const outcome = await send(message,context);
        const status = ['accepted','skipped_duplicate','skipped_attachment','blocked_source','unknown'].includes(outcome) ? outcome : 'deferred';
        state.prepare('UPDATE sender_outbox SET status=?,next_attempt_at=?,updated_at=?,error=NULL WHERE task_key=?')
          .run(status,status === 'deferred' ? now()+5000 : 0,new Date(now()).toISOString(),job.task_key);
        if (status === 'accepted' || status === 'skipped_duplicate') {
          try { onAccepted(message,context); }
          catch (error) {
            state.prepare('UPDATE sender_outbox SET error=? WHERE task_key=?')
              .run(String(error.message).slice(0,1000),job.task_key);
          }
        }
      } catch (error) {
        state.prepare("UPDATE sender_outbox SET status='unknown',updated_at=?,error=? WHERE task_key=?")
          .run(new Date(now()).toISOString(),String(error.message).slice(0,1000),job.task_key);
      }
    }
  }
  function status() {
    return state.prepare('SELECT source,status,COUNT(*) AS count FROM sender_outbox GROUP BY source,status').all();
  }
  return {enqueue,drain,status,recover,terminal};
}
module.exports = {createOutbox};

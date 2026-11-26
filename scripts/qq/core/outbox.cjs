const crypto = require('node:crypto');
const {normalizeSourceTimestamp} = require('./source_timestamp.cjs');

function createOutbox({state,send,allowed = () => true,onAccepted = () => {},now = Date.now}) {
  state.exec(`CREATE TABLE IF NOT EXISTS sender_outbox (
    task_key TEXT PRIMARY KEY, source TEXT NOT NULL, group_openid TEXT NOT NULL,
    channel_id TEXT NOT NULL, source_message_id TEXT NOT NULL, source_timestamp TEXT NOT NULL,
    message_json TEXT NOT NULL, context_json TEXT NOT NULL,
    status TEXT NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, error TEXT);
    CREATE INDEX IF NOT EXISTS ix_outbox_pending ON sender_outbox(status,next_attempt_at,source_timestamp);
    CREATE INDEX IF NOT EXISTS ix_outbox_identity ON sender_outbox(group_openid,source_message_id,status);`);
  function uncertain(message,context) {
    return state.prepare(`SELECT 1 FROM sender_outbox
      WHERE group_openid=? AND source_message_id=? AND status='unknown' LIMIT 1`)
      .get(context.group_openid,message.source_message_id);
  }
  function recover() {
    state.prepare("UPDATE sender_outbox SET status='queued' WHERE status='processing'").run();
  }
  function taskKey(message,context) {
    return crypto.createHash('sha256').update(JSON.stringify([
      context.group_openid,message.channel_id,message.source_message_id,message.content_sha256
    ])).digest('hex');
  }
  function terminal(message,context) {
    if (uncertain(message,context)) return true;
    const row = state.prepare('SELECT status FROM sender_outbox WHERE task_key=?').get(taskKey(message,context));
    return row && ['accepted','skipped_duplicate','skipped_attachment','blocked_source','unknown'].includes(row.status);
  }
  function enqueue(message,context) {
    message = normalizeSourceTimestamp(message);
    const key = taskKey(message,context);
    state.prepare(`INSERT INTO sender_outbox
      (task_key,source,group_openid,channel_id,source_message_id,source_timestamp,message_json,context_json,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'queued',?) ON CONFLICT(task_key) DO UPDATE SET
      next_attempt_at=CASE WHEN sender_outbox.message_json<>excluded.message_json THEN 0 ELSE sender_outbox.next_attempt_at END,
      source_timestamp=excluded.source_timestamp,message_json=excluded.message_json,context_json=excluded.context_json
      WHERE sender_outbox.status IN ('queued','deferred')`)
      .run(key,message.source_message_id.startsWith('telegram:') ? 'telegram' : 'discord',context.group_openid,
        message.channel_id,message.source_message_id,message.source_timestamp,
        JSON.stringify(message),JSON.stringify(context),new Date(now()).toISOString());
    return key;
  }
  async function drain(limit = 100) {
    const jobs = state.prepare(`SELECT * FROM sender_outbox WHERE status IN ('queued','deferred')
      AND next_attempt_at<=? ORDER BY next_attempt_at,source_timestamp,task_key LIMIT ?`).all(now(),limit);
    for (const job of jobs) {
      let message,context;
      try {
        message = JSON.parse(job.message_json);
        context = JSON.parse(job.context_json);
        if (uncertain(message,context)) {
          state.prepare("UPDATE sender_outbox SET status='unknown',updated_at=?,error=? WHERE task_key=?")
            .run(new Date(now()).toISOString(),'Another version has an uncertain send result',job.task_key);
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

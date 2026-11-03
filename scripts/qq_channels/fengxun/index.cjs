const crypto = require('node:crypto');

const channelId = '1405206823727796408';
const duplicateWindowMs = 5 * 60 * 1000;

function attachmentIdentity(item) {
  const url = String(item.source_url || '');
  if (item.kind !== 'image') return [item.kind || '', url];
  try {
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const match = filename.match(/^(?:wm_\d+_)?(wxauto_image_\d+\.(?:png|jpe?g))$/i);
    if (match) return ['image', `wxauto:${match[1].toLowerCase()}`];
  } catch { /* Preserve the original URL when it cannot be parsed. */ }
  return [item.kind || '', url];
}

function fingerprint(message) {
  const attachments = JSON.parse(message.attachments_json).map(attachmentIdentity);
  return crypto.createHash('sha256').update(JSON.stringify([
    String(message.author_display || '').trim(),
    String(message.body_raw || '').replace(/\r\n/g, '\n').trim(),
    attachments
  ])).digest('hex');
}

function initialize(state) {
  state.exec(`CREATE TABLE IF NOT EXISTS fengxun_forwarded_content (
    task_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source_message_id TEXT NOT NULL,
    source_time_ms INTEGER NOT NULL, accepted_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ix_fengxun_fingerprint ON fengxun_forwarded_content(fingerprint,source_time_ms);
  CREATE TABLE IF NOT EXISTS fengxun_duplicate_skips (
    task_key TEXT PRIMARY KEY, source_message_id TEXT NOT NULL, canonical_source_message_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, source_timestamp TEXT, skipped_at TEXT NOT NULL);`);
}

function beforeSend(state, key, message, groupOpenid, sourceTime) {
  if (state.prepare('SELECT 1 FROM fengxun_duplicate_skips WHERE task_key=?').get(key)) return {skip: true};
  const value = crypto.createHash('sha256').update(`${groupOpenid}:${fingerprint(message)}`).digest('hex');
  const time = sourceTime(message);
  if (Number.isFinite(time)) {
    const prior = state.prepare(`SELECT source_message_id FROM fengxun_forwarded_content
      WHERE fingerprint=? AND source_message_id<>? AND source_time_ms BETWEEN ? AND ?
      ORDER BY accepted_at LIMIT 1`).get(value,message.source_message_id,
        time - duplicateWindowMs,time + duplicateWindowMs);
    if (prior) {
      state.prepare(`INSERT OR IGNORE INTO fengxun_duplicate_skips
        (task_key,source_message_id,canonical_source_message_id,fingerprint,source_timestamp,skipped_at)
        VALUES (?,?,?,?,?,?)`).run(key,message.source_message_id,prior.source_message_id,
          value,message.source_timestamp || null,new Date().toISOString());
      console.log(`风寻跳过重复 QQ 发送：Discord ${message.source_message_id} 与已发送 ${prior.source_message_id} 正文及附件相同。`);
      return {skip: true};
    }
  }
  return {skip: false, value, time};
}

function afterSend(state, key, message, result) {
  if (!result || !Number.isFinite(result.time)) return;
  state.prepare(`INSERT OR IGNORE INTO fengxun_forwarded_content
    (task_key,fingerprint,source_message_id,source_time_ms,accepted_at) VALUES (?,?,?,?,?)`)
    .run(key,result.value,message.source_message_id,result.time,new Date().toISOString());
}

module.exports = {channelId, fingerprint, initialize, beforeSend, afterSend};

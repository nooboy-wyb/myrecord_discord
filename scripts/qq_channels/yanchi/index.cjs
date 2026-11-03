const crypto = require('node:crypto');

const channelId = '1254782508793593947';
const channelIds = [channelId, '1296438667438719028', '1439232860014907412'];
const fanwanChannelId = '1296438667438719028';
const duplicateWindowMs = 5 * 60 * 1000;

function cleanFanwanBody(raw) {
  const body = raw.replace(/\r\n/g, '\n')
    .replace(/\n\s*---\s*\n\s*转发规则[：:][^\n]*\s*$/u, '').trim();
  const firstLine = body.split('\n', 1)[0];
  if (!firstLine) return body;
  let repeatAt = body.indexOf(`\n${firstLine}`);
  while (repeatAt >= 0) {
    const first = body.slice(0, repeatAt).trim();
    const second = body.slice(repeatAt + 1).trim();
    if (first === second) return first;
    repeatAt = body.indexOf(`\n${firstLine}`, repeatAt + 1);
  }
  return body;
}

function displayBody(message, images) {
  // Discord 的无文字单图占位词不应出现在 QQ 消息中。
  if (String(message.body_raw || '').trim().toLowerCase() === 'no text') {
    return images.length ? '' : '（原图未采到，待核对）';
  }
  return message.channel_id === fanwanChannelId
    ? cleanFanwanBody(message.body_raw) : message.body_raw;
}

function fanwanFingerprint(message) {
  const attachments = JSON.parse(message.attachments_json).map(item => [item.kind || '', item.source_url || '']);
  return crypto.createHash('sha256').update(JSON.stringify([
    String(message.author_display || '').trim(),
    cleanFanwanBody(String(message.body_raw || '')),
    attachments
  ])).digest('hex');
}

function initialize(state) {
  state.exec(`CREATE TABLE IF NOT EXISTS yanchi_alert_forwarded_content (
    task_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source_message_id TEXT NOT NULL,
    source_time_ms INTEGER NOT NULL, accepted_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ix_yanchi_alert_fingerprint ON yanchi_alert_forwarded_content(fingerprint,source_time_ms);
  CREATE TABLE IF NOT EXISTS yanchi_alert_duplicate_skips (
    task_key TEXT PRIMARY KEY, source_message_id TEXT NOT NULL, canonical_source_message_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, source_timestamp TEXT, skipped_at TEXT NOT NULL);`);
}

function beforeSend(state, key, message, groupOpenid, sourceTime) {
  if (state.prepare('SELECT 1 FROM yanchi_alert_duplicate_skips WHERE task_key=?').get(key)) return {skip: true};
  const value = crypto.createHash('sha256').update(`${groupOpenid}:${fanwanFingerprint(message)}`).digest('hex');
  const time = sourceTime(message);
  if (Number.isFinite(time)) {
    const prior = state.prepare(`SELECT source_message_id FROM yanchi_alert_forwarded_content
      WHERE fingerprint=? AND source_message_id<>? AND source_time_ms BETWEEN ? AND ?
      ORDER BY accepted_at LIMIT 1`).get(value,message.source_message_id,
        time - duplicateWindowMs,time + duplicateWindowMs);
    if (prior) {
      state.prepare(`INSERT OR IGNORE INTO yanchi_alert_duplicate_skips
        (task_key,source_message_id,canonical_source_message_id,fingerprint,source_timestamp,skipped_at)
        VALUES (?,?,?,?,?,?)`).run(key,message.source_message_id,prior.source_message_id,
          value,message.source_timestamp || null,new Date().toISOString());
      console.log(`饭碗警报跳过重复 QQ 发送：Discord ${message.source_message_id} 与已发送 ${prior.source_message_id} 内容相同。`);
      return {skip: true};
    }
  }
  return {skip: false, value, time};
}

function afterSend(state, key, message, result) {
  if (!result || !Number.isFinite(result.time)) return;
  state.prepare(`INSERT OR IGNORE INTO yanchi_alert_forwarded_content
    (task_key,fingerprint,source_message_id,source_time_ms,accepted_at) VALUES (?,?,?,?,?)`)
    .run(key,result.value,message.source_message_id,result.time,new Date().toISOString());
}

module.exports = {channelId, channelIds, fanwanChannelId, displayBody, cleanFanwanBody,
  fanwanFingerprint, initialize, beforeSend, afterSend};

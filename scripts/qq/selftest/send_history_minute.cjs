const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const fengxun = require('../../qq_channels/fengxun/index.cjs');

const minute = process.argv[2];
const expectedCount = Number(process.argv[3]);
const endMinute = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : minute;
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(minute || '')
  || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endMinute || '')
  || !Number.isInteger(expectedCount) || expectedCount < 1) {
  throw Error('Usage: node send_history_minute.cjs START_MINUTE EXPECTED_COUNT [END_MINUTE] (Beijing time)');
}
const start = Date.parse(`${minute}:00+08:00`);
const endStart = Date.parse(`${endMinute}:00+08:00`);
if (!Number.isFinite(start) || !Number.isFinite(endStart) || endStart < start) throw Error('Invalid Beijing time range');
const end = new Date(endStart + 60_000).toISOString();
const dataDir = path.resolve(__dirname, '..', '..', '..', 'data');
const route = JSON.parse(fs.readFileSync(path.join(dataDir, 'qq-additional-routes.json'), 'utf8'))
  .routes.find(item => item.qq_group_number === '1132949059');
if (!route?.group_openid || !route.channel_ids.includes(fengxun.channelId)) throw Error('Group 2 Fengxun route unavailable');

const messages = [];
for (const day of fs.readdirSync(dataDir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))) {
  const file = path.join(dataDir, day, 'messages.sqlite');
  if (!fs.existsSync(file)) continue;
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    for (const message of db.prepare(`SELECT id,channel_id,channel_name,author_display,source_message_id,
      source_timestamp,content_sha256,body_raw,attachments_json,captured_at
      FROM discord_web_messages WHERE channel_id=? AND source_timestamp>=? AND source_timestamp<?`)
      .all(fengxun.channelId,new Date(start).toISOString(),end)) {
      const attachments = db.prepare(`SELECT source_url,local_path,status,error
        FROM discord_web_attachment_files WHERE message_id=?`).all(message.id);
      messages.push({...message,attachments});
    }
  } finally { db.close(); }
}
messages.sort((a,b) => a.source_timestamp.localeCompare(b.source_timestamp));
if (messages.length !== expectedCount) throw Error(`Expected ${expectedCount} messages from ${minute} to ${endMinute}, found ${messages.length}`);

const state = new DatabaseSync(path.join(dataDir, 'qq-forward.sqlite'), {readOnly: true});
try {
  for (const message of messages) {
    if (state.prepare('SELECT 1 FROM forward_attempts WHERE group_openid=? AND source_message_id=? LIMIT 1')
      .get(route.group_openid,message.source_message_id)) throw Error(`Already attempted: ${message.source_message_id}`);
    const images = JSON.parse(message.attachments_json).filter(item => item?.source_url);
    for (const image of images) {
      const file = message.attachments.find(item => item.source_url === image.source_url);
      if (file?.status !== 'saved' || !file.local_path || !fs.existsSync(file.local_path)
        || !/\.(png|jpe?g)$/i.test(file.local_path) || fs.statSync(file.local_path).size > 5_000_000) {
        throw Error(`Original image unavailable: ${message.source_message_id}`);
      }
    }
  }
} finally { state.close(); }
console.log(`Ready: ${messages.length} Fengxun messages from ${minute} to ${endMinute} Beijing time to QQ group 1132949059`);
if (process.argv.includes('--check-only')) process.exit(0);

async function main() {
  const forwarder = require('../core/forwarder.cjs');
  for (const message of messages) {
    const outcome = await forwarder.processMessage(message,{group_openid:route.group_openid,history:true});
    console.log(`History test ${message.source_message_id}: ${outcome}`);
    if (!['accepted','skipped_duplicate'].includes(outcome)) throw Error('History test stopped; inspect forward_attempts before retrying');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

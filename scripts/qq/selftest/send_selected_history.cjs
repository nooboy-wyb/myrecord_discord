const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const sourceIds = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (sourceIds.length !== 2 || sourceIds.some(id => !/^\d+$/.test(id))) {
  throw Error('Usage: node send_selected_history.cjs FIRST_SOURCE_ID SECOND_SOURCE_ID [--check-only]');
}
const expectedChannels = new Set(['1296438667438719028','1439232860014907412']);
const dataDir = path.resolve(__dirname, '..', '..', '..', 'data');
const route = JSON.parse(fs.readFileSync(path.join(dataDir, 'qq-additional-routes.json'), 'utf8'))
  .routes.find(item => item.qq_group_number === '1132949059');
if (!route?.group_openid || [...expectedChannels].some(id => !route.channel_ids.includes(id))) {
  throw Error('Group 2 routes for both test channels are unavailable');
}
const selected = new Map();
for (const day of fs.readdirSync(dataDir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))) {
  const file = path.join(dataDir, day, 'messages.sqlite');
  if (!fs.existsSync(file)) continue;
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    for (const id of sourceIds) {
      const message = db.prepare(`SELECT id,channel_id,channel_name,author_display,source_message_id,
        source_timestamp,content_sha256,body_raw,attachments_json,captured_at
        FROM discord_web_messages WHERE source_message_id=?`).get(id);
      if (!message) continue;
      const attachments = db.prepare(`SELECT source_url,local_path,status,error
        FROM discord_web_attachment_files WHERE message_id=?`).all(message.id);
      const prior = selected.get(id);
      if (!prior || message.captured_at > prior.captured_at) selected.set(id,{...message,attachments});
    }
  } finally { db.close(); }
}
if (selected.size !== 2 || new Set([...selected.values()].map(item => item.channel_id)).size !== 2
  || [...selected.values()].some(item => !expectedChannels.has(item.channel_id))) {
  throw Error('Expected one archived message from each new Yan Chi channel');
}
const state = new DatabaseSync(path.join(dataDir, 'qq-forward.sqlite'), {readOnly: true});
try {
  for (const message of selected.values()) {
    if (state.prepare('SELECT 1 FROM forward_attempts WHERE group_openid=? AND source_message_id=? LIMIT 1')
      .get(route.group_openid,message.source_message_id)) throw Error(`Already attempted: ${message.source_message_id}`);
    for (const image of JSON.parse(message.attachments_json).filter(item => item?.source_url)) {
      const file = message.attachments.find(item => item.source_url === image.source_url);
      if (file?.status !== 'saved' || !file.local_path || !fs.existsSync(file.local_path)
        || !/\.(png|jpe?g)$/i.test(file.local_path) || fs.statSync(file.local_path).size > 5_000_000) {
        throw Error(`Original image unavailable: ${message.source_message_id}`);
      }
    }
  }
} finally { state.close(); }
console.log(`Ready: ${sourceIds.map(id => `${selected.get(id).channel_id}:${id}`).join(', ')} -> QQ group 1132949059`);
if (process.argv.includes('--check-only')) process.exit(0);

async function main() {
  const forwarder = require('../core/forwarder.cjs');
  for (const id of sourceIds) {
    const outcome = await forwarder.processMessage(selected.get(id),{group_openid:route.group_openid,history:true});
    console.log(`History test ${id}: ${outcome}`);
    if (outcome !== 'accepted') throw Error('History test stopped; inspect forward_attempts before retrying');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

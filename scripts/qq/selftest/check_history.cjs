const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const yanchi = require('../../qq_channels/yanchi/index.cjs');
const fengxun = require('../../qq_channels/fengxun/index.cjs');

const dataDir = path.resolve(__dirname, '..', '..', '..', 'data');
const names = new Map([
  [yanchi.channelId, '颜驰'],
  ['1296438667438719028', '颜驰 饭碗警报'],
  ['1439232860014907412', '颜驰 视频解说'],
  [fengxun.channelId, '风寻'],
]);
const selected = process.argv.slice(2);
const channels = selected.length ? selected : [...names.keys()];
if (channels.some(id => !/^\d+$/.test(id))) {
  console.error('Usage: node scripts/qq/selftest/check_history.cjs [CHANNEL_ID ...]');
  process.exit(1);
}

for (const channelId of channels) {
  let rows = 0;
  const messageIds = new Set();
  let first = null;
  let last = null;
  let latestCapture = null;
  for (const day of fs.readdirSync(dataDir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort()) {
    const file = path.join(dataDir, day, 'messages.sqlite');
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, {readOnly: true});
    try {
      for (const row of db.prepare(`SELECT source_message_id, source_timestamp, captured_at
        FROM discord_web_messages WHERE channel_id=?`).all(channelId)) {
        rows++;
        messageIds.add(row.source_message_id);
        if (row.source_timestamp && (!first || row.source_timestamp < first)) first = row.source_timestamp;
        if (row.source_timestamp && (!last || row.source_timestamp > last)) last = row.source_timestamp;
        if (row.captured_at && (!latestCapture || row.captured_at > latestCapture)) latestCapture = row.captured_at;
      }
    } finally { db.close(); }
  }
  console.log(JSON.stringify({channel: names.get(channelId) || channelId, channel_id: channelId,
    rows, unique_messages: messageIds.size, first_source_time: first,
    last_source_time: last, latest_capture_time: latestCapture}));
}

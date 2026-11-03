const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const root = path.resolve(__dirname, '..', 'data');
const channelId = process.argv[2];
const count = Number(process.argv[3] || 20);
if (!/^\d+$/.test(channelId || '') || !Number.isInteger(count) || count < 1 || count > 50) {
  console.error('Usage: node queue_qq_history.cjs CHANNEL_ID COUNT (1-50)');
  process.exit(1);
}
const files = fs.readdirSync(root,{withFileTypes:true})
  .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map(entry => path.join(root,entry.name,'messages.sqlite')).filter(file => fs.existsSync(file));
const ids = new Set();
for (const file of files) {
  const db = new DatabaseSync(file,{readOnly:true});
  try { for (const row of db.prepare('SELECT source_message_id FROM discord_web_messages WHERE channel_id=?').all(channelId)) ids.add(row.source_message_id); }
  finally { db.close(); }
}
if (ids.size < count) {
  console.error(`只入库了 ${ids.size} 条不同消息；请先在该 Discord 频道向上滚动，等最近 ${count} 条进入本地归档。`);
  process.exit(1);
}
const stateFile = path.join(root,'qq-forward.sqlite');
if (!fs.existsSync(stateFile)) throw Error('请先启动 Discord + QQ 常驻服务');
const state = new DatabaseSync(stateFile);
try {
  const pending = state.prepare("SELECT id FROM replay_requests WHERE channel_id=? AND status='pending'").get(channelId);
  if (pending) throw Error('此频道已有待处理的历史补发请求');
  const result = state.prepare("INSERT INTO replay_requests(channel_id,message_limit,status,created_at) VALUES (?,?,'pending',?)")
    .run(channelId,count,new Date().toISOString());
  console.log(`已提交历史补发请求 ${result.lastInsertRowid}：频道 ${channelId}，最近 ${count} 条。请观察常驻窗口和 QQ 群。`);
} finally { state.close(); }

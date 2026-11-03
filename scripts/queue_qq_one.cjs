const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const sourceId = process.argv[2];
if (!/^\d+$/.test(sourceId || '')) throw Error('Usage: node queue_qq_one.cjs DISCORD_MESSAGE_ID');
const root = path.resolve(__dirname, '..', 'data');
let selected;
for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
  const file = path.join(root, entry.name, 'messages.sqlite');
  if (!fs.existsSync(file)) continue;
  const db = new DatabaseSync(file, {readOnly:true});
  try {
    for (const row of db.prepare(`SELECT id,channel_id,source_message_id,content_sha256,source_timestamp,
      captured_at,body_raw,attachments_json FROM discord_web_messages WHERE source_message_id=?`).all(sourceId)) {
      const images = JSON.parse(row.attachments_json);
      const files = db.prepare('SELECT status FROM discord_web_attachment_files WHERE message_id=?').all(row.id);
      if (images.length && files.filter(item => item.status === 'saved').length !== images.length) continue;
      if (!selected || row.captured_at > selected.captured_at) selected = row;
    }
  } finally { db.close(); }
}
if (!selected) throw Error('原消息未入库，或原图尚未完整保存；未提交补发。');
const state = new DatabaseSync(path.join(root, 'qq-forward.sqlite'));
try {
  const existing = state.prepare('SELECT part_type,status FROM forward_attempts WHERE source_message_id=?').all(sourceId);
  if (existing.length) throw Error(`这条消息已有 QQ 发送记录：${JSON.stringify(existing)}；请先人工核对。`);
  state.exec('BEGIN IMMEDIATE');
  try {
    const result = state.prepare(`INSERT INTO replay_requests(channel_id,message_limit,status,created_at)
      VALUES (?,1,'pending',?)`).run(selected.channel_id, new Date().toISOString());
    state.prepare(`INSERT INTO replay_items(request_id,source_message_id,content_sha256,channel_id,source_timestamp,status)
      VALUES (?,?,?,?,?,'pending')`).run(result.lastInsertRowid, selected.source_message_id,
      selected.content_sha256, selected.channel_id, selected.source_timestamp);
    state.exec('COMMIT');
    console.log(`已排队单条历史补发：请求 ${result.lastInsertRowid}，消息 ${sourceId}，图片 ${JSON.parse(selected.attachments_json).length} 张。`);
  } catch (error) { state.exec('ROLLBACK'); throw error; }
} finally { state.close(); }

const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const root = path.resolve(__dirname, '..', 'data');
const requestId = Number(process.argv[2] || 1);
if (!Number.isInteger(requestId) || requestId < 1) throw Error('Invalid replay request ID');
const state = new DatabaseSync(path.join(root, 'qq-forward.sqlite'), {readOnly: true});
const request = state.prepare('SELECT * FROM replay_requests WHERE id=?').get(requestId);
if (!request) throw Error(`Replay request ${requestId} does not exist`);
const attempts = state.prepare(`SELECT source_message_id,part_type,status,attempted_at,platform_message_id,error
  FROM forward_attempts WHERE attempted_at>=? AND attempted_at<=? ORDER BY attempted_at`)
  .all(request.created_at,request.completed_at || new Date().toISOString());
state.close();
const ids = [...new Set(attempts.map(row => row.source_message_id))];
const files = fs.readdirSync(root,{withFileTypes:true})
  .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map(entry => path.join(root,entry.name,'messages.sqlite')).filter(file => fs.existsSync(file));
const messages = new Map();
for (const file of files) {
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    for (const id of ids) {
      const row = db.prepare(`SELECT id,channel_id,source_message_id,author_display,source_timestamp,captured_at,body_raw,body_kind,
        attachments_json,message_url FROM discord_web_messages WHERE channel_id=? AND source_message_id=?
        ORDER BY captured_at DESC LIMIT 1`).get(request.channel_id,id);
      if (row && (!messages.has(id) || messages.get(id).captured_at < row.captured_at)) {
        row.local_images = db.prepare(`SELECT local_path,status FROM discord_web_attachment_files WHERE message_id=? ORDER BY id`).all(row.id);
        messages.set(id,row);
      }
    }
  } finally { db.close(); }
}
const beijing = value => value ? new Intl.DateTimeFormat('sv-SE',{
  timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',
}).format(new Date(value)) : '';
const csv = value => `"${String(value ?? '').replaceAll('"','""')}"`;
const labelsPath = path.join(root,'qq-channel-labels.json');
const labels = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath,'utf8')) : {};
const kindOf = message => message?.body_kind || (message?.body_raw?.trim().toLowerCase() === 'no text'
  ? JSON.parse(message.attachments_json).length === 1 ? 'single_image' : 'missing_image'
  : JSON.parse(message?.attachments_json || '[]').length ? 'text_and_image' : 'text_only');
const displayBody = message => kindOf(message) === 'single_image' ? '（单图消息，无文字正文）'
  : kindOf(message) === 'images_only' ? '（纯图片消息，无文字正文）'
  : kindOf(message) === 'missing_image' ? '（采集异常：no text，但未采到图片）'
  : message?.body_raw || '（空）';
const headers = ['replay_request_id','linkage','channel_id','channel_name','discord_message_id',
  'discord_time_beijing','captured_at','discord_url','body_kind','display_body','body_raw','attachment_count',
  'qq_text_status','qq_image_status','qq_text_message_ids','qq_image_message_ids','errors','manual_signal_review','manual_notes'];
const rows = ids.map(id => {
  const message = messages.get(id);
  const parts = attempts.filter(row => row.source_message_id === id);
  const ofType = type => parts.filter(row => row.part_type === type);
  const status = type => ofType(type).map(row => row.status).join(';');
  const platformIds = type => ofType(type).map(row => row.platform_message_id).filter(Boolean).join(';');
  return [requestId,'reconstructed-from-attempt-time-window',request.channel_id,labels[request.channel_id] || '',id,
    beijing(message?.source_timestamp),message?.captured_at,message?.message_url,kindOf(message),displayBody(message),message?.body_raw,
    message ? JSON.parse(message.attachments_json).length : '',
    status('text'),status('image'),platformIds('text'),platformIds('image'),
    parts.map(row => row.error).filter(Boolean).join(';'),'',''];
}).sort((a,b) => String(a[5]).localeCompare(String(b[5])));
const output = path.join(root,`qq-replay-${requestId}-report.csv`);
fs.writeFileSync(output,[headers,...rows].map(row => row.map(csv).join(',')).join('\r\n') + '\r\n','utf8');
console.log(`Wrote ${rows.length} rows to ${output}. Linkage is reconstructed from the request time window, not a frozen original selection.`);
const ordered = [...ids].sort((a,b) => Date.parse(messages.get(a)?.source_timestamp || 0) - Date.parse(messages.get(b)?.source_timestamp || 0));
const markdown = [
  `# 颜驰频道历史补发核对稿（批次 ${requestId}）`,
  '',
  `按 Discord 原始时间从旧到新排列，共 ${ordered.length} 条。QQ 接口状态“accepted”仅代表接口接受，手机端逐条收到仍需人工核对。`,
  '',
  `旧批次的消息关联依据补发请求时间窗口重建；原文、原图和原始时间来自本地 SQLite。正文为 \`no text\` 且只有一张原图时，按“单图消息，无文字正文”展示，原始值仍保留。`,
  '',
];
for (const [index,id] of ordered.entries()) {
  const message = messages.get(id);
  const parts = attempts.filter(item => item.source_message_id === id);
  const textStatus = parts.filter(item => item.part_type === 'text').map(item => item.status).join(', ') || '无';
  const imageStatus = parts.filter(item => item.part_type === 'image').map(item => item.status).join(', ') || '无';
  markdown.push(`## ${String(index + 1).padStart(2,'0')} · ${beijing(message?.source_timestamp) || '时间未知'} · ${labels[request.channel_id] || request.channel_id}`,
    '',
    `- 作者（网页采集）：${message?.author_display || '未知'}`,
    `- [Discord 原消息](${message?.message_url || '#'}) · ID ${id}`,
    `- 本机入库：${beijing(message?.captured_at) || '未知'} 北京时间`,
    `- QQ 接口：文字 ${textStatus}；图片 ${imageStatus}`,
    `- 消息类型：${kindOf(message)}`,
    `- 人工信号判定：待核对`,
    '',
    '**可读内容**',
    '',
    '~~~text',
    displayBody(message),
    '~~~',
    '');
  if (message?.body_raw?.trim().toLowerCase() === 'no text') markdown.push('原始采集正文：`no text`（保留供核对）。', '');
  for (const [imageIndex,item] of (message?.local_images || []).entries()) {
    markdown.push(`**原图 ${imageIndex + 1}**：${item.status}${item.local_path ? ` · [打开文件](${item.local_path.replaceAll('\\','/')})` : ''}`, '');
    if (item.status === 'saved' && item.local_path && fs.existsSync(item.local_path)) {
      markdown.push(`![第 ${index + 1} 条原图 ${imageIndex + 1}](${item.local_path.replaceAll('\\','/')})`, '');
    }
  }
}
const markdownPath = path.join(root,`qq-replay-${requestId}-review.md`);
fs.writeFileSync(markdownPath,markdown.join('\n'),'utf8');
console.log(`Wrote readable review to ${markdownPath}.`);

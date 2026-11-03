/** Read-only Markdown export for the combined Discord archive. Node.js 22.5+. */
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const database = path.resolve(process.argv[2] || 'data/2026-10-30/messages.sqlite');
const output = path.resolve(process.argv[3] || path.join(path.dirname(database), 'messages-readable.md'));
const db = new DatabaseSync(database, {readOnly: true});
const hasTable = name => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', name);
const lines = ['# Discord 消息归档', '', `数据库：${path.basename(path.dirname(database))} / ${path.basename(database)}`, ''];
const localTime = value => {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
};
const clean = value => String(value ?? '').replace(/\r\n/g, '\n').trim();
const originalLink = value => {
  const url = new URL(value);
  url.hostname = 'cdn.discordapp.com';
  for (const key of [...url.searchParams.keys()]) {
    if (!['ex', 'is', 'hm'].includes(key)) url.searchParams.delete(key);
  }
  return url.href;
};
try {
  if (hasTable('discord_web_messages')) {
    const rawRows = db.prepare(`SELECT channel_id,source_message_id,channel_name,author_display,displayed_time,
      source_timestamp,captured_at,body_raw,attachments_json,message_url
      FROM discord_web_messages WHERE source_message_id<>'456' ORDER BY captured_at,id`).all();
    const best = new Map();
    const isImage = item => /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\//.test(item.source_url || '');
    const score = row => (clean(row.author_display) ? 10 : 0) + clean(row.body_raw).length +
      JSON.parse(row.attachments_json || '[]').filter(isImage).length * 10;
    for (const row of rawRows) {
      const key = `${row.channel_id}:${row.source_message_id}:${row.body_raw}`;
      if (!best.has(key) || score(row) > score(best.get(key))) best.set(key, row);
    }
    const rows = [...best.values()].sort((a, b) => BigInt(a.source_message_id) < BigInt(b.source_message_id) ? -1 : 1);
    lines.push(`## 网页直接采集的消息（${rows.length} 条）`, '',
      '正文来自 Discord 网页；图片目前保存为原图链接，尚未下载或 OCR。', '');
    let previousAuthor = '';
    rows.forEach((row, i) => {
      const attachments = JSON.parse(row.attachments_json || '[]').filter(isImage);
      const time = row.source_timestamp ? localTime(row.source_timestamp) : (row.displayed_time || `采集于 ${localTime(row.captured_at)}`);
      const rawAuthor = clean(row.author_display);
      const author = rawAuthor || previousAuthor || '作者未知';
      if (rawAuthor) previousAuthor = rawAuthor;
      lines.push(`### ${i + 1}. ${author}${rawAuthor ? '' : '（沿用上一条作者）'} · ${time}`, '',
        `频道 ID：${row.channel_id}　｜　消息 ID：${row.source_message_id}`, '',
        clean(row.body_raw) || '（无文字正文）', '');
      if (attachments.length) {
        lines.push(`图片（${attachments.length}）：`, '');
        attachments.forEach((item, n) => lines.push(`${n + 1}. [查看原图 ${n + 1}](${originalLink(item.source_url)})`));
        lines.push('');
      }
      if (row.message_url) lines.push(`[打开原消息](${row.message_url})`, '');
      lines.push('---', '');
    });
  }
  if (hasTable('messages') && hasTable('captures')) {
    const rows = db.prepare(`SELECT m.id,m.channel,m.author_display,m.displayed_time,m.body_raw,
      m.review_status,c.captured_at,c.source_path FROM messages m
      JOIN captures c ON c.id=m.capture_id ORDER BY c.captured_at,m.id`).all();
    lines.push(`## 截图 OCR 中已分组的消息（${rows.length} 条）`, '',
      '这一部分由截图 OCR 分组，可能有识别错误；请对照截图确认。未分组的全部 OCR 行保存在 archive.txt。', '');
    rows.forEach((row, i) => {
      lines.push(`### ${i + 1}. ${clean(row.author_display) || '作者未知'} · ${row.displayed_time || '时间未知'}`, '',
        `频道：${clean(row.channel)}　｜　截图时间：${localTime(row.captured_at)}　｜　状态：${row.review_status}`, '',
        clean(row.body_raw) || '（无文字正文）', '',
        `截图：${row.source_path}`, '', '---', '');
    });
  }
} finally { db.close(); }
fs.writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`已导出：${output}`);

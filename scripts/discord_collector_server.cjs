require('./collector_logger.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {saveDiagnostic} = require('./collector_diagnostics.cjs');
const {createPageStatusReporter} = require('./collector_page_status.cjs');
const {captureDiagnostic} = require('./collector_capture_trace.cjs');
const {createAttachmentQueue} = require('./collector_attachment_queue.cjs');

const root = path.resolve(process.env.MUSE_DATA_DIR || path.resolve(__dirname, '..', 'data'));
const senderPort = Number(process.env.MUSE_QQ_PORT || 8766);
const {proxyForwarding} = require('./collector_forwarding_proxy.cjs');
const {collectorToken} = require('./collector_token.cjs');
fs.mkdirSync(root, {recursive: true});
const tokenPath = path.join(root, 'collector-token.txt');
const token = collectorToken(tokenPath);
const attachmentQueue = createAttachmentQueue({root,onEvent:saveDiagnostic});
const connectedChannels = new Set();
const collectorHealth = {role:'discord-collector',started_at:new Date().toISOString(),last_capture_at:null,received:0};
const labelFile = path.join(root,'qq-channel-labels.json');
const pageStatusReporter = createPageStatusReporter({
  labels:fs.existsSync(labelFile) ? JSON.parse(fs.readFileSync(labelFile,'utf8')) : {},
  saveDiagnostic
});
function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
}
class CaptureValidationError extends Error {}
function save(message) {
  if (!message || message.source !== 'discord_web' || !/^\d+$/.test(String(message.channel_id)) || !/^\d+$/.test(String(message.source_message_id))) throw new CaptureValidationError('invalid message identity');
  if (typeof message.body_raw !== 'string' || message.body_raw.length > 100000 || !Array.isArray(message.attachments) || message.attachments.length > 100) throw new CaptureValidationError('invalid message content');
  if (message.source_timestamp) {
    const sourceTime = Date.parse(message.source_timestamp);
    const snowflakeTime = Number((BigInt(message.source_message_id) >> 22n) + 1420070400000n);
    if (!Number.isFinite(sourceTime) || Math.abs(sourceTime - snowflakeTime) > 60_000) {
      throw new CaptureValidationError('Discord message ID and timestamp do not match');
    }
  }
  const archiveDate = shanghaiDate();
  const folder = path.join(root, archiveDate);
  fs.mkdirSync(folder, {recursive: true});
  const db = new DatabaseSync(path.join(folder, 'messages.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`CREATE TABLE IF NOT EXISTS discord_web_messages (
      id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      guild_id TEXT, channel_name TEXT, message_url TEXT, author_display TEXT,
      displayed_time TEXT, source_timestamp TEXT, captured_at TEXT NOT NULL,
      body_raw TEXT NOT NULL, attachments_json TEXT NOT NULL, payload_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL, body_kind TEXT,
      UNIQUE(channel_id, source_message_id, content_sha256));
      CREATE TABLE IF NOT EXISTS discord_web_observations (
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, observed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_discord_web_source ON discord_web_messages(channel_id, source_message_id);
      CREATE TABLE IF NOT EXISTS discord_web_attachment_files (
        id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, source_url TEXT NOT NULL,
        local_path TEXT, sha256 TEXT, status TEXT NOT NULL, error TEXT,
        updated_at TEXT NOT NULL, UNIQUE(message_id,source_url));
      CREATE TABLE IF NOT EXISTS discord_web_author_updates (
        id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, previous_author TEXT,
        new_author TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    if (!db.prepare('PRAGMA table_info(discord_web_messages)').all().some(column => column.name === 'body_kind')) {
      db.exec('ALTER TABLE discord_web_messages ADD COLUMN body_kind TEXT');
      db.exec(`UPDATE discord_web_messages SET body_kind = CASE
        WHEN lower(trim(body_raw))='no text' AND json_array_length(attachments_json)=1 THEN 'single_image'
        WHEN lower(trim(body_raw))='no text' AND json_array_length(attachments_json)>1 THEN 'images_only'
        WHEN lower(trim(body_raw))='no text' THEN 'missing_image'
        WHEN json_array_length(attachments_json)>0 THEN 'text_and_image' ELSE 'text_only' END`);
    }
    const bodyKind = !message.body_raw.trim() || message.body_raw.trim().toLowerCase() === 'no text'
      ? message.attachments.length === 1 ? 'single_image' : message.attachments.length > 1 ? 'images_only' : 'missing_image'
      : message.attachments.length ? 'text_and_image' : 'text_only';
    const digest = crypto.createHash('sha256').update(JSON.stringify([message.body_raw, message.attachments])).digest('hex');
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    const fields = ['channel_id','source_message_id','guild_id','channel_name','message_url','author_display','displayed_time','source_timestamp'];
    db.prepare(`INSERT OR IGNORE INTO discord_web_messages (${fields.join(',')},captured_at,body_raw,attachments_json,payload_json,content_sha256,body_kind) VALUES (${Array(14).fill('?').join(',')})`).run(...fields.map(f => message[f] ?? null), now, message.body_raw, JSON.stringify(message.attachments), JSON.stringify(message), digest, bodyKind);
    const row = db.prepare('SELECT id,author_display FROM discord_web_messages WHERE channel_id=? AND source_message_id=? AND content_sha256=?').get(String(message.channel_id), String(message.source_message_id), digest);
    const correctedAuthor = String(message.author_display || '').trim();
    if (correctedAuthor && !String(row.author_display || '').trim()) {
      db.prepare('INSERT INTO discord_web_author_updates(message_id,previous_author,new_author,source,updated_at) VALUES (?,?,?,?,?)')
        .run(row.id,row.author_display,correctedAuthor,String(message.author_source || 'later_observation'),now);
      db.prepare('UPDATE discord_web_messages SET author_display=? WHERE id=?').run(correctedAuthor,row.id);
    }
    db.prepare('INSERT INTO discord_web_observations(message_id,observed_at) VALUES (?,?)').run(row.id, now);
    attachmentQueue.enqueue(db,archiveDate,row.id,message);
    db.exec('COMMIT');
    return row.id;
  } finally { db.close(); }
}
function lookupMinute(channelId, localMinute) {
  if (!/^\d+$/.test(channelId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localMinute)) throw Error('invalid lookup');
  const startMs = Date.parse(`${localMinute}:00+08:00`);
  if (!Number.isFinite(startMs) || new Date(startMs).toLocaleString('sv-SE', {timeZone:'Asia/Shanghai'}).slice(0, 16).replace(' ', 'T') !== localMinute) throw Error('invalid time');
  const start = new Date(startMs).toISOString();
  const end = new Date(startMs + 60000).toISOString();
  const byId = new Map();
  for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const file = path.join(root, entry.name, 'messages.sqlite');
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, {readOnly:true});
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const rows = db.prepare(`SELECT id,source_message_id,source_timestamp,captured_at,author_display,body_raw,body_kind,attachments_json
        FROM discord_web_messages WHERE channel_id=? AND source_timestamp>=? AND source_timestamp<?`).all(channelId, start, end);
      for (const row of rows) {
        const previous = byId.get(row.source_message_id);
        if (previous && previous.captured_at >= row.captured_at) continue;
        const files = db.prepare('SELECT status,error FROM discord_web_attachment_files WHERE message_id=?').all(row.id);
        byId.set(row.source_message_id, {
          message_id:row.source_message_id, source_timestamp:row.source_timestamp,
          captured_at:row.captured_at, author:row.author_display,
          excerpt:row.body_raw.slice(0, 100), body_kind:row.body_kind,
          image_count:JSON.parse(row.attachments_json).length,
          images_saved:files.filter(item => item.status === 'saved').length,
          image_errors:files.filter(item => item.status === 'failed').map(item => item.error || '保存失败')
        });
      }
    } finally { db.close(); }
  }
  return [...byId.values()].sort((a,b) => a.source_timestamp.localeCompare(b.source_timestamp));
}
function authorized(req) {
  const provided = Buffer.from(req.headers['x-collector-token'] || '');
  const expected = Buffer.from(token);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
let delayedRecoveryDiagnostics = 0;
const server = http.createServer((req, res) => {
  const reply = (status, value) => {res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(value));};
  if (req.method === 'GET' && req.url === '/v1/health') {
    if (!authorized(req)) return reply(401,{error:'unauthorized'});
    return reply(200,{...collectorHealth,at:new Date().toISOString()});
  }
  if (req.method === 'POST' && req.url === '/v1/collector/page-status') {
    if (!authorized(req)) return reply(401,{error:'unauthorized'});
    (async () => {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) throw Error('page status request too large');
        chunks.push(chunk);
      }
      return reply(200,pageStatusReporter.report(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    })().catch(error => reply(400,{error:error.message}));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/collector/diagnostic') {
    if (!authorized(req)) return reply(401,{error:'unauthorized'});
    (async () => {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) throw Error('diagnostic request too large');
        chunks.push(chunk);
      }
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = saveDiagnostic(event);
      if (result.saved && /^RECOVERY_(?:STARTED|RETRY_REQUESTED|ATTEMPT_TIMEOUT|RELOAD_FAILED|SCAN_RESTORED)$/.test(event.code)) {
        if (Date.now() - event.at > 2 * 60_000) {
          delayedRecoveryDiagnostics++;
          if (delayedRecoveryDiagnostics === 1 || delayedRecoveryDiagnostics % 100 === 0)
            console.log(`补记旧 Discord 自恢复诊断 ${delayedRecoveryDiagnostics} 条；最新事件时间 ${new Date(event.at).toISOString()}，详情已保存到诊断数据库。`);
        } else {
          console.log(`Discord 自恢复事件：${event.code}，频道 ${event.channel_id}，第 ${event.attempt || 0} 次，` +
            `事件时间 ${new Date(event.at).toISOString()}，连续失败 ${Number(event.detail?.failed_attempts || 0)} 次。`);
        }
      }
      reply(200,result);
    })().catch(error => reply(400,{error:error.message}));
    return;
  }
  if (req.url === '/v1/collector/recovery-alert' || req.url?.startsWith('/v1/forwarding/') || req.url?.startsWith('/v1/recovery/')) {
    if (!authorized(req)) return reply(401,{error:'unauthorized'});
    proxyForwarding(req,res,senderPort,token);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/messages/status?')) {
    if (!authorized(req)) return reply(401, {error:'unauthorized'});
    try {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      return reply(200, {messages:lookupMinute(query.get('channel_id') || '', query.get('local_minute') || '')});
    } catch (error) { return reply(400, {error:error.message}); }
  }
  if (req.method !== 'POST' || req.url !== '/v1/messages') return reply(404, {error:'not found'});
  if (!authorized(req)) return reply(401, {error:'unauthorized'});
  const receivedAt = Date.now();
  let bytes = 0, chunks = [];
  req.on('data', chunk => {bytes += chunk.length; if (bytes > 1_000_000) req.destroy(); else chunks.push(chunk);});
  req.on('end', () => {
    try {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = save(message);
      collectorHealth.last_capture_at = new Date().toISOString();
      collectorHealth.received++;
      try {
        const diagnostic = captureDiagnostic(message,receivedAt,Date.now(),crypto.randomUUID());
        if (diagnostic) saveDiagnostic(diagnostic);
      } catch (error) { console.warn('Capture timing diagnostic:',error.message); }
      if (!connectedChannels.has(message.channel_id)) {
        connectedChannels.add(message.channel_id);
        console.log(`频道 ${String(message.channel_name || message.channel_id).slice(0,40)}：采集服务已收到扩展消息；页面在线状态以扩展巡检为准。`);
      }
      reply(200, {id});
      attachmentQueue.wake();
    }
    catch (error) {
      if (error instanceof CaptureValidationError || error instanceof SyntaxError) {
        reply(400,{error:String(error.message)});
      } else {
        console.error('Capture storage failed:',error.code || error.name);
        reply(503,{error:'Capture storage unavailable; retry this message'});
      }
    }
  });
});
function backfillToday() {
  const date = shanghaiDate();
  const file = path.join(root, date, 'messages.sqlite');
  if (!fs.existsSync(file)) return;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const rows = db.prepare('SELECT id,payload_json FROM discord_web_messages WHERE attachments_json<>?').all('[]');
    db.exec('BEGIN IMMEDIATE');
    for (const row of rows) attachmentQueue.enqueue(db,date,row.id,JSON.parse(row.payload_json));
    db.exec('COMMIT');
  } finally { db.close(); }
}
if (require.main === module) server.listen(Number(process.env.MUSE_COLLECTOR_PORT || 8765), '127.0.0.1', () => {
  console.log(`Discord collector server listening on http://127.0.0.1:${server.address().port}`);
  setTimeout(() => pageStatusReporter.warnIfNoReport(),90_000).unref();
  try { backfillToday(); }
  catch (error) { console.error('Attachment queue backfill:', error.message); }
  attachmentQueue.start();
});
module.exports = {save, server, lookupMinute};

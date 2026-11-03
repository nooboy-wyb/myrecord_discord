require('./collector_logger.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {saveDiagnostic,recoveryAlertAlreadyHandled} = require('./collector_diagnostics.cjs');

const root = path.resolve(__dirname, '..', 'data');
fs.mkdirSync(root, {recursive: true});
const tokenPath = path.join(root, 'collector-token.txt');
if (!fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, crypto.randomBytes(32).toString('base64url'));
const token = fs.readFileSync(tokenPath, 'utf8').trim();
const imageHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
}
function save(message) {
  if (!message || message.source !== 'discord_web' || !/^\d+$/.test(String(message.channel_id)) || !/^\d+$/.test(String(message.source_message_id))) throw Error('invalid message identity');
  if (typeof message.body_raw !== 'string' || message.body_raw.length > 100000 || !Array.isArray(message.attachments) || message.attachments.length > 100) throw Error('invalid message content');
  if (message.source_timestamp) {
    const sourceTime = Date.parse(message.source_timestamp);
    const snowflakeTime = Number((BigInt(message.source_message_id) >> 22n) + 1420070400000n);
    if (!Number.isFinite(sourceTime) || Math.abs(sourceTime - snowflakeTime) > 60_000) {
      throw Error('Discord message ID and timestamp do not match');
    }
  }
  const folder = path.join(root, shanghaiDate());
  fs.mkdirSync(folder, {recursive: true});
  const db = new DatabaseSync(path.join(folder, 'messages.sqlite'));
  try {
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
    return row.id;
  } finally { db.close(); }
}
async function downloadAttachments(message, messageId) {
  function originalAttachmentUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !imageHosts.has(url.hostname)) return null;
    if (url.pathname.startsWith('/attachments/')) {
      url.hostname = 'cdn.discordapp.com';
      for (const key of [...url.searchParams.keys()]) {
        if (!['ex', 'is', 'hm'].includes(key)) url.searchParams.delete(key);
      }
      url.search = url.searchParams.toString();
    } else if (!(url.hostname === 'media.discordapp.net' && url.pathname.startsWith('/external/'))) {
      return null;
    }
    url.hash = '';
    return url.href;
  }
  const items = message.attachments.filter(item => {
    try {
      return !!originalAttachmentUrl(item.source_url);
    } catch { return false; }
  });
  if (!items.length) return;
  const folder = path.join(root, shanghaiDate());
  const attachmentDir = path.join(folder, 'attachments');
  fs.mkdirSync(attachmentDir, {recursive: true});
  const db = new DatabaseSync(path.join(folder, 'messages.sqlite'));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS discord_web_attachment_files (
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, source_url TEXT NOT NULL,
      local_path TEXT, sha256 TEXT, status TEXT NOT NULL, error TEXT,
      updated_at TEXT NOT NULL, UNIQUE(message_id,source_url));`);
    for (const item of items) {
      const existing = db.prepare('SELECT status FROM discord_web_attachment_files WHERE message_id=? AND source_url=?').get(messageId, item.source_url);
      if (existing?.status === 'saved') continue;
      let status = 'failed', localPath = null, digest = null, error = null;
      try {
        const response = await fetch(originalAttachmentUrl(item.source_url), {signal: AbortSignal.timeout(15000)});
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const length = Number(response.headers.get('content-length') || 0);
        if (length > 20_000_000) throw Error('image too large');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 20_000_000) throw Error('image too large');
        digest = crypto.createHash('sha256').update(bytes).digest('hex');
        const ext = path.extname(new URL(item.source_url).pathname).toLowerCase();
        const safeExt = ['.png','.jpg','.jpeg','.webp','.gif'].includes(ext) ? ext : '.bin';
        localPath = path.join(attachmentDir, digest + safeExt);
        if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, bytes);
        status = 'saved';
      } catch (cause) { error = [cause.message, cause.cause?.code, cause.cause?.message].filter(Boolean).join(' | '); }
      db.prepare(`INSERT INTO discord_web_attachment_files
        (message_id,source_url,local_path,sha256,status,error,updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(message_id,source_url) DO UPDATE SET local_path=excluded.local_path,
        sha256=excluded.sha256,status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`)
        .run(messageId, item.source_url, localPath, digest, status, error, new Date().toISOString());
    }
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
let forwarder = null;
const recoveryNoticeAt = new Map();
const server = http.createServer((req, res) => {
  const reply = (status, value) => {res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(value));};
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
        console.log(`Discord 自恢复事件：${event.code}，频道 ${event.channel_id}，第 ${event.attempt || 0} 次，` +
          `事件时间 ${new Date(event.at).toISOString()}，连续失败 ${Number(event.detail?.failed_attempts || 0)} 次。`);
      }
      reply(200,result);
    })().catch(error => reply(400,{error:error.message}));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/collector/recovery-alert') {
    if (!authorized(req)) return reply(401,{error:'unauthorized'});
    if (!forwarder) return reply(503,{error:'QQ 告警服务未启动'});
    (async () => {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) throw Error('请求过大');
        chunks.push(chunk);
      }
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!/^\d{15,22}$/.test(event.channelId || '') ||
          !['recovered','timeout','failed','test_refreshed','test_failed'].includes(event.status) ||
          !Number.isSafeInteger(event.requestedAt) || event.requestedAt <= 0 ||
          !Number.isInteger(event.attempt) || event.attempt < 1 || event.attempt > 100) throw Error('恢复事件无效');
      const labelFile = path.join(root,'qq-channel-labels.json');
      const labels = fs.existsSync(labelFile) ? JSON.parse(fs.readFileSync(labelFile,'utf8')) : {};
      const label = labels[event.channelId] || event.channelId;
      const description = {recovered:'自动恢复成功，已重新识别到消息',
        timeout:'自动恢复连续两次未成功：仍未重新识别到消息，请人工检查；扩展仍会继续重试',
        failed:'自动恢复连续两次未成功：标签页重载失败，请人工检查；扩展仍会继续重试',
        test_refreshed:'频道页已完成重载；这不代表出现了新消息',
        test_failed:'频道页重载失败，请检查扩展弹窗'}[event.status];
      const isTest = event.status.startsWith('test_');
      const noticeType = event.status === 'recovered' ? 'recovered' : 'needs_attention';
      const noticeKey = `${event.channelId}:${noticeType}`;
      const now = Date.now();
      const logAlert = (code,error = '') => {
        try {
          saveDiagnostic({event_id:crypto.randomUUID(),at:Date.now(),code,
            channel_id:event.channelId,incident_at:event.requestedAt,attempt:event.attempt,
            error,detail:{status:event.status}});
        } catch (logError) { console.warn('Collector alert diagnostic:',logError.message); }
      };
      if (!isTest && (recoveryAlertAlreadyHandled(event)
        || now - Number(recoveryNoticeAt.get(noticeKey) || 0) < 40 * 60_000)) {
        logAlert('ALERT_SUPPRESSED');
        return reply(200,{ok:true,suppressed:true});
      }
      const key = `discord-recovery:${event.channelId}:${event.requestedAt}:${event.status}`;
      let accepted;
      try {
        accepted = await require('./qq/core/alerts.cjs').notify(key,
          `${isTest ? '【Discord 巡检测试】' : '【Discord 采集自恢复】'}${label}${isTest ? '' : `（第 ${event.attempt} 次）`}：${description}。`);
      } catch (error) {
        logAlert('ALERT_SEND_FAILED',String(error));
        throw error;
      }
      logAlert(accepted ? 'ALERT_ACCEPTED' : 'ALERT_SEND_FAILED',
        accepted ? '' : 'QQ 告警接口未接受');
      if (accepted && !isTest) recoveryNoticeAt.set(noticeKey,now);
      reply(accepted ? 200 : 503,{ok:accepted});
    })().catch(error => reply(400,{error:error.message}));
    return;
  }
  if (req.url?.startsWith('/v1/forwarding/')) {
    if (!authorized(req)) return reply(401,{error:'unauthorized'});
    if (!forwarder) return reply(503,{error:'QQ 转发服务未启动'});
    try {
      const url = new URL(req.url,'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/forwarding/status') {
        return reply(200,forwarder.forwardingStatus(url.searchParams.get('channel_id')));
      }
      if (req.method === 'POST' && url.pathname === '/v1/forwarding/pause') {
        (async () => {
          try {
            let bytes = 0;
            const chunks = [];
            for await (const chunk of req) {
              bytes += chunk.length;
              if (bytes > 4096) throw Error('请求过大');
              chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            reply(200,forwarder.setForwardingPaused(body.channel_id,body.paused));
          } catch (error) { reply(400,{error:error.message}); }
        })();
        return;
      }
      return reply(404,{error:'not found'});
    } catch (error) { return reply(400,{error:error.message}); }
  }
  if (req.url?.startsWith('/v1/recovery/')) {
    if (!authorized(req)) return reply(401,{error:'unauthorized'});
    if (!forwarder) return reply(503,{error:'QQ 转发服务未启动'});
    try {
      const url = new URL(req.url,'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/recovery/preview') {
        return reply(200,forwarder.recoveryCandidates(url.searchParams.get('channel_id') || '',
          url.searchParams.get('group') || '1',Number(url.searchParams.get('limit') || 20)));
      }
      if (req.method === 'GET' && url.pathname === '/v1/recovery/status') {
        return reply(200,forwarder.recoveryStatus(Number(url.searchParams.get('request_id'))));
      }
      if (req.method === 'POST' && ['/v1/recovery/queue','/v1/recovery/cancel'].includes(url.pathname)) {
        (async () => {
          try {
            let bytes = 0;
            const chunks = [];
            for await (const chunk of req) {
              bytes += chunk.length;
              if (bytes > 32768) throw Error('请求过大');
              chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const result = url.pathname === '/v1/recovery/queue'
              ? forwarder.queueRecovery(body.channel_id,body.group,body.selected)
              : forwarder.cancelRecovery(body.channel_id,body.group);
            reply(200,result);
          } catch (error) { reply(400,{error:error.message}); }
        })();
        return;
      }
      return reply(404,{error:'not found'});
    } catch (error) { return reply(400,{error:error.message}); }
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
  let bytes = 0, chunks = [];
  req.on('data', chunk => {bytes += chunk.length; if (bytes > 1_000_000) req.destroy(); else chunks.push(chunk);});
  req.on('end', async () => {
    try {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = save(message);
      await downloadAttachments(message, id);
      reply(200, {id});
    }
    catch (error) { reply(400, {error:String(error.message)}); }
  });
});
async function backfillToday() {
  const file = path.join(root, shanghaiDate(), 'messages.sqlite');
  if (!fs.existsSync(file)) return;
  const db = new DatabaseSync(file, {readOnly: true});
  let rows;
  try { rows = db.prepare('SELECT id,payload_json FROM discord_web_messages WHERE attachments_json<>?').all('[]'); }
  catch { return; }
  finally { db.close(); }
  for (const row of rows) {
    try { await downloadAttachments(JSON.parse(row.payload_json), row.id); }
    catch (error) { console.error('Attachment backfill:', error.message); }
  }
}
if (require.main === module) server.listen(8765, '127.0.0.1', () => {
  console.log(`Discord collector server v0.2.5 listening on http://127.0.0.1:8765 ; token: ${tokenPath}`);
  backfillToday().catch(error => console.error('Backfill:', error.message));
  if (process.env.QQ_FORWARD_ENABLED === '1') {
    try {
      forwarder = require('./qq/core/forwarder.cjs');
      forwarder.start();
      require('./qq/core/gateway.cjs').startGateway(forwarder.setOnline);
    } catch (error) { console.error(`QQ 转发启动失败：${error.message}`); }
  }
});
module.exports = {save, server, lookupMinute};

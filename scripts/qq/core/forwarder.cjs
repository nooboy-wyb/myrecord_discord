const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {saveDiagnostic} = require('../../collector_diagnostics.cjs');
const yanchi = require('../../qq_channels/yanchi/index.cjs');
const fengxun = require('../../qq_channels/fengxun/index.cjs');
const liuyudong = require('../../qq_channels/liuyudong/index.cjs');
const {createManualRecovery} = require('./manual_recovery.cjs');
const {decorateChannelLabel} = require('./channel_title_style.cjs');
const alerts = require('./alerts.cjs');
const exchangeChannelId = '1265882617530814535';
const additionalChannelIds = new Set([...yanchi.channelIds, fengxun.channelId, exchangeChannelId]);

const root = path.resolve(__dirname, '..', '..', '..', 'data');
const target = JSON.parse(fs.readFileSync(path.join(root, 'qq-group-openid.json'), 'utf8'));
const additionalRoutesFile = path.join(root, 'qq-additional-routes.json');
const controlsFile = path.join(root, 'qq-forward-controls.json');
const secret = process.env.QQ_BOT_APP_SECRET;
const labelFile = path.join(root, 'qq-channel-labels.json');
let labelCache = {stamp:'', data:{}};
function channelLabels() {
  try {
    const stat = fs.statSync(labelFile);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp !== labelCache.stamp) {
      labelCache = {stamp, data:JSON.parse(fs.readFileSync(labelFile, 'utf8'))};
    }
  } catch {}
  return labelCache.data;
}
const state = new DatabaseSync(path.join(root, 'qq-forward.sqlite'));
state.exec(`CREATE TABLE IF NOT EXISTS forward_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replay_requests (
  id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, message_limit INTEGER NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS forward_attempts (
  task_key TEXT NOT NULL, part_index INTEGER NOT NULL, part_type TEXT NOT NULL,
  source_message_id TEXT NOT NULL, group_openid TEXT NOT NULL,
  status TEXT NOT NULL, attempted_at TEXT NOT NULL,
  http_status INTEGER, platform_code TEXT, platform_message_id TEXT, error TEXT,
  PRIMARY KEY (task_key, part_index));`);
for (const [name, type] of [['channel_id','TEXT'],['source_timestamp','TEXT'],['origin','TEXT'],['replay_request_id','INTEGER']]) {
  if (!state.prepare('PRAGMA table_info(forward_attempts)').all().some(column => column.name === name)) {
    state.exec(`ALTER TABLE forward_attempts ADD COLUMN ${name} ${type}`);
  }
}
state.exec(`CREATE TABLE IF NOT EXISTS replay_items (
  request_id INTEGER NOT NULL, source_message_id TEXT NOT NULL, content_sha256 TEXT NOT NULL,
  channel_id TEXT NOT NULL, source_timestamp TEXT, status TEXT NOT NULL,
  PRIMARY KEY (request_id,source_message_id));`);
for (const [name, type] of [['group_openid','TEXT'],['mode','TEXT']]) {
  if (!state.prepare('PRAGMA table_info(replay_requests)').all().some(column => column.name === name)) {
    state.exec(`ALTER TABLE replay_requests ADD COLUMN ${name} ${type}`);
  }
}
fengxun.initialize(state);
yanchi.initialize(state);
let paused = false;
const pausedGroups = new Set();
const lastMessageAttemptAt = new Map();
const groupCooldownUntil = new Map();
const messageSpacingMs = 4000;
const rateLimitCooldownMs = 2 * 60_000;
let running = false;
let online = false;
let accessToken = null;
let tokenExpiresAt = 0;
const reportedUnconfirmed = new Set();
function pauseGroup(groupOpenid) {
  if (groupOpenid === target.group_openid) paused = true;
  else pausedGroups.add(groupOpenid);
}

function splitText(value, size = 1500) {
  const chars = [...value];
  const result = [];
  for (let i = 0; i < chars.length; i += size) result.push(chars.slice(i, i + size).join(''));
  return result;
}
function buildParts(channelId, heading, displayBody, images) {
  const chunks = splitText(displayBody, 1400);
  if (channelId === liuyudong.channelId && images.length) {
    return [
      {type:'image',sourceUrl:images[0].source_url,content:chunks.length ? `${heading}\n${chunks[0]}` : heading},
      ...chunks.slice(1).map(content => ({type:'text',content})),
      ...images.slice(1).map((item, index) => ({type:'image',sourceUrl:item.source_url,
        content:`图 ${index + 2}/${images.length}`})),
    ];
  }
  return [
    ...(chunks.length ? chunks.map((content, index) => ({type:'text',content:index === 0 ? `${heading}\n${content}` : content}))
      : images.length ? [{type:'text',content:heading}] : []),
    ...images.map(item => ({type:'image',sourceUrl:item.source_url,content:' '})),
  ];
}
async function token() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  const response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({appId: target.app_id, clientSecret: secret}),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || body.code || !body.access_token) throw Error(`QQ token: HTTP ${response.status}, code ${body.code ?? 'unknown'}`);
  accessToken = body.access_token;
  tokenExpiresAt = Date.now() + Math.max(0, Number(body.expires_in || 7200) - 120) * 1000;
  return accessToken;
}
async function post(endpoint, payload, groupOpenid = target.group_openid) {
  const accessToken = await token();
  if (endpoint === 'messages') {
    const wait = Math.max(0,Number(lastMessageAttemptAt.get(groupOpenid) || 0) + messageSpacingMs - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve,wait));
    lastMessageAttemptAt.set(groupOpenid,Date.now());
  }
  const response = await fetch(`https://api.bot.qq.com/v2/groups/${encodeURIComponent(groupOpenid)}/${endpoint}`, {
    method: 'POST',
    headers: {authorization: `QQBot ${accessToken}`, 'content-type': 'application/json; charset=utf-8'},
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok || body.err_code || body.code) {
    const error = Error(`QQ ${endpoint}: HTTP ${response.status}, code ${body.err_code ?? body.code ?? 'unknown'}, trace ${body.trace_id ?? 'none'}`);
    error.httpStatus = response.status;
    error.platformCode = String(body.err_code ?? body.code ?? 'unknown');
    throw error;
  }
  return body;
}
function sourceFiles() {
  return fs.readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map(entry => path.join(root, entry.name, 'messages.sqlite'))
    .filter(file => fs.existsSync(file)).sort();
}
function additionalTargets() {
  if (!fs.existsSync(additionalRoutesFile)) return [];
  const routes = JSON.parse(fs.readFileSync(additionalRoutesFile, 'utf8')).routes || [];
  return routes.filter(route => /^[A-Za-z0-9]+$/.test(route.group_openid || '')
    && route.group_openid !== target.group_openid
    && Array.isArray(route.channel_ids)
    && route.channel_ids.length > 0
    && route.channel_ids.every(id => additionalChannelIds.has(id))
    && new Set(route.channel_ids).size === route.channel_ids.length
    && Number.isFinite(Date.parse(route.enabled_at || '')));
}
function primaryControl() {
  return fs.existsSync(controlsFile) ? JSON.parse(fs.readFileSync(controlsFile, 'utf8')) : {primary_enabled:true};
}
function channelPaused(channelId) {
  return primaryControl().paused_channels?.[channelId] === true;
}
function forwardingStatus(channelId) {
  if (!/^\d{15,22}$/.test(channelId || '')) throw Error('频道 ID 无效');
  const label = channelLabels()[channelId] || `频道 ${channelId}`;
  return {channel_id:channelId,label,paused:channelPaused(channelId)};
}
function setForwardingPaused(channelId, value) {
  forwardingStatus(channelId);
  if (typeof value !== 'boolean') throw Error('暂停状态无效');
  const controls = primaryControl();
  controls.paused_channels = {...controls.paused_channels,[channelId]:value};
  fs.writeFileSync(controlsFile, JSON.stringify(controls,null,2));
  console.log(`Discord 频道 ${channelId} 自动转发已${value ? '暂停' : '恢复'}。`);
  return forwardingStatus(channelId);
}
function primaryAcceptsMessage(control, message) {
  if (control.primary_enabled === false) return false;
  if (control.paused_channels?.[message.channel_id] === true) return false;
  if (additionalChannelIds.has(message.channel_id)) return false;
  const liveAfter = Date.parse(control.primary_live_after || '');
  if (Number.isFinite(liveAfter) && sourceTime(message) < liveAfter) return false;
  const channelEnabledAt = Date.parse(control.primary_channel_enabled_at?.[message.channel_id] || '');
  if (Number.isFinite(channelEnabledAt) && sourceTime(message) < channelEnabledAt) return false;
  return message.channel_id !== liuyudong.channelId
    || liuyudong.acceptsPrimary(control, message, sourceTime);
}
function routeAcceptsMessage(route, message) {
  return additionalChannelIds.has(message.channel_id)
    && !channelPaused(message.channel_id)
    && route.channel_ids.includes(message.channel_id)
    && sourceTime(message) >= Date.parse(route.channel_enabled_at?.[message.channel_id] || route.enabled_at);
}
function sourceTime(message) {
  const explicit = Date.parse(message.source_timestamp || '');
  if (Number.isFinite(explicit)) return explicit;
  try { return Number((BigInt(message.source_message_id) >> 22n) + 1420070400000n); }
  catch { return NaN; }
}
function sourceTimeLabel(message) {
  const time = sourceTime(message);
  if (!Number.isFinite(time)) return '【时间未知】';
  const formatted = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(time));
  return `【${formatted} UTC+8】${message.source_timestamp ? '' : '（由消息 ID 推算）'}`;
}
function liveWatermark(groupOpenid, channelId) {
  const key = `live_watermark:${groupOpenid}:${channelId}`;
  const stored = state.prepare('SELECT value FROM forward_meta WHERE key=?').get(key);
  if (stored) return JSON.parse(stored.value);
  const latest = state.prepare(`SELECT source_message_id,source_timestamp FROM forward_attempts
    WHERE group_openid=? AND channel_id=? AND status='accepted' AND origin='live'
    ORDER BY source_timestamp DESC, source_message_id DESC LIMIT 1`).get(groupOpenid,channelId);
  if (!latest) return null;
  state.prepare('INSERT OR IGNORE INTO forward_meta(key,value) VALUES (?,?)').run(key,JSON.stringify(latest));
  return latest;
}
function isAfterLiveWatermark(message, watermark) {
  const publishedAt = sourceTime(message);
  if (!Number.isFinite(publishedAt)) return false;
  if (!watermark) return true;
  const previousAt = sourceTime(watermark);
  if (publishedAt !== previousAt) return publishedAt > previousAt;
  try { return BigInt(message.source_message_id) > BigInt(watermark.source_message_id); }
  catch { return false; }
}
function advanceLiveWatermark(groupOpenid, message) {
  if (!isAfterLiveWatermark(message,liveWatermark(groupOpenid,message.channel_id))) return;
  const key = `live_watermark:${groupOpenid}:${message.channel_id}`;
  const value = JSON.stringify({source_message_id:message.source_message_id,source_timestamp:message.source_timestamp});
  state.prepare(`INSERT INTO forward_meta(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key,value);
}
function liveMessageEligible(groupOpenid, message, startupFloor) {
  const watermark = liveWatermark(groupOpenid,message.channel_id);
  if ((watermark || sourceTime(message) >= startupFloor)
    && isAfterLiveWatermark(message,watermark)) return true;
  if (message.channel_id !== liuyudong.channelId || !watermark) return false;
  const publishedAt = sourceTime(message);
  const watermarkAt = sourceTime(watermark);
  const capturedAt = Date.parse(message.captured_at || '');
  const lateWindowMs = 30 * 60_000;
  if (!Number.isFinite(publishedAt) || !Number.isFinite(watermarkAt) || !Number.isFinite(capturedAt)
    || publishedAt < startupFloor || publishedAt > watermarkAt
    || watermarkAt - publishedAt > lateWindowMs || Date.now() - publishedAt > lateWindowMs
    || capturedAt - publishedAt > lateWindowMs) return false;
  return !state.prepare('SELECT 1 FROM forward_attempts WHERE group_openid=? AND channel_id=? AND source_message_id=? LIMIT 1')
    .get(groupOpenid,message.channel_id,message.source_message_id);
}
function speakerName(value) {
  const name = String(value || '').replace(/[,，]?\s*服务器标签：.*$/u, '')
    .replace(/\s*\[情报局\]$/u, '')
    .replace(/情报局(?:会员plus|机器人(?:已验证\s*)?APP(?:APP)?)$/u, '')
    .trim();
  return [...(name || '未知发言人')].slice(0, 60).join('');
}
function messageHeading(message, context = {}) {
  const label = String(channelLabels()[message.channel_id] || message.channel_name || `频道 ${message.channel_id}`).slice(0, 40);
  const history = context.imageRepairPart ? `｜补图 ${context.imageRepairPart}`
    : context.imageRepair ? '｜补图'
    : context.confirmedRetry ? '｜确认补发'
    : context.history || context.replayRequestId ? '｜历史补发' : '';
  const speaker = message.channel_id === '1265882617530814535' ? `｜${speakerName(message.author_display)}` : '';
  return `【${decorateChannelLabel(message.channel_id,label)}${history}${speaker}】\n${sourceTimeLabel(message)}`;
}
function pendingMessages() {
  const rows = [];
  const startAt = state.prepare('SELECT value FROM forward_meta WHERE key=?').get('start_at').value;
  for (const file of sourceFiles()) {
    const db = new DatabaseSync(file, {readOnly: true});
    try {
      const messages = db.prepare(`SELECT id,channel_id,channel_name,author_display,source_message_id,source_timestamp,content_sha256,body_raw,attachments_json,captured_at
        FROM discord_web_messages WHERE captured_at >= ? ORDER BY captured_at,id`).all(startAt);
      for (const message of messages) {
        if (!Number.isFinite(sourceTime(message))) continue;
        const attachments = db.prepare(`SELECT source_url,local_path,status,error FROM discord_web_attachment_files WHERE message_id=?`).all(message.id);
        rows.push({...message, attachments, file});
      }
    } finally { db.close(); }
  }
  return rows.sort((a, b) => sourceTime(a) - sourceTime(b)
    || String(a.source_message_id).localeCompare(String(b.source_message_id)));
}
function recentMessages(channelId, limit) {
  const bySourceId = new Map();
  for (const file of sourceFiles()) {
    const db = new DatabaseSync(file, {readOnly: true});
    try {
      const messages = db.prepare(`SELECT id,channel_id,channel_name,author_display,source_message_id,source_timestamp,
        content_sha256,body_raw,attachments_json,captured_at FROM discord_web_messages WHERE channel_id=?`).all(channelId);
      for (const message of messages) {
        const old = bySourceId.get(message.source_message_id);
        if (old && old.captured_at >= message.captured_at) continue;
        const attachments = db.prepare(`SELECT source_url,local_path,status,error FROM discord_web_attachment_files WHERE message_id=?`).all(message.id);
        bySourceId.set(message.source_message_id, {...message,attachments,file});
      }
    } finally { db.close(); }
  }
  return [...bySourceId.values()]
    .sort((a,b) => sourceTime(b) - sourceTime(a)).slice(0,limit)
    .sort((a,b) => sourceTime(a) - sourceTime(b));
}
function replayMessages(request) {
  let items = state.prepare('SELECT * FROM replay_items WHERE request_id=?').all(request.id);
  if (!items.length) {
    const selected = recentMessages(request.channel_id,request.message_limit);
    if (selected.length !== request.message_limit) throw Error(`历史补发需要 ${request.message_limit} 条，当前仅入库 ${selected.length} 条`);
    for (const message of selected) {
      state.prepare(`INSERT INTO replay_items(request_id,source_message_id,content_sha256,channel_id,source_timestamp,status)
        VALUES (?,?,?,?,?,'pending')`).run(request.id,message.source_message_id,message.content_sha256,message.channel_id,message.source_timestamp);
    }
    return selected;
  }
  const messages = [];
  for (const item of items) {
    let found;
    for (const file of sourceFiles()) {
      const db = new DatabaseSync(file,{readOnly:true});
      try {
        const message = db.prepare(`SELECT id,channel_id,channel_name,author_display,source_message_id,source_timestamp,
          content_sha256,body_raw,attachments_json,captured_at FROM discord_web_messages
          WHERE channel_id=? AND source_message_id=? AND content_sha256=?`).get(item.channel_id,item.source_message_id,item.content_sha256);
        if (message) {
          const attachments = db.prepare('SELECT source_url,local_path,status,error FROM discord_web_attachment_files WHERE message_id=?').all(message.id);
          if (!found || message.captured_at > found.captured_at) found = {...message,attachments,file};
        }
      } finally { db.close(); }
    }
    if (!found) throw Error(`历史补发原始记录缺失：${item.source_message_id}`);
    messages.push(found);
  }
  return messages.sort((a,b) => sourceTime(a) - sourceTime(b));
}
function record(key, index, type, message, status, detail = {}, context = {}) {
  state.prepare(`INSERT INTO forward_attempts
    (task_key,part_index,part_type,source_message_id,group_openid,status,attempted_at,http_status,platform_code,platform_message_id,error,channel_id,source_timestamp,origin,replay_request_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_key,part_index) DO UPDATE SET status=excluded.status,attempted_at=excluded.attempted_at,
    http_status=excluded.http_status,platform_code=excluded.platform_code,
    platform_message_id=excluded.platform_message_id,error=excluded.error`)
    .run(key,index,type,message.source_message_id,context.group_openid || target.group_openid,status,new Date().toISOString(),
      detail.httpStatus ?? null,detail.platformCode ?? null,detail.platformId ?? null,detail.error ?? null,
      message.channel_id,message.source_timestamp ?? null,
      context.imageRepair || context.confirmedRetry ? 'repair' : context.history || context.replayRequestId ? 'history' : 'live',
      context.replayRequestId ?? null);
}
async function processMessage(message, context = {}) {
  const groupOpenid = context.group_openid || target.group_openid;
  if (Date.now() < Number(groupCooldownUntil.get(groupOpenid) || 0)) return 'deferred';
  const isolateUnknown = groupOpenid !== target.group_openid || message.channel_id === liuyudong.channelId;
  const key = crypto.createHash('sha256').update(JSON.stringify([groupOpenid,message.channel_id,message.source_message_id,message.content_sha256])).digest('hex');
  const fengxunResult = message.channel_id === fengxun.channelId
    ? fengxun.beforeSend(state, key, message, groupOpenid, sourceTime) : null;
  if (fengxunResult?.skip) return 'skipped_duplicate';
  const fanwanResult = message.channel_id === yanchi.fanwanChannelId
    ? yanchi.beforeSend(state, key, message, groupOpenid, sourceTime) : null;
  if (fanwanResult?.skip) return 'skipped_duplicate';
  const images = message.channel_id === liuyudong.channelId
    ? liuyudong.images(message)
    : JSON.parse(message.attachments_json).filter(item => item?.source_url);
  const heading = messageHeading(message, context);
  const displayBody = context.imageRepair ? '' : yanchi.channelIds.includes(message.channel_id)
    ? yanchi.displayBody(message, images)
    : message.channel_id === liuyudong.channelId
      ? liuyudong.displayBody(message, images) : message.body_raw;
  const parts = context.imageOnlyRepair
    ? images.map(item => ({type:'image',sourceUrl:item.source_url,content:'补图'}))
    : buildParts(message.channel_id,heading,displayBody,images);
  for (const [index, part] of parts.entries()) {
    const previous = state.prepare('SELECT status,attempted_at FROM forward_attempts WHERE task_key=? AND part_index=?').get(key,index);
    if (previous?.status === 'accepted') continue;
    if (previous?.status === 'failed_preflight'
      && Date.now() - Date.parse(previous.attempted_at) < 2 * 60_000) return 'deferred';
    if (previous?.status === 'rate_limited'
      && Date.now() - Date.parse(previous.attempted_at) < rateLimitCooldownMs) {
      groupCooldownUntil.set(groupOpenid,Date.parse(previous.attempted_at) + rateLimitCooldownMs);
      return 'deferred';
    }
    if (previous && !['failed_preflight','rate_limited'].includes(previous.status)) {
      if (!isolateUnknown) pauseGroup(groupOpenid);
      console.error(isolateUnknown
        ? `Discord ${message.source_message_id} 第 ${index + 1} 段结果未知，已隔离该条，继续处理后续消息；请人工核查。`
        : `QQ 目标群 ${groupOpenid === target.group_openid ? '主群' : '附加群'} 转发已暂停：第 ${index + 1} 段存在未确认记录，请人工核查后处理。`);
      return 'unknown';
    }
    // Mark before network I/O, so an interrupted request is never automatically sent twice.
    record(key,index,part.type,message,'unknown',{},context);
    let qqRequestStarted = false;
    try {
      let payload;
      if (part.type === 'text') payload = {msg_type: 0, content: part.content};
      else {
        const attachment = message.attachments.find(item => item.source_url === part.sourceUrl);
        if (!attachment || attachment.status !== 'saved' || !attachment.local_path || !fs.existsSync(attachment.local_path)) {
          throw Error(`Original image unavailable: ${attachment?.error || 'not downloaded'}`);
        }
        const bytes = fs.readFileSync(attachment.local_path);
        if (!/\.(png|jpe?g)$/i.test(attachment.local_path)) throw Error('Original image format requires separate validation');
        if (bytes.length > 5_000_000) throw Error('Original image exceeds 5 MB direct upload limit; chunk upload is required');
        qqRequestStarted = true;
        const uploaded = await post('files', {file_type: 1,file_name: path.basename(attachment.local_path),
          file_data: bytes.toString('base64'),srv_send_msg: false},groupOpenid);
        if (!uploaded.file_info) throw Error('QQ image upload returned no file_info');
        payload = {msg_type: 7,content:part.content || ' ',media: {file_info: uploaded.file_info}};
      }
      let sent;
      try { qqRequestStarted = true; sent = await post('messages', payload, groupOpenid); }
      catch (error) {
        const canSplit = message.channel_id === liuyudong.channelId && index === 0 && part.type === 'image'
          && part.content?.trim() && error.httpStatus === 400
          && ['22006','40011000'].includes(error.platformCode);
        if (!canSplit) throw error;
        const fallbackKey = `${key}:fallback_text`;
        record(fallbackKey,0,'text',message,'unknown',{},context);
        const fallbackText = await post('messages',{msg_type:0,content:part.content},groupOpenid);
        if (!fallbackText.id) throw Error('QQ fallback text returned no message ID');
        record(fallbackKey,0,'text',message,'accepted',{platformId:fallbackText.id},context);
        sent = await post('messages',{msg_type:7,content:' ',media:payload.media},groupOpenid);
      }
      if (!sent.id) throw Error('QQ send returned no message ID');
      record(key,index,part.type,message,'accepted',{platformId: sent.id},context);
      console.log(`QQ 接受转发：Discord ${message.source_message_id}，目标群 ${groupOpenid === target.group_openid ? '主群' : '附加群'}，第 ${index + 1}/${parts.length} 段。`);
    } catch (error) {
      const preflight = !qqRequestStarted;
      const rateLimited = error.platformCode === '40034100' && error.httpStatus === 400;
      record(key,index,part.type,message,preflight ? 'failed_preflight' : rateLimited ? 'rate_limited' : 'unknown',
        {httpStatus:error.httpStatus,platformCode:error.platformCode,error:error.message},context);
      if (preflight) {
        console.warn(`QQ 图片发送前检查失败，Discord ${message.source_message_id} 第 ${index + 1} 段稍后重试：${error.message}`);
        return 'deferred';
      }
      if (rateLimited) {
        groupCooldownUntil.set(groupOpenid,Date.now() + rateLimitCooldownMs);
        try {
          saveDiagnostic({event_id:crypto.randomUUID(),at:Date.now(),code:'QQ_RATE_LIMITED',
            channel_id:message.channel_id,source_message_id:message.source_message_id,error:error.message,
            detail:{part_index:index,retry_after_ms:rateLimitCooldownMs}});
        } catch (logError) { console.warn('QQ rate limit diagnostic:',logError.message); }
        console.warn(`QQ 限频，Discord ${message.source_message_id} 第 ${index + 1} 段两分钟后重试。`);
        return 'deferred';
      }
      if (!isolateUnknown) pauseGroup(groupOpenid);
      console.error(isolateUnknown
        ? `Discord ${message.source_message_id} 第 ${index + 1} 段发送结果未知，已隔离该条，继续处理后续消息：${error.message}`
        : `QQ 目标群 ${groupOpenid === target.group_openid ? '主群' : '附加群'} 转发暂停：Discord ${message.source_message_id}，第 ${index + 1} 段：${error.message}`);
      alerts.notify(`send:${groupOpenid}:${message.source_message_id}:${index}`,
        `【QQ 转发告警】${groupOpenid === target.group_openid ? '群 1' : '附加群'}发送结果未知。Discord 消息 ${message.source_message_id}，原消息时间 ${sourceTimeLabel(message)}，第 ${index + 1} 段；${error.message}。${isolateUnknown ? '该条已隔离，其他消息继续。' : '该群已暂停转发。'}请先核对群内是否收到，勿直接重发。`);
      return 'unknown';
    }
  }
  fengxun.afterSend(state, key, message, fengxunResult);
  yanchi.afterSend(state, key, message, fanwanResult);
  return 'accepted';
}
const manualRecovery = createManualRecovery({state,target,additionalChannelIds,additionalTargets,sourceFiles,sourceTime,
  replayMessages,processMessage,isOnline:() => online,
  isPaused:groupOpenid => groupOpenid === target.group_openid ? paused : pausedGroups.has(groupOpenid),pauseGroup});
async function tick() {
  if (running || !online) return;
  running = true;
  try {
    const routes = additionalTargets();
    const control = primaryControl();
    const unconfirmedPrimary = new Set(state.prepare(`SELECT DISTINCT a.source_message_id FROM forward_attempts a
      WHERE a.group_openid=? AND a.channel_id=? AND a.status='unknown'
        AND NOT EXISTS (SELECT 1 FROM forward_attempts b
          WHERE b.group_openid=a.group_openid AND b.source_message_id=a.source_message_id
            AND b.origin='repair' AND b.status='accepted' AND b.attempted_at>a.attempted_at)`)
      .all(target.group_openid,liuyudong.channelId)
      .map(row => row.source_message_id));
    const repairedPrimary = new Set(state.prepare(`SELECT DISTINCT a.source_message_id FROM forward_attempts a
      WHERE a.group_openid=? AND a.channel_id=? AND a.status='unknown'
        AND EXISTS (SELECT 1 FROM forward_attempts b
          WHERE b.group_openid=a.group_openid AND b.source_message_id=a.source_message_id
            AND b.origin='repair' AND b.status='accepted' AND b.attempted_at>a.attempted_at)`)
      .all(target.group_openid,liuyudong.channelId)
      .map(row => row.source_message_id));
    const unresolvedAdditional = new Map(routes.map(route => [route.group_openid,
      new Set(state.prepare(`SELECT DISTINCT a.source_message_id FROM forward_attempts a
        WHERE a.group_openid=? AND a.status='unknown'
          AND NOT EXISTS (SELECT 1 FROM forward_attempts b
            WHERE b.group_openid=a.group_openid AND b.source_message_id=a.source_message_id
              AND b.origin='repair' AND b.status='accepted' AND b.attempted_at>a.attempted_at)`)
        .all(route.group_openid).map(row => row.source_message_id))]));
    const repairedAdditional = new Map(routes.map(route => [route.group_openid,
      new Set(state.prepare(`SELECT DISTINCT a.source_message_id FROM forward_attempts a
        WHERE a.group_openid=? AND a.status='unknown'
          AND EXISTS (SELECT 1 FROM forward_attempts b
            WHERE b.group_openid=a.group_openid AND b.source_message_id=a.source_message_id
              AND b.origin='repair' AND b.status='accepted' AND b.attempted_at>a.attempted_at)`)
        .all(route.group_openid).map(row => row.source_message_id))]));
    const startupFloor = Date.parse(state.prepare('SELECT value FROM forward_meta WHERE key=?').get('start_at').value) - 120000;
    for (const message of pendingMessages()) {
      if (!paused && primaryAcceptsMessage(control,message)
        && liveMessageEligible(target.group_openid,message,startupFloor)) {
        if (message.channel_id === liuyudong.channelId) {
          if (repairedPrimary.has(message.source_message_id)) continue;
          if (unconfirmedPrimary.has(message.source_message_id)) {
            if (!reportedUnconfirmed.has(message.source_message_id)) {
              reportedUnconfirmed.add(message.source_message_id);
              console.warn(`柳玉东 Discord ${message.source_message_id} 存在状态不明的 QQ 发送，已隔离该条；后续消息继续处理。`);
            }
            continue;
          }
          if (!liuyudong.readyForLive(message,sourceTime)) continue;
        }
        const outcome = await processMessage(message);
        if (outcome === 'accepted' || outcome === 'skipped_duplicate') advanceLiveWatermark(target.group_openid,message);
      }
      for (const route of routes) {
        if (pausedGroups.has(route.group_openid)) continue;
        if (!routeAcceptsMessage(route,message)
          || !liveMessageEligible(route.group_openid,message,startupFloor)) continue;
        if (unresolvedAdditional.get(route.group_openid).has(message.source_message_id)
          || repairedAdditional.get(route.group_openid).has(message.source_message_id)) continue;
        const outcome = await processMessage(message,{group_openid:route.group_openid});
        if (outcome === 'unknown') unresolvedAdditional.get(route.group_openid).add(message.source_message_id);
        if (outcome === 'accepted' || outcome === 'skipped_duplicate') advanceLiveWatermark(route.group_openid,message);
      }
    }
    if (!paused && control.primary_enabled !== false) {
      const request = state.prepare("SELECT * FROM replay_requests WHERE status='pending' AND (mode IS NULL OR mode='legacy') ORDER BY id LIMIT 1").get();
      if (request) {
        const messages = replayMessages(request);
        for (const message of messages) {
          const outcome = await processMessage(message,{replayRequestId:request.id});
          state.prepare('UPDATE replay_items SET status=? WHERE request_id=? AND source_message_id=?')
            .run(paused ? 'unknown' : outcome,request.id,message.source_message_id);
          if (paused) break;
        }
        if (!paused) {
          state.prepare("UPDATE replay_requests SET status='complete',completed_at=? WHERE id=?")
            .run(new Date().toISOString(),request.id);
          console.log(`频道 ${request.channel_id} 最近 ${request.message_limit} 条历史补发接口调用完成。`);
        }
      }
    }
    await manualRecovery.processNext();
  }
  catch (error) {
    paused = true;
    console.error(`QQ 转发暂停：${error.message}`);
    alerts.notify(`tick:${error.message}`,`【QQ 转发告警】群 1 转发暂停：${error.message}。请检查本地服务日志。`);
  }
  finally { running = false; }
}
function start() {
  if (!secret) throw Error('QQ_BOT_APP_SECRET is required');
  const preflightUnknown = state.prepare(`SELECT task_key,part_index,source_message_id,channel_id,error
    FROM forward_attempts WHERE status='unknown' AND part_type='image'
      AND error LIKE 'Original image unavailable:%'`).all();
  for (const item of preflightUnknown) {
    state.prepare("UPDATE forward_attempts SET status='failed_preflight' WHERE task_key=? AND part_index=?")
      .run(item.task_key,item.part_index);
    try {
      saveDiagnostic({event_id:crypto.randomUUID(),at:Date.now(),code:'QQ_IMAGE_PREFLIGHT_RECLASSIFIED',
        channel_id:item.channel_id,source_message_id:item.source_message_id,error:item.error,
        detail:{part_index:item.part_index}});
    } catch (error) { console.warn('QQ preflight diagnostic:',error.message); }
    console.warn(`QQ 图片发送前失败已改为可重试：Discord ${item.source_message_id} 第 ${item.part_index + 1} 段。`);
  }
  const limitedUnknown = state.prepare(`SELECT task_key,part_index,source_message_id,channel_id,error
    FROM forward_attempts WHERE status='unknown' AND http_status=400 AND platform_code='40034100'`).all();
  for (const item of limitedUnknown) {
    state.prepare("UPDATE forward_attempts SET status='rate_limited' WHERE task_key=? AND part_index=?")
      .run(item.task_key,item.part_index);
    try {
      saveDiagnostic({event_id:crypto.randomUUID(),at:Date.now(),code:'QQ_RATE_LIMIT_RECLASSIFIED',
        channel_id:item.channel_id,source_message_id:item.source_message_id,error:item.error,
        detail:{part_index:item.part_index}});
    } catch (error) { console.warn('QQ rate limit diagnostic:',error.message); }
    console.warn(`QQ 限频拒绝已改为可重试：Discord ${item.source_message_id} 第 ${item.part_index + 1} 段。`);
  }
  if (!state.prepare('SELECT 1 FROM forward_meta WHERE key=?').get('start_at')) {
    state.prepare('INSERT INTO forward_meta(key,value) VALUES (?,?)').run('start_at', new Date().toISOString());
  }
  console.log('QQ 转发已启用，仅处理首次启用后入库的消息；接口接受不代表手机已收到。');
  const interrupted = state.prepare(`SELECT a.source_message_id,a.source_timestamp,a.channel_id,a.part_index,a.group_openid FROM forward_attempts a
    WHERE a.status='unknown'
      AND NOT EXISTS (SELECT 1 FROM forward_attempts b
        WHERE b.group_openid=a.group_openid AND b.source_message_id=a.source_message_id
          AND b.origin='repair'
          AND b.status='accepted' AND b.attempted_at>a.attempted_at)
    ORDER BY a.attempted_at DESC LIMIT 10`).all();
  for (const item of interrupted) {
    const detail = `Discord ${item.source_message_id}（${channelLabels()[item.channel_id] || item.channel_id}，原消息时间 ${sourceTimeLabel(item)}，第 ${item.part_index + 1} 段）`;
    console.warn(`启动检查：${detail} 发送结果未知；需核对 QQ 群后定向补发。`);
    alerts.notify(`unresolved:${item.group_openid}:${item.source_message_id}:${item.part_index}`,
      `【QQ 转发告警】启动检查发现 ${detail} 发送结果未知。请先核对 QQ 群是否收到，勿直接重发。`);
  }
  setInterval(tick, 5000);
  tick();
}
function setOnline(value) {
  const wasOnline = online;
  online = value;
  if (!online || wasOnline) return;
  const routes = additionalTargets();
  const control = primaryControl();
  const groupNames = {'1132949059':'群 2','1130863739':'群 3'};
  for (const [channelId,label] of Object.entries(channelLabels())) {
    const groups = routes.filter(route => route.channel_ids.includes(channelId))
      .map(route => groupNames[route.qq_group_number]
        ? `${groupNames[route.qq_group_number]}（${route.qq_group_number}）`
        : `QQ群 ${route.qq_group_number}`);
    if (!additionalChannelIds.has(channelId) && control.primary_enabled !== false) groups.push('群 1');
    const paused = control.paused_channels?.[channelId] === true;
    const status = paused ? '转发已暂停' : groups.length ? '已启动自动转发' : '未启用自动转发';
    console.log(`频道 ${label}：${status}${groups.length ? `（${groups.join('、')}）` : ''}；Discord 页面待扫描确认。`);
  }
}
module.exports = {start,setOnline,splitText,sourceTimeLabel,messageHeading,fengxunFingerprint:fengxun.fingerprint,
  routeAcceptsMessage,primaryAcceptsMessage,isAfterLiveWatermark,buildParts,processMessage,
  recoveryCandidates:manualRecovery.recoveryCandidates,queueRecovery:manualRecovery.queueRecovery,
  recoveryStatus:manualRecovery.recoveryStatus,cancelRecovery:manualRecovery.cancelRecovery,
  forwardingStatus,setForwardingPaused};

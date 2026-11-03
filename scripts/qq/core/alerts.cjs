const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = path.resolve(__dirname, '..', '..', '..', 'data');
const recipientFile = path.join(dataDir, 'qq-alert-recipient.json');
const bindingFile = path.join(dataDir, 'qq-alert-binding.json');
const appId = process.env.QQ_BOT_APP_ID?.trim();
const secret = process.env.QQ_BOT_APP_SECRET?.trim();
const attempted = new Set();
let accessToken;
let tokenExpiresAt = 0;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function bindingCode() {
  const recipient = readJson(recipientFile);
  if (recipient?.app_id === appId && recipient?.user_openid) return null;
  let binding = readJson(bindingFile);
  if (binding?.app_id !== appId || !/^[a-f0-9]{12}$/.test(binding?.code || '')) {
    binding = {app_id: appId, code: crypto.randomBytes(6).toString('hex')};
    fs.writeFileSync(bindingFile, JSON.stringify(binding, null, 2));
  }
  return binding.code;
}

async function token() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  const response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
    method: 'POST', headers: {'content-type':'application/json'},
    body:JSON.stringify({appId, clientSecret:secret}), signal:AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || body.code || !body.access_token) throw Error(`token HTTP ${response.status}, code ${body.code ?? 'unknown'}`);
  accessToken = body.access_token;
  tokenExpiresAt = Date.now() + Math.max(0, Number(body.expires_in || 7200) - 120) * 1000;
  return accessToken;
}

async function send(userOpenid, content, msgId) {
  const response = await fetch(`https://api.bot.qq.com/v2/users/${encodeURIComponent(userOpenid)}/messages`, {
    method:'POST',
    headers:{authorization:`QQBot ${await token()}`,'content-type':'application/json; charset=utf-8'},
    body:JSON.stringify({msg_type:0,content,...(msgId ? {msg_id:msgId} : {})}),
    signal:AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok || body.code || body.err_code || !body.id) {
    throw Error(`HTTP ${response.status}, code ${body.err_code ?? body.code ?? 'unknown'}, trace ${body.trace_id ?? 'none'}`);
  }
  return body;
}

function onC2C(packet) {
  const userOpenid = packet.d?.author?.user_openid;
  const code = bindingCode();
  if (!code || !userOpenid || String(packet.d?.content || '').trim() !== `绑定告警 ${code}`) return;
  fs.writeFileSync(recipientFile, JSON.stringify({app_id:appId,user_openid:userOpenid,bound_at:new Date().toISOString()}, null, 2));
  fs.rmSync(bindingFile, {force:true});
  console.log('QQ 私聊告警收件人已绑定。');
  send(userOpenid, 'QQ 转发告警已绑定。今后发送失败或转发暂停时，我会尝试私聊通知你。', packet.d?.id)
    .then(() => console.log('QQ 私聊绑定确认已获接口接受。'))
    .catch(error => console.error(`QQ 私聊绑定确认失败：${error.message}`));
}

function notify(key, content) {
  const recipient = readJson(recipientFile);
  if (recipient?.app_id !== appId || !recipient?.user_openid) {
    console.warn('QQ 私聊告警未绑定；发送异常仅记录在本地日志。');
    return Promise.resolve(false);
  }
  if (attempted.has(key)) return Promise.resolve(true);
  attempted.add(key);
  return send(recipient.user_openid, content.slice(0, 1000))
    .then(() => { console.log(`QQ 私聊告警已获接口接受：${key}`); return true; })
    .catch(error => { attempted.delete(key); console.error(`QQ 私聊告警发送失败：${key}：${error.message}`); return false; });
}

async function sendTest() {
  const recipient = readJson(recipientFile);
  if (recipient?.app_id !== appId || !recipient?.user_openid) throw Error('QQ 私聊告警尚未绑定');
  return send(recipient.user_openid, 'QQ 转发告警测试：这是一条主动私聊。收到后，后续转发故障告警可使用同一通道。');
}

module.exports = {bindingCode,onC2C,notify,sendTest};

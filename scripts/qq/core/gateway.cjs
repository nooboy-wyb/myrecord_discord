const fs = require('node:fs');
const path = require('node:path');

const appId = process.env.QQ_BOT_APP_ID?.trim();
const secret = process.env.QQ_BOT_APP_SECRET?.trim();
const dataDir = path.resolve(__dirname, '..', '..', '..', 'data');
const additionalRoutesPath = path.join(dataDir, 'qq-additional-routes.json');
const alerts = require('./alerts.cjs');
if (!/^\d+$/.test(appId || '') || !secret) {
  console.error('Set QQ_BOT_APP_ID and QQ_BOT_APP_SECRET before starting.');
  process.exit(1);
}

async function api(url, options) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(15000)});
  const body = await response.json();
  if (!response.ok || body.code || body.err_code) {
    throw Error(`QQ API failed: HTTP ${response.status}, code ${body.code ?? body.err_code ?? 'unknown'}, message ${body.message ?? 'unknown'}, trace ${body.trace_id ?? 'none'}`);
  }
  return body;
}

async function main(onState = () => {}, reconnect = null) {
  const credential = await api('https://api.bot.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({appId, clientSecret: secret}),
  });
  const authorization = `QQBot ${credential.access_token}`;
  const gateway = await api('https://api.bot.qq.com/gateway', {
    headers: {authorization},
  });
  if (!gateway.url?.startsWith('wss://')) throw Error('Invalid QQ gateway URL');
  const socket = new WebSocket(gateway.url);
  let heartbeat;
  let sequence = null;
  let savedGroup = fs.existsSync(path.join(dataDir, 'qq-group-openid.json'));
  socket.addEventListener('open', () => console.log('QQ Gateway 已建立连接，等待鉴权。'));
  socket.addEventListener('message', event => {
    let packet;
    try { packet = JSON.parse(event.data); }
    catch { return; }
    if (typeof packet.s === 'number') sequence = packet.s;
    if (packet.op === 10) {
      const interval = packet.d?.heartbeat_interval;
      if (!Number.isFinite(interval) || interval < 1000) {
        console.error('QQ Gateway 返回了无效心跳周期。');
        socket.close();
        return;
      }
      socket.send(JSON.stringify({op: 2, d: {
        token: authorization,
        intents: 1 << 25,
        shard: [0, 1],
        properties: {$os: 'windows', $browser: 'muse', $device: 'muse'},
      }}));
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({op: 1, d: sequence}));
      }, interval);
      return;
    }
    if (packet.t === 'READY') {
      console.log('机器人已登录 QQ Gateway。保持此窗口打开；可查看后台在线状态。');
      if (!savedGroup) console.log('首次获取目标群 OpenID 时，在群里发送一次：@机器人 测试');
      onState(true);
      return;
    }
    if (packet.t && packet.t !== 'READY') console.log(`收到 QQ 事件：${packet.t}`);
    if (packet.t === 'C2C_MESSAGE_CREATE') alerts.onC2C(packet);
    if (!savedGroup && ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(packet.t) && packet.d?.group_openid) {
      const output = path.join(dataDir, 'qq-group-openid.json');
      fs.mkdirSync(path.dirname(output), {recursive: true});
      fs.writeFileSync(output, JSON.stringify({app_id: appId, group_openid: packet.d.group_openid, observed_at: new Date().toISOString()}, null, 2));
      savedGroup = true;
      console.log(`已保存群 OpenID：${output}。连接将继续保持，按 Ctrl+C 停止。`);
    }
    if (['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(packet.t) && packet.d?.group_openid && fs.existsSync(additionalRoutesPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(additionalRoutesPath, 'utf8'));
        const content = String(packet.d.content || '');
        const primaryPath = path.join(dataDir, 'qq-group-openid.json');
        const primary = fs.existsSync(primaryPath) ? JSON.parse(fs.readFileSync(primaryPath, 'utf8')).group_openid : null;
        for (const route of config.routes || []) {
          if (route.group_openid || !route.binding_code || !route.qq_group_number) continue;
          if (!content.includes(route.binding_code) || !content.includes(route.qq_group_number)) continue;
          if (packet.d.group_openid === primary) {
            console.error(`群 ${route.qq_group_number} 绑定消息来自现有主群，已忽略。`);
            continue;
          }
          route.group_openid = packet.d.group_openid;
          route.enabled_at = new Date().toISOString();
          fs.writeFileSync(additionalRoutesPath, JSON.stringify(config, null, 2));
          console.log(`已绑定附加目标群 ${route.qq_group_number}；仅接收配置的 Discord 频道。`);
          api(`https://api.bot.qq.com/v2/groups/${encodeURIComponent(route.group_openid)}/messages`, {
            method:'POST',
            headers:{authorization,'content-type':'application/json; charset=utf-8'},
            body:JSON.stringify({msg_type:0,content:'Discord 转发绑定测试：本群仅接收已配置频道的新消息。'})
          }).then(result => {
            if (!result.id) throw Error('QQ test send returned no message ID');
            console.log(`附加群 ${route.qq_group_number} 的绑定测试消息已获 QQ 接口接受。`);
          }).catch(error => console.error(`附加群 ${route.qq_group_number} 的绑定测试发送失败：${error.message}`));
        }
      } catch (error) { console.error(`附加群绑定失败：${error.message}`); }
    }
  });
  socket.addEventListener('error', () => console.error('QQ WebSocket 连接失败；请检查网络、机器人状态和开发设置。'));
  socket.addEventListener('close', event => {
    clearInterval(heartbeat);
    onState(false);
    console.error(`QQ WebSocket 已断开，代码 ${event.code}${event.reason ? `，原因 ${event.reason}` : ''}。`);
    if (reconnect) setTimeout(reconnect, 5000);
  });
}

function startGateway(onState = () => {}) {
  const code = alerts.bindingCode();
  if (code) console.log(`QQ 私聊告警待绑定：请私聊机器人发送「绑定告警 ${code}」。`);
  const connect = () => main(onState, connect).catch(error => {
    onState(false);
    console.error(`QQ Gateway 连接失败：${error.message}。10 秒后重试。`);
    setTimeout(connect, 10000);
  });
  connect();
}
if (require.main === module) startGateway();
module.exports = {startGateway};

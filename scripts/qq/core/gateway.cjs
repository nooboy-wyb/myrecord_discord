const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

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

async function main(onState = () => {}, reconnect = null, session = {}) {
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
  const connectionId = randomUUID().slice(0,8);
  const startedAt = Date.now();
  let heartbeat;
  let authenticationTimeout;
  let heartbeatInterval = null;
  let pendingHeartbeatAt = null;
  let lastAckAt = null;
  let heartbeatSent = 0;
  let heartbeatAcked = 0;
  let readyAt = null;
  let retired = false;
  let savedGroup = fs.existsSync(path.join(dataDir, 'qq-group-openid.json'));
  const resetSession = () => {
    session.id = null;
    session.sequence = null;
  };
  function finish(reason, delay = 5000, reset = false, closeSocket = true) {
    if (retired) return;
    retired = true;
    clearInterval(heartbeat);
    clearTimeout(authenticationTimeout);
    const now = Date.now();
    if (reset) resetSession();
    if (session.disconnectedAt == null) session.disconnectedAt = now;
    onState(false);
    console.log(`QQ Gateway 会话结束：${JSON.stringify({connection_id:connectionId,reason,
      connection_ms:now-startedAt,online_ms:readyAt == null ? 0 : now-readyAt,
      heartbeat_interval_ms:heartbeatInterval,heartbeat_sent:heartbeatSent,
      heartbeat_acked:heartbeatAcked,last_ack_age_ms:lastAckAt == null ? null : now-lastAckAt,
      reconnect_delay_ms:delay})}`);
    if (closeSocket) {
      try { socket.close(1000,'reconnect'); }
      catch (error) { console.warn(`QQ Gateway 关闭旧连接失败：${error.message}`); }
    }
    if (reconnect) setTimeout(reconnect,delay);
  }
  function sendHeartbeat() {
    if (retired || socket.readyState !== WebSocket.OPEN) return;
    if (pendingHeartbeatAt != null) {
      console.warn(`QQ Gateway 心跳确认超时：${JSON.stringify({connection_id:connectionId,
        waited_ms:Date.now()-pendingHeartbeatAt,heartbeat_interval_ms:heartbeatInterval})}`);
      finish('HEARTBEAT_ACK_TIMEOUT',0);
      return;
    }
    try {
      pendingHeartbeatAt = Date.now();
      socket.send(JSON.stringify({op:1,d:session.sequence ?? null}));
      heartbeatSent++;
      console.log(`QQ Gateway 心跳发送：${JSON.stringify({connection_id:connectionId,heartbeat_sent:heartbeatSent})}`);
    } catch (error) {
      console.warn(`QQ Gateway 心跳发送失败：${error.message}`);
      finish('HEARTBEAT_SEND_FAILED',5000);
    }
  }
  authenticationTimeout = setTimeout(() => finish('AUTHENTICATION_TIMEOUT',5000),30000);
  socket.addEventListener('open', () => {
    if (!retired) console.log(`QQ Gateway 已建立连接，等待鉴权。连接 ${connectionId}。`);
  });
  socket.addEventListener('message', event => {
    if (retired) return;
    let packet;
    try { packet = JSON.parse(event.data); }
    catch { return; }
    if (!packet || typeof packet !== 'object') return;
    if (packet.op === 0 && Number.isSafeInteger(packet.s)) session.sequence = packet.s;
    if (packet.op === 7) {
      console.log(`QQ Gateway 收到重连通知 op:7，连接 ${connectionId}，立即重连。`);
      finish('SERVER_RECONNECT_OP7',0);
      return;
    }
    if (packet.op === 9) {
      const resumable = packet.d === true;
      console.warn(`QQ Gateway 会话失效 op:9，连接 ${connectionId}，${resumable ? '尝试恢复会话' : '重新鉴权'}。`);
      finish('INVALID_SESSION_OP9',1000,!resumable);
      return;
    }
    if (packet.op === 11) {
      if (pendingHeartbeatAt != null) {
        lastAckAt = Date.now();
        const roundTripMs = lastAckAt-pendingHeartbeatAt;
        pendingHeartbeatAt = null;
        heartbeatAcked++;
        console.log(`QQ Gateway 心跳确认：${JSON.stringify({connection_id:connectionId,
          round_trip_ms:roundTripMs,heartbeat_sent:heartbeatSent,heartbeat_acked:heartbeatAcked})}`);
      }
      return;
    }
    if (packet.op === 10) {
      if (heartbeatInterval != null) return;
      const interval = packet.d?.heartbeat_interval;
      if (!Number.isFinite(interval) || interval < 1000) {
        console.error('QQ Gateway 返回了无效心跳周期。');
        finish('INVALID_HEARTBEAT_INTERVAL',5000);
        return;
      }
      heartbeatInterval = interval;
      const resume = typeof session.id === 'string' && Number.isSafeInteger(session.sequence);
      try {
        socket.send(JSON.stringify(resume ? {op:6,d:{token:authorization,
          session_id:session.id,seq:session.sequence}} : {op:2,d:{token:authorization,
          intents:1 << 25,shard:[0,1],
          properties:{$os:'windows',$browser:'muse',$device:'muse'}}}));
      } catch (error) {
        console.warn(`QQ Gateway 鉴权发送失败：${error.message}`);
        finish('AUTHENTICATION_SEND_FAILED',5000);
        return;
      }
      console.log(`QQ Gateway 会话握手：${JSON.stringify({connection_id:connectionId,
        mode:resume ? 'resume' : 'identify',heartbeat_interval_ms:interval})}`);
      heartbeat = setInterval(sendHeartbeat,interval);
      return;
    }
    if (packet.op === 0 && ['READY','RESUMED'].includes(packet.t)) {
      if (packet.t === 'READY') session.id = typeof packet.d?.session_id === 'string' ? packet.d.session_id : null;
      clearTimeout(authenticationTimeout);
      readyAt = Date.now();
      console.log(`QQ Gateway 会话就绪：${JSON.stringify({connection_id:connectionId,event:packet.t,
        connect_to_ready_ms:readyAt-startedAt,
        downtime_ms:session.disconnectedAt == null ? 0 : readyAt-session.disconnectedAt})}`);
      session.disconnectedAt = null;
      console.log('机器人已登录 QQ Gateway；后台连接已就绪。');
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
  socket.addEventListener('error', () => {
    if (retired) return;
    console.error('QQ WebSocket 连接失败；请检查网络、机器人状态和开发设置。');
    finish('SOCKET_ERROR',5000);
  });
  socket.addEventListener('close', event => {
    if (retired) return;
    console.error(`QQ WebSocket 已断开，代码 ${event.code}${event.reason ? `，原因 ${event.reason}` : ''}。`);
    finish(`SOCKET_CLOSE_${event.code}`,5000,[4006,4007,4009].includes(event.code),false);
  });
}

function startGateway(onState = () => {}) {
  const code = alerts.bindingCode();
  if (code) console.log(`QQ 私聊告警待绑定：请私聊机器人发送「绑定告警 ${code}」。`);
  const session = {};
  const connect = () => main(onState, connect, session).catch(error => {
    onState(false);
    console.error(`QQ Gateway 连接失败：${error.message}。10 秒后重试。`);
    setTimeout(connect, 10000);
  });
  connect();
}
if (require.main === module) startGateway();
module.exports = {startGateway};

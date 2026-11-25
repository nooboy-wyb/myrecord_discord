const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {saveDiagnostic,recoveryAlertAlreadyHandled} = require('../../collector_diagnostics.cjs');

function createControlHandler({root,forwarder,authorized}) {
  const recoveryNoticeAt = new Map();
  return function handle(req,res) {
    const reply = (status,value) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
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
        timeout:'自动恢复连续两次未成功：仍未重新识别到消息，请人工检查；快速重试已暂停，保底刷新继续',
        failed:'自动恢复连续两次未成功：标签页重载失败，请人工检查；快速重试已暂停，保底刷新继续',
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
      if (!isTest && now - event.requestedAt > 10 * 60_000) {
        logAlert('ALERT_SUPPRESSED_STALE');
        return reply(200,{ok:true,suppressed:true});
      }
      if (!isTest && (recoveryAlertAlreadyHandled(event)
        || now - Number(recoveryNoticeAt.get(noticeKey) || 0) < 40 * 60_000)) {
        logAlert('ALERT_SUPPRESSED');
        return reply(200,{ok:true,suppressed:true});
      }
      const key = `discord-recovery:${event.channelId}:${event.requestedAt}:${event.status}`;
      let accepted;
      try {
        accepted = await require('./alerts.cjs').notify(key,
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
    reply(404,{error:'not found'});
  };
}
module.exports = {createControlHandler};

const ENDPOINT = 'http://127.0.0.1:8765/v1/messages';
const requestedChannels = [
  {id:'1224358019056271442', label:'利润医生', marker:'addedLirunYishengChannelV1'},
  {id:'1265882617530814535', label:'交流频道', marker:'addedJiaoliuChannelV1'},
  {id:'1254782508793593947', label:'颜驰', marker:'addedYanchiMainChannelV1'},
  {id:'1381176601802440744', label:'熬鹰', marker:'addedAoyingChannelV1'},
  // https://discord.com/channels/1222459489333018634/1405206823727796408
  {id:'1405206823727796408', label:'风寻', marker:'addedFengxunChannelV2'},
  {id:'1296438667438719028', label:'颜驰 饭碗警报', marker:'addedYanchiFanwanChannelV1'},
  {id:'1439232860014907412', label:'颜驰 视频解说', marker:'addedYanchiVideoChannelV1'},
  {id:'1222944235691708477', label:'柳玉东', marker:'addedLiuYudongChannelV1'},
  {id:'1563418901075857428', label:'匿名博士', marker:'addedAnonymousDoctorChannelV1'},
  {id:'1332650386720559105', label:'tia', marker:'addedTiaImagesChannelV1'}
];
async function addRequestedChannelsOnce() {
  const data = await chrome.storage.local.get(['allowedChannels','channelLabels',...requestedChannels.map(item => item.marker)]);
  const additions = requestedChannels.filter(item => !data[item.marker]);
  if (!additions.length) return;
  const allowedChannels = new Set(data.allowedChannels || []);
  const channelLabels = {...(data.channelLabels || {})};
  const markers = {};
  for (const item of additions) {
    allowedChannels.add(item.id);
    channelLabels[item.id] = item.label;
    markers[item.marker] = true;
  }
  await chrome.storage.local.set({allowedChannels:[...allowedChannels],channelLabels,...markers});
}
addRequestedChannelsOnce().catch(error => console.error('Channel setup:', error));
let sending = false;
let uploadWakeRequested = false;
let captureRetryTimer;
let queueMutation = Promise.resolve();
function mutateQueue(change) {
  const operation = queueMutation.then(async () => {
    const {queue = []} = await chrome.storage.local.get('queue');
    const result = change(queue);
    await chrome.storage.local.set({queue});
    return result;
  });
  queueMutation = operation.catch(() => {});
  return operation;
}
async function enqueue(message) {
  if (message.capture_trace?.scan_id) message = {...message,
    capture_trace:{...message.capture_trace,queued_at:Date.now()}};
  const key = `${message.channel_id}:${message.source_message_id}:${JSON.stringify([message.body_raw, message.attachments])}`;
  await mutateQueue(queue => {
    if (!queue.some(item => item.key === key)) queue.push({key, message});
    if (queue.length > 2000) {
      queue.splice(0, queue.length - 2000);
      chrome.storage.local.set({lastError:'待入库队列超过 2000 条，较早消息可能丢失',lastErrorAt:Date.now()});
      queueDiagnostic('CAPTURE_QUEUE_OVERFLOW',{channel_id:message.channel_id,
        source_message_id:message.source_message_id,error:'待入库队列超过 2000 条'});
    }
  });
  await flush();
}
function scheduleCaptureRetry(retryAt) {
  if (captureRetryTimer != null) clearTimeout(captureRetryTimer);
  captureRetryTimer = setTimeout(() => {
    captureRetryTimer = undefined;
    flush().catch(error => console.error('Capture retry:',error));
  },Math.max(0,retryAt - Date.now()));
}
async function flush() {
  uploadWakeRequested = true;
  if (sending) return;
  sending = true;
  try {
    while (true) {
      // Remember wakeups that arrive while this storage read is pending.
      uploadWakeRequested = false;
      const {token = '', queue = [], captureRetryAt = 0, captureRetryFailures = 0} =
        await chrome.storage.local.get(['token','queue','captureRetryAt','captureRetryFailures']);
      if (!token) return;
      if (!queue.length) {
        if (uploadWakeRequested) continue;
        return;
      }
      if (captureRetryAt > Date.now()) {
        scheduleCaptureRetry(captureRetryAt);
        return;
      }
      // Read a fresh head after every acknowledgement, including new arrivals.
      const item = queue[0];
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST', headers: {'Content-Type': 'application/json', 'X-Collector-Token': token},
          body: JSON.stringify(item.message), signal:AbortSignal.timeout(30000)
        });
        if (response.status === 400) {
          const detail = (await response.text()).slice(0,200);
          await mutateQueue(current => {
            const index = current.findIndex(x => x.key === item.key);
            if (index >= 0) current.splice(index,1);
          });
          const {rejectedCaptures = []} = await chrome.storage.local.get('rejectedCaptures');
          rejectedCaptures.push({channelId:item.message.channel_id,
            sourceMessageId:item.message.source_message_id,error:detail,at:Date.now()});
          await chrome.storage.local.set({rejectedCaptures:rejectedCaptures.slice(-100),
            captureRetryAt:0,captureRetryFailures:0,
            lastError:'消息 '+item.message.source_message_id+' 被本机拒收，请检查扩展诊断',lastErrorAt:Date.now()});
          await queueDiagnostic('CAPTURE_REJECTED',{channel_id:item.message.channel_id,
            source_message_id:item.message.source_message_id,error:detail});
          continue;
        }
        if (!response.ok) throw new Error('HTTP '+response.status);
        await mutateQueue(current => {
          const index = current.findIndex(x => x.key === item.key);
          if (index >= 0) current.splice(index,1);
        });
        if (captureRetryTimer != null) clearTimeout(captureRetryTimer);
        captureRetryTimer = undefined;
        await chrome.storage.local.set({lastSavedAt:Date.now(),lastError:'',
          captureRetryAt:0,captureRetryFailures:0});
      } catch (error) {
        const previous = (await chrome.storage.local.get('lastError')).lastError || '';
        const failures = Math.min(Number(captureRetryFailures) + 1,6);
        const retryAt = Date.now() + Math.min(30000,1000 * 2 ** (failures - 1));
        await chrome.storage.local.set({lastError:String(error),lastErrorAt:Date.now(),
          captureRetryAt:retryAt,captureRetryFailures:failures});
        if (previous !== String(error)) await queueDiagnostic('CAPTURE_UPLOAD_FAILED',{
          channel_id:item.message.channel_id,source_message_id:item.message.source_message_id,
          error:String(error)});
        scheduleCaptureRetry(retryAt);
        return;
      }
    }
  } finally { sending = false; }
}
let refreshing = false;
let alertSending = false;
let diagnosticSending = false;
let diagnosticQueueMutation = Promise.resolve();
async function changeDiagnosticQueue(change) {
  const operation = diagnosticQueueMutation.then(async () => {
    const {diagnosticQueue = []} = await chrome.storage.local.get('diagnosticQueue');
    const result = change(diagnosticQueue);
    await chrome.storage.local.set({diagnosticQueue});
    return result;
  });
  diagnosticQueueMutation = operation.catch(() => {});
  return operation;
}
async function queueDiagnostic(code, fields = {}) {
  try {
    const event = {event_id:crypto.randomUUID(),at:Date.now(),code,...fields};
    const dropped = await changeDiagnosticQueue(queue => {
      queue.push(event);
      return queue.length > 1000 ? queue.splice(0,queue.length - 1000).length : 0;
    });
    if (dropped) {
      const {diagnosticDroppedCount = 0} = await chrome.storage.local.get('diagnosticDroppedCount');
      await chrome.storage.local.set({diagnosticDroppedCount:diagnosticDroppedCount + dropped});
    }
    flushDiagnostics().catch(error => console.warn('Diagnostic flush:',error));
  } catch (error) { console.warn('Diagnostic queue:',error); }
}
async function flushDiagnostics() {
  if (diagnosticSending) return;
  diagnosticSending = true;
  let retrySoon = false;
  try {
    const {token = '', diagnosticQueue = []} = await chrome.storage.local.get(['token','diagnosticQueue']);
    if (!token) return;
    for (const event of [...diagnosticQueue].sort((a,b) => b.at - a.at).slice(0,25)) {
      try {
        const response = await fetch('http://127.0.0.1:8765/v1/collector/diagnostic',{
          method:'POST',headers:{'Content-Type':'application/json','X-Collector-Token':token},
          body:JSON.stringify(event), signal:AbortSignal.timeout(8000)
        });
        if (!response.ok) throw Error(`HTTP ${response.status}: ${(await response.text()).slice(0,200)}`);
        await changeDiagnosticQueue(queue => {
          const index = queue.findIndex(item => item.event_id === event.event_id);
          if (index >= 0) queue.splice(index,1);
        });
        await chrome.storage.local.set({lastDiagnosticError:''});
      } catch (error) {
        await chrome.storage.local.set({lastDiagnosticError:String(error),lastDiagnosticErrorAt:Date.now()});
        break;
      }
    }
    const remaining = (await chrome.storage.local.get('diagnosticQueue')).diagnosticQueue || [];
    retrySoon = remaining.length > 0 && !((await chrome.storage.local.get('lastDiagnosticError')).lastDiagnosticError);
  } finally {
    diagnosticSending = false;
    if (retrySoon) setTimeout(() => flushDiagnostics().catch(error =>
      console.warn('Diagnostic batch:',error)),1000);
  }
}
async function queueRecoveryAlert(event) {
  const {recoveryAlertQueue = []} = await chrome.storage.local.get('recoveryAlertQueue');
  const key = `${event.channelId}:${event.requestedAt}:${event.status}`;
  if (event.status === 'recovered') {
    for (let index = recoveryAlertQueue.length - 1; index >= 0; index--) {
      const pending = recoveryAlertQueue[index].event;
      if (pending?.channelId === event.channelId && pending.requestedAt === event.requestedAt
        && ['timeout','failed'].includes(pending.status)) recoveryAlertQueue.splice(index,1);
    }
  }
  if (!recoveryAlertQueue.some(item => item.key === key)) recoveryAlertQueue.push({key,event});
  await chrome.storage.local.set({recoveryAlertQueue:recoveryAlertQueue.slice(-100)});
  await flushRecoveryAlerts();
}
async function flushRecoveryAlerts() {
  if (alertSending) return;
  alertSending = true;
  try {
    const {token = '', recoveryAlertQueue = []} = await chrome.storage.local.get(['token','recoveryAlertQueue']);
    if (!token) return;
    const activeQueue = recoveryAlertQueue.filter(item => item.event?.status !== 'started');
    if (activeQueue.length !== recoveryAlertQueue.length) await chrome.storage.local.set({recoveryAlertQueue:activeQueue});
    for (const item of activeQueue) {
      try {
        const response = await fetch('http://127.0.0.1:8765/v1/collector/recovery-alert',{
          method:'POST',headers:{'Content-Type':'application/json','X-Collector-Token':token},
          body:JSON.stringify(item.event)
        });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const current = (await chrome.storage.local.get('recoveryAlertQueue')).recoveryAlertQueue || [];
        await chrome.storage.local.set({recoveryAlertQueue:current.filter(row => row.key !== item.key)});
      } catch (error) { console.warn('Recovery alert pending:',error); break; }
    }
  } finally { alertSending = false; }
}
const scanStaleAfterMs = 2 * 60_000;
const periodicRefreshIntervalMs = 30 * 60_000;
const recoveryRetryMs = 60_000;
const recoveryPauseMs = 30 * 60_000;
const channelFromUrl = url => url?.match(/^https:\/\/discord\.com\/channels\/(?:\d+|@me)\/(\d+)(?:[/?#]|$)/)?.[1];
const healthKey = tabId => `health:${tabId}`;
const pollKey = tabId => `poll:${tabId}`;
const pollScanProgress = new Map();
const diagnosticHealth = (tab,channelId,health,extra = {}) => ({
  channel_id:channelId,tab_id:tab.id,incident_at:Number(health.incidentStartedAt || 0) || null,
  attempt:Number(health.attempt || 0),requested_at:Number(health.requestedAt || 0) || null,
  loaded_at:Number(health.loadedAt || 0) || null,
  last_scan_at:Number(health.lastScanAt || 0) || null,
  last_good_at:Number(health.lastGoodAt || 0) || null,
  next_attempt_at:Number(health.nextAttemptAt || 0) || null,...extra
});
async function updateRefreshHistory(tabId, changes) {
  const {refreshHistory = []} = await chrome.storage.local.get('refreshHistory');
  const index = refreshHistory.findIndex(item => item.tabId === tabId && !item.recoveredAt && item.requestedAt === changes.requestedAt);
  if (index >= 0) refreshHistory[index] = {...refreshHistory[index], ...changes};
  else if (changes.requestedAt) refreshHistory.unshift({tabId, ...changes});
  await chrome.storage.local.set({refreshHistory:refreshHistory.slice(0, 8)});
}
async function refreshMonitoredTabs(force = false, test = false, recoveryOnly = false) {
  if (refreshing) return;
  refreshing = true;
  let selectedRecovery = false;
  try {
    const startedAt = Date.now();
    const requested = [];
    const errors = [];
    await chrome.storage.local.set({lastRefreshAt: startedAt, lastRefreshRequested: [],
      lastRefreshCompleted: [], lastRefreshError: ''});
    try {
      const {allowedChannels = [], token = '', lastRefreshByTab = {},
        lastPeriodicRefreshByTab = {},
        periodicScheduleVersion = 0, refreshTestMode = {}} =
        await chrome.storage.local.get(['allowedChannels', 'token', 'lastRefreshByTab',
          'lastPeriodicRefreshByTab','periodicScheduleVersion','refreshTestMode']);
      if (!token) throw new Error('未配置采集令牌');
      if (!allowedChannels.length) throw new Error('没有允许采集的频道');
      flush().catch(error => console.error('Queue flush before patrol:',error));
      const tabs = await chrome.tabs.query({url: 'https://discord.com/channels/*'});
      if (periodicScheduleVersion !== 1) {
        for (const tab of tabs) {
          if (tab.id == null || !allowedChannels.includes(channelFromUrl(tab.url))) continue;
          lastRefreshByTab[tab.id] = startedAt;
        }
        await chrome.storage.local.set({lastRefreshByTab,periodicScheduleVersion:1});
      }
      const healthRecords = await chrome.storage.local.get(tabs.flatMap(tab =>
        [healthKey(tab.id),pollKey(tab.id)]));
      const {recoveryRetryVersion = 0} = await chrome.storage.local.get('recoveryRetryVersion');
      if (recoveryRetryVersion !== 3) {
        const revised = {recoveryRetryVersion:3};
        for (const tab of tabs) {
          const key = healthKey(tab.id);
          const health = healthRecords[key];
          if (!health?.incidentStartedAt || !health.nextAttemptAt) continue;
          const newDueAt = Number(health.requestedAt || health.incidentStartedAt) + recoveryRetryMs;
          if (health.nextAttemptAt > newDueAt) {
            healthRecords[key] = {...health,nextAttemptAt:newDueAt};
            revised[key] = healthRecords[key];
          }
        }
        await chrome.storage.local.set(revised);
      }
      const candidates = [];
      const periodicCandidates = [];
      let refreshClockChanged = false;
      for (const tab of tabs) {
        const channelId = channelFromUrl(tab.url);
        if (!channelId || !allowedChannels.includes(channelId) || tab.id == null) continue;
        if (test && refreshTestMode.seenTabIds?.includes(tab.id)) continue;
        const health = healthRecords[healthKey(tab.id)] || {};
        const lastScan = Number(health.lastScanAt || 0);
        const lastGood = Number(health.lastGoodAt || 0);
        const currentHealth = (await chrome.storage.local.get(healthKey(tab.id)))[healthKey(tab.id)] || health;
        if (health.incidentStartedAt && currentHealth.incidentStartedAt === health.incidentStartedAt
            && currentHealth.status === 'recovering'
            && Number(currentHealth.failedRequestAt || 0) !== Number(currentHealth.requestedAt || 0)
            && startedAt - Math.max(Number(currentHealth.requestedAt || 0),
              Number(currentHealth.loadedAt || 0)) >= recoveryRetryMs) {
          const failedAttempts = Number(currentHealth.failedAttempts || 0) + 1;
          const shouldAlert = failedAttempts >= 2 && !currentHealth.outcomeNotifiedAt;
          const failure = {...currentHealth,failedAttempts,failedRequestAt:currentHealth.requestedAt,
            recoveryPausedUntil:failedAttempts >= 2 ? startedAt + recoveryPauseMs : 0,
            outcomeNotifiedAt:shouldAlert ? startedAt : Number(currentHealth.outcomeNotifiedAt || 0)};
          Object.assign(health,failure);
          await chrome.storage.local.set({[healthKey(tab.id)]:failure});
          await queueDiagnostic('RECOVERY_ATTEMPT_TIMEOUT',diagnosticHealth(tab,channelId,failure,{
            error:'本次重载后一分钟仍未重新识别到消息',detail:{failed_attempts:failedAttempts}}));
          if (shouldAlert) await queueRecoveryAlert({channelId,requestedAt:failure.incidentStartedAt,
            attempt:failure.attempt,status:'timeout'});
        }
        if (!lastRefreshByTab[tab.id]) {
          lastRefreshByTab[tab.id] = startedAt;
          refreshClockChanged = true;
        }
        if (!lastPeriodicRefreshByTab[tab.id]) {
          lastPeriodicRefreshByTab[tab.id] = Number(lastRefreshByTab[tab.id]) || startedAt;
          refreshClockChanged = true;
        }
        const lastRefresh = Number(lastRefreshByTab[tab.id]);
        const poll = healthRecords[pollKey(tab.id)] || {};
        const heartbeat = Math.max(lastScan,Number(poll.lastSuccessAt || 0));
        const scanStale = tab.discarded || Number(poll.consecutiveFailures || 0) >= 2
          && startedAt - (heartbeat || lastRefresh) >= scanStaleAfterMs;
        const candidate = {tab, channelId, lastScan, lastGood, lastRefresh, health,
          poll,heartbeat,scanStale};
        if (force || test || scanStale && startedAt >= Math.max(Number(health.nextAttemptAt || 0),
          health.incidentStartedAt ? Number(health.loadedAt || 0) + recoveryRetryMs : 0)
          && startedAt >= Number(health.recoveryPausedUntil || 0)) candidates.push(candidate);
        if (startedAt - Number(lastPeriodicRefreshByTab[tab.id]) >= periodicRefreshIntervalMs)
          periodicCandidates.push(candidate);
      }
      if (refreshClockChanged) await chrome.storage.local.set({lastRefreshByTab,lastPeriodicRefreshByTab});
      candidates.sort((a, b) => force || test ? a.lastRefresh - b.lastRefresh : a.lastGood - b.lastGood);
      periodicCandidates.sort((a, b) =>
        Number(lastPeriodicRefreshByTab[a.tab.id]) - Number(lastPeriodicRefreshByTab[b.tab.id]));
      const selected = force || test ? candidates[0]
        : !recoveryOnly && periodicCandidates[0] || candidates[0];
      if (selected) {
        const periodicSelected = !force && !test && selected === periodicCandidates[0];
        selectedRecovery = !periodicSelected;
        const {tab, channelId, health} = selected;
        const recoveryAlert = !periodicSelected && !force && !test && selected.scanStale
          && (selected.lastScan > 0 || selected.lastGood > 0);
        const incidentStartedAt = recoveryAlert ? Number(health.incidentStartedAt || startedAt)
          : periodicSelected ? 0 : Number(health.incidentStartedAt || 0);
        const attempt = periodicSelected || force ? 0 : Math.min(Number(health.attempt || 0) + 1, 100);
        const nextAttemptAt = periodicSelected || force || test ? 0 : startedAt + recoveryRetryMs;
        const triggerCode = periodicSelected ? 'SCHEDULED' : tab.discarded ? 'TAB_DISCARDED'
          : 'POLL_FAILURE_AND_SCAN_STALE';
        const key = healthKey(tab.id);
        try {
          const {pendingRefresh = {}} = await chrome.storage.local.get('pendingRefresh');
          pendingRefresh[tab.id] = channelId;
          lastRefreshByTab[tab.id] = startedAt;
          if (periodicSelected) lastPeriodicRefreshByTab[tab.id] = startedAt;
          await chrome.storage.local.set({pendingRefresh, lastRefreshByTab,lastPeriodicRefreshByTab,
            lastRefreshRequested: [channelId], [key]: {...health,channelId,status:'recovering',
              attempt,requestedAt:startedAt,loadedAt:0,nextAttemptAt,error:'',
              testRunId:test ? refreshTestMode.runId : 0,
              incidentStartedAt,outcomeNotifiedAt:periodicSelected ? 0 : Number(health.outcomeNotifiedAt || 0),
              recoveryPausedUntil:periodicSelected ? 0 : Number(health.recoveryPausedUntil || 0),
              failedAttempts:incidentStartedAt === Number(health.incidentStartedAt || 0)
                ? Number(health.failedAttempts || 0) : 0,
              failedRequestAt:incidentStartedAt === Number(health.incidentStartedAt || 0)
                ? Number(health.failedRequestAt || 0) : 0,
              baselineMessageId:health.lastSeenMessageId || '',
              liveFloorAt:Number(health.lastGoodAt || startedAt),liveVerifiedAt:0}});
          await queueDiagnostic(test ? 'TEST_RELOAD_REQUESTED' : force ? 'MANUAL_RELOAD_REQUESTED'
            : periodicSelected ? 'PERIODIC_RELOAD_REQUESTED'
            : health.incidentStartedAt ? 'RECOVERY_RETRY_REQUESTED' : 'RECOVERY_STARTED',
            diagnosticHealth(tab,channelId,health,{incident_at:incidentStartedAt || null,
              attempt,requested_at:startedAt,next_attempt_at:nextAttemptAt || null,
              detail:{trigger_code:triggerCode,discarded:tab.discarded,
                poll_failures:Number(selected.poll.consecutiveFailures || 0),
                failed_attempts:Number(health.failedAttempts || 0)}}));
          await chrome.tabs.reload(tab.id);
          if (test) await chrome.storage.local.set({refreshTestMode:{...refreshTestMode,
            seenTabIds:[...(refreshTestMode.seenTabIds || []),tab.id]}});
          await updateRefreshHistory(tab.id,{channelId,requestedAt:startedAt,loadedAt:0,recoveredAt:0,
            reason:test ? '测试' : force ? '手动' : periodicSelected ? '定时巡检' : '异常恢复'});
          requested.push(channelId);
        } catch (error) {
          const failedAttempts = incidentStartedAt ? Number(health.failedAttempts || 0) + 1 : 0;
          const shouldAlert = incidentStartedAt && failedAttempts >= 2 && !health.outcomeNotifiedAt;
          await chrome.storage.local.set({[key]: {...health,channelId,status:'failed',attempt,
            requestedAt:startedAt,incidentStartedAt,nextAttemptAt,error:String(error),
            recoveryPausedUntil:failedAttempts >= 2 ? startedAt + recoveryPauseMs : 0,
            failedAttempts,failedRequestAt:incidentStartedAt ? startedAt : 0,
            outcomeNotifiedAt:shouldAlert ? startedAt : Number(health.outcomeNotifiedAt || 0)}});
          await queueDiagnostic(incidentStartedAt ? 'RECOVERY_RELOAD_FAILED' : 'RELOAD_FAILED',
            diagnosticHealth(tab,channelId,health,{incident_at:incidentStartedAt || null,
              attempt,requested_at:startedAt,next_attempt_at:nextAttemptAt || null,error:String(error),
              detail:{failed_attempts:failedAttempts}}));
          const {pendingRefresh = {}} = await chrome.storage.local.get('pendingRefresh');
          delete pendingRefresh[tab.id];
          await chrome.storage.local.set({pendingRefresh});
          errors.push(`${channelId}: ${String(error)}`);
          if (test) {
            await chrome.storage.local.set({refreshTestMode:{...refreshTestMode,
              seenTabIds:[...(refreshTestMode.seenTabIds || []),tab.id]}});
            await queueRecoveryAlert({channelId,requestedAt:startedAt,attempt,status:'test_failed'});
          }
          if (shouldAlert) {
            await queueRecoveryAlert({channelId,requestedAt:incidentStartedAt,attempt,status:'failed'});
          }
        }
      } else if (test) {
        await chrome.storage.local.set({refreshTestMode:{...refreshTestMode,enabled:false,nextAt:0}});
      }
      const currentHealth = await chrome.storage.local.get(tabs.flatMap(tab =>
        [healthKey(tab.id),pollKey(tab.id)]));
      const details = tabs.filter(tab => allowedChannels.includes(channelFromUrl(tab.url)))
        .map(tab => {
          const health = currentHealth[healthKey(tab.id)] || {};
          const poll = currentHealth[pollKey(tab.id)] || {};
          const heartbeat = Math.max(Number(health.lastScanAt || 0),
            Number(poll.lastSuccessAt || 0));
          const healthy = !tab.discarded && heartbeat > 0
            && startedAt - heartbeat < scanStaleAfterMs
            && Number(poll.consecutiveFailures || 0) < 2;
          return {tabId:tab.id,channelId:channelFromUrl(tab.url),
            status:health.status === 'recovering' && startedAt < Number(health.nextAttemptAt || 0)
              ? 'recovering' : healthy ? 'healthy' : 'failed',
            attempt:Number(health.attempt || 0),lastGoodAt:Number(health.lastGoodAt || 0),
            liveVerifiedAt:Number(health.liveVerifiedAt || 0),
            error:health.error || ''};
        });
      await chrome.storage.local.set({watchdogStatus:{checkedAt:startedAt,details}});
      const failed = details.filter(item => item.status === 'failed').length;
      const recovering = details.filter(item => item.status === 'recovering').length;
      await chrome.action.setBadgeText({text:failed ? String(failed) : recovering ? '…' : ''});
      if (failed || recovering) await chrome.action.setBadgeBackgroundColor({color:failed ? '#b42318' : '#b7791f'});
    } catch (error) {
      errors.push(String(error));
      await queueDiagnostic('PATROL_FAILED',{error:String(error)});
    }
    await chrome.storage.local.set({lastRefreshRequested: requested, lastRefreshError: errors.join('; ')});
  } finally { refreshing = false; }
  return selectedRecovery;
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  (async () => {
    const {pendingRefresh = {}, lastRefreshCompleted = []} = await chrome.storage.local.get(['pendingRefresh', 'lastRefreshCompleted']);
    const channelId = pendingRefresh[tabId];
    if (!channelId) return;
    delete pendingRefresh[tabId];
    const key = healthKey(tabId);
    const health = (await chrome.storage.local.get(key))[key] || {};
    const loadedAt = Date.now();
    await chrome.storage.local.set({pendingRefresh, lastRefreshCompleted: [...lastRefreshCompleted, channelId],
      [key]: {...health,loadedAt,nextAttemptAt:health.incidentStartedAt
        ? loadedAt + recoveryRetryMs : Number(health.nextAttemptAt || 0)}});
    await updateRefreshHistory(tabId,{requestedAt:health.requestedAt,loadedAt});
    await queueDiagnostic(health.incidentStartedAt ? 'RECOVERY_LOAD_COMPLETED' : 'RELOAD_LOAD_COMPLETED',
      diagnosticHealth({id:tabId},channelId,health,{loaded_at:loadedAt,
        detail:{test:!!health.testRunId}}));
    if (health.testRunId) await queueRecoveryAlert({channelId,requestedAt:health.requestedAt,
      attempt:health.attempt,status:'test_refreshed'});
  })().catch(error => console.error('Tab load confirmation:', error));
});
const pageStatusMutations = new Map();
function runPageStatus(tabId, work) {
  const previous = pageStatusMutations.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  pageStatusMutations.set(tabId,current);
  current.finally(() => {
    if (pageStatusMutations.get(tabId) === current) pageStatusMutations.delete(tabId);
  }).catch(() => {});
  return current;
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'capture') enqueue(request.message);
  if (request.type === 'scanProgress' && sender.tab?.id != null
      && channelFromUrl(sender.tab.url) === request.channel_id) {
    const pending = pollScanProgress.get(sender.tab.id);
    if (pending?.request_id === request.request_id
        && ['received','config_wait','dom_scan','complete','error'].includes(request.stage)) {
      Object.assign(pending,{stage:request.stage,progress_at:Date.now(),
        page_at:Number(request.at || 0),visibility:String(request.visibility || '').slice(0,20)});
    }
  }
  if (request.type === 'imageNodeGap' && channelFromUrl(sender.tab?.url) === request.channelId
    && /^\d{15,22}$/.test(request.sourceId || '')) {
    queueDiagnostic('IMAGE_NODE_SKIPPED',{channel_id:request.channelId,
      source_message_id:request.sourceId,detail:request.detail});
  }
  if (request.type === 'pageStatus') {
    const tabId = sender.tab?.id;
    runPageStatus(tabId,async () => {
      const update = {pageStatus: request};
      if (tabId != null && request.allowed && channelFromUrl(sender.tab.url) === request.channel_id) {
        const key = healthKey(tabId);
        const health = (await chrome.storage.local.get(key))[key] || {};
        const scannedAt = Number(request.at || Date.now());
        const hasContent = Number(request.extracted || 0) > 0;
        const latestSourceId = /^\d+$/.test(String(request.latestSourceId || ''))
          ? String(request.latestSourceId) : '';
        const priorMessageId = String(health.lastSeenMessageId || '');
        const liveFloorAt = Number(health.liveFloorAt || scannedAt);
        const sourceCreatedAt = latestSourceId
          ? Number((BigInt(latestSourceId) >> 22n) + 1420070400000n) : 0;
        const isNewMessage = latestSourceId && priorMessageId
          && BigInt(latestSourceId) > BigInt(priorMessageId)
          && sourceCreatedAt >= liveFloorAt - 120000;
        const recovered = hasContent && (health.status !== 'recovering'
          || Number(health.loadedAt || 0) >= Number(health.requestedAt || 0)
            && scannedAt >= Number(health.loadedAt || 0));
        update[key] = {...health,channelId:request.channel_id,lastScanAt:scannedAt,
          lastGoodAt:hasContent ? scannedAt : Number(health.lastGoodAt || 0),
          liveFloorAt,
          lastSeenMessageId:isNewMessage || !priorMessageId ? latestSourceId || priorMessageId : priorMessageId,
          liveVerifiedAt:isNewMessage ? scannedAt : Number(health.liveVerifiedAt || 0),
          status:recovered ? 'healthy' : health.status || 'waiting',
          attempt:recovered ? 0 : Number(health.attempt || 0),
          nextAttemptAt:recovered ? 0 : Number(health.nextAttemptAt || 0),
          error:recovered ? '' : health.error || '',
          incidentStartedAt:recovered ? 0 : Number(health.incidentStartedAt || 0),
          outcomeNotifiedAt:recovered ? 0 : Number(health.outcomeNotifiedAt || 0),
          failedAttempts:recovered ? 0 : Number(health.failedAttempts || 0),
          failedRequestAt:recovered ? 0 : Number(health.failedRequestAt || 0),
          recoveryPausedUntil:recovered ? 0 : Number(health.recoveryPausedUntil || 0)};
        const pkey = pollKey(tabId);
        const poll = (await chrome.storage.local.get(pkey))[pkey] || {};
        update[pkey] = {...poll,lastSuccessAt:scannedAt,consecutiveFailures:0,error:''};
        if (recovered && health.status === 'recovering') {
          await updateRefreshHistory(tabId,{requestedAt:health.requestedAt,recoveredAt:scannedAt});
        }
        await chrome.storage.local.set(update);
        if (request.scan_trace?.request_id) await queueDiagnostic('SCAN_COMPLETED',{
          channel_id:request.channel_id,tab_id:tabId,
          detail:{...request.scan_trace,extracted:Number(request.extracted || 0)}});
        if (recovered && (health.status === 'recovering' || health.incidentStartedAt)) {
          await queueDiagnostic(health.incidentStartedAt ? 'RECOVERY_SCAN_RESTORED' : 'RELOAD_SCAN_RESTORED',
            diagnosticHealth({id:tabId},request.channel_id,health,{
              detail:{extracted:request.extracted,latest_source_id:latestSourceId,
                new_message_seen:!!isNewMessage,
                failed_attempts:Number(health.failedAttempts || 0)}}));
        }
        if (recovered && health.incidentStartedAt && health.outcomeNotifiedAt) await queueRecoveryAlert({channelId:request.channel_id,
          requestedAt:health.incidentStartedAt,attempt:health.attempt,status:'recovered'});
      }
    }).catch(error => console.error('Page status:', error));
  }
  if (request.type === 'refreshNow') {
    refreshMonitoredTabs(true).then(() => sendResponse({ok:true})).catch(error => sendResponse({ok:false,error:String(error)}));
    return true;
  }
  if (request.type === 'setRefreshTestMode') {
    chrome.storage.local.set({refreshTestMode:{enabled:request.enabled === true,
      nextAt:request.enabled === true ? Date.now() + 10000 : 0,
      runId:request.enabled === true ? Date.now() : 0,seenTabIds:[]}})
      .then(() => sendResponse({ok:true})).catch(error => sendResponse({ok:false,error:String(error)}));
    return true;
  }
  if (request.type === 'refreshTestTick') {
    (async () => {
      const {refreshTestMode = {}} = await chrome.storage.local.get('refreshTestMode');
      if (!refreshTestMode.enabled || Date.now() < Number(refreshTestMode.nextAt || 0)) return;
      await chrome.storage.local.set({refreshTestMode:{...refreshTestMode,nextAt:Date.now() + 10000}});
      await refreshMonitoredTabs(false,true);
    })().then(() => sendResponse({ok:true})).catch(error => sendResponse({ok:false,error:String(error)}));
    return true;
  }
  if (['recoveryPreview','recoveryQueue','recoveryStatus','recoveryCancel','forwardingStatus','forwardingPause'].includes(request.type)) {
    (async () => {
      try {
        const currentChannel = sender.tab?.url?.match(/^https:\/\/discord\.com\/channels\/(?:\d+|@me)\/(\d+)(?:[/?#]|$)/)?.[1];
        if (!currentChannel || currentChannel !== request.channelId) throw Error('当前标签页频道不匹配');
        const {token = '',allowedChannels = []} = await chrome.storage.local.get(['token','allowedChannels']);
        if (!token || !allowedChannels.includes(currentChannel)) throw Error('当前频道未启用采集');
        const headers = {'X-Collector-Token':token};
        let url, options = {headers};
        if (request.type === 'forwardingStatus') {
          const query = new URLSearchParams({channel_id:currentChannel});
          url = `http://127.0.0.1:8765/v1/forwarding/status?${query}`;
        } else if (request.type === 'forwardingPause') {
          url = 'http://127.0.0.1:8765/v1/forwarding/pause';
          options = {method:'POST',headers:{...headers,'Content-Type':'application/json'},
            body:JSON.stringify({channel_id:currentChannel,paused:request.paused})};
        } else if (request.type === 'recoveryPreview') {
          const query = new URLSearchParams({channel_id:currentChannel,group:String(request.group || '1'),limit:'20'});
          url = `http://127.0.0.1:8765/v1/recovery/preview?${query}`;
        } else if (request.type === 'recoveryQueue' || request.type === 'recoveryCancel') {
          url = `http://127.0.0.1:8765/v1/recovery/${request.type === 'recoveryQueue' ? 'queue' : 'cancel'}`;
          options = {method:'POST',headers:{...headers,'Content-Type':'application/json'},
            body:JSON.stringify({channel_id:currentChannel,group:request.group,selected:request.selected})};
        } else {
          const query = new URLSearchParams({request_id:String(request.requestId)});
          url = `http://127.0.0.1:8765/v1/recovery/status?${query}`;
        }
        const response = await fetch(url,{...options,signal:AbortSignal.timeout(12000)});
        const body = await response.json();
        if (!response.ok) throw Error(body.error || `HTTP ${response.status}`);
        sendResponse({ok:true,...body});
      } catch (error) { sendResponse({ok:false,error:String(error.message || error)}); }
    })();
    return true;
  }
  if (request.type === 'lookupMinute') {
    (async () => {
      try {
        const {token = ''} = await chrome.storage.local.get('token');
        if (!token) throw new Error('未配置本地采集令牌');
        const query = new URLSearchParams({channel_id:request.channelId, local_minute:request.localMinute});
        const response = await fetch(`http://127.0.0.1:8765/v1/messages/status?${query}`, {
          headers:{'X-Collector-Token':token}, signal:AbortSignal.timeout(12000)
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        sendResponse({ok:true, messages:body.messages});
      } catch (error) { sendResponse({ok:false, error:String(error.message || error)}); }
    })();
    return true;
  }
});
async function ensureAlarms() {
  if (!chrome.alarms?.get) return;
  for (const name of ['retry','refresh','poll']) {
    if (!await chrome.alarms.get(name)) await chrome.alarms.create(name,{periodInMinutes:1});
  }
}
let pollRunning = false;
async function pollMonitoredTabs() {
  if (pollRunning) return;
  pollRunning = true;
  try {
  const {allowedChannels = [],token = ''} = await chrome.storage.local.get(['allowedChannels','token']);
  if (!allowedChannels.length) return;
  const tabs = await chrome.tabs.query({url:'https://discord.com/channels/*'});
  const monitored = tabs.filter(tab => tab.id != null && allowedChannels.includes(channelFromUrl(tab.url)));
  const records = await chrome.storage.local.get(monitored.map(tab => pollKey(tab.id)));
  for (let index = 0; index < monitored.length; index += 3) {
    await Promise.all(monitored.slice(index,index + 3).map(async tab => {
      const startedAt = Date.now();
      const requestId = crypto.randomUUID();
      const progress = {request_id:requestId,stage:'request_sent',progress_at:startedAt};
      pollScanProgress.set(tab.id,progress);
      const result = await new Promise(resolve => {
        const timer = setTimeout(() => resolve({error:'scan response timeout'}),12000);
        chrome.tabs.sendMessage(tab.id,{type:'pollScan',channelId:channelFromUrl(tab.url),
          requestId,requestedAt:startedAt})
          .then(value => { clearTimeout(timer); resolve(value); })
          .catch(error => { clearTimeout(timer); resolve({error:String(error)}); });
      });
      const key = pollKey(tab.id);
      const prior = (await chrome.storage.local.get(key))[key] || records[key] || {};
      const success = result?.allowed === true && !result.error;
      const current = {lastAttemptAt:startedAt,latencyMs:Date.now() - startedAt,
        lastSuccessAt:success ? Date.now() : Number(prior.lastSuccessAt || 0),
        consecutiveFailures:success ? 0 : Number(prior.consecutiveFailures || 0) + 1,
        error:success ? '' : String(result?.error || 'scan response invalid').slice(0,200)};
      records[key] = current;
      await chrome.storage.local.set({[key]:current});
      pollScanProgress.delete(tab.id);
      const detail = {request_id:requestId,requested_at:startedAt,
        extension_version:chrome.runtime.getManifest?.().version || '',
        latency_ms:current.latencyMs,error:current.error,last_stage:progress.stage,
        progress_at:progress.progress_at,page_at:progress.page_at || null,
        visibility:progress.visibility || '',extracted:Number(result?.extracted || 0),
        discarded:!!tab.discarded,loading:tab.status === 'loading'};
      await queueDiagnostic('POLL_SCAN_RESULT',{
        channel_id:channelFromUrl(tab.url),tab_id:tab.id,detail});
      if (current.consecutiveFailures === 2) await queueDiagnostic('POLL_SCAN_UNRESPONSIVE',{
        channel_id:channelFromUrl(tab.url),tab_id:tab.id,
        detail});
    }));
  }
  const healthRecords = await chrome.storage.local.get(monitored.map(tab => healthKey(tab.id)));
  const scanning = monitored.filter(tab => {
    const poll = records[pollKey(tab.id)] || {};
    const health = healthRecords[healthKey(tab.id)] || {};
    const heartbeat = Math.max(Number(poll.lastSuccessAt || 0),Number(health.lastScanAt || 0));
    return heartbeat > 0 && Date.now() - heartbeat < scanStaleAfterMs;
  }).map(tab => channelFromUrl(tab.url));
  if (!token) return;
  try {
    const response = await fetch('http://127.0.0.1:8765/v1/collector/page-status',{
      method:'POST',headers:{'Content-Type':'application/json','X-Collector-Token':token},
      body:JSON.stringify({enabled:allowedChannels,
        open:[...new Set(monitored.map(tab => channelFromUrl(tab.url)))],
        scanning:[...new Set(scanning)]}),signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    await chrome.storage.local.set({lastPageStatusError:''});
  } catch (error) {
    await chrome.storage.local.set({lastPageStatusError:String(error)});
  }
  } finally { pollRunning = false; }
}
ensureAlarms().catch(error => console.error('Alarm setup:',error));
chrome.runtime.onStartup?.addListener(() => ensureAlarms().catch(error => console.error('Alarm startup:',error)));
chrome.runtime.onInstalled?.addListener(() => ensureAlarms().catch(error => console.error('Alarm install:',error)));
chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name === 'poll') pollMonitoredTabs().catch(error => console.error('Tab poll:',error));
  if (alarm.name === 'retry') {
    flush().catch(error => console.error('Queue retry:', error));
    flushRecoveryAlerts().catch(error => console.error('Recovery alert retry:', error));
    flushDiagnostics().catch(error => console.error('Diagnostic retry:', error));
  }
  if (alarm.name === 'refresh') chrome.storage.local.get('refreshTestMode').then(async data => {
    const mode = data.refreshTestMode || {};
    if (mode.enabled && Date.now() <= Number(mode.nextAt || 0) + 20000) return;
    if (mode.enabled) await chrome.storage.local.set({refreshTestMode:{enabled:false,nextAt:0}});
    let recovered = await refreshMonitoredTabs();
    for (let index = 1; index < 3 && recovered; index++) {
      recovered = await refreshMonitoredTabs(false,false,true);
    }
  }).catch(error => console.error('Tab refresh:', error));
});
setInterval(flush, 30000);

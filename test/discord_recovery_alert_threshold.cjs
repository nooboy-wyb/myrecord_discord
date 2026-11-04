const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const channelId = '1439232860014907412';
const tabId = 7;
let clockMs = Date.now();
class ClockDate extends Date { static now() { return clockMs; } }
const state = new Map([
  ['token','test-token'],['allowedChannels',[channelId]],
  ['periodicScheduleVersion',1],['recoveryRetryVersion',3],
  ['lastRefreshByTab',{[tabId]:clockMs - 3 * 60_000}],
  [`poll:${tabId}`,{lastSuccessAt:clockMs - 3 * 60_000,consecutiveFailures:2}],
  [`health:${tabId}`,{channelId,status:'recovering',attempt:1,
    incidentStartedAt:clockMs - 3 * 60_000,requestedAt:clockMs - 2 * 60_000 - 1,
    nextAttemptAt:clockMs - 1,lastScanAt:clockMs - 3 * 60_000,
    lastGoodAt:clockMs - 3 * 60_000,outcomeNotifiedAt:0}]
]);
const alerts = [];
let onMessage;
const chrome = {
  storage:{local:{
    get:async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .filter(key => state.has(key)).map(key => [key,state.get(key)])),
    set:async changes => { for (const [key,value] of Object.entries(changes)) state.set(key,value); }
  }},
  tabs:{query:async()=>[{id:tabId,url:`https://discord.com/channels/1/${channelId}`,
    active:true,windowId:1,discarded:false}],reload:async()=>{},onUpdated:{addListener(){}}},
  windows:{getAll:async()=>[{id:1,focused:true}]},
  runtime:{onMessage:{addListener(listener){onMessage=listener;}},
    onStartup:{addListener(){}},onInstalled:{addListener(){}}},
  alarms:{get:async()=>({}),create:async()=>{},onAlarm:{addListener(){}}},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}
};
const context = vm.createContext({chrome,console,crypto,Date:ClockDate,URL,URLSearchParams,BigInt,Buffer,
  setInterval(){},setTimeout(){},fetch:async(url,options)=>{
    if (url.endsWith('/recovery-alert')) alerts.push(JSON.parse(options.body));
    return {ok:true};
  }});
vm.runInContext(fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8'),context);

(async()=>{
  await vm.runInContext('refreshMonitoredTabs()',context);
  assert.equal(state.get(`health:${tabId}`).failedAttempts,1);
  assert.equal(alerts.length,0,'first failed attempt should be logged without a QQ alert');
  const firstRetry = state.get(`health:${tabId}`);
  state.set(`health:${tabId}`,{...firstRetry,loadedAt:firstRetry.requestedAt + 1000});
  onMessage({type:'pageStatus',allowed:true,channel_id:channelId,at:firstRetry.requestedAt + 2000,extracted:4},
    {tab:{id:tabId,url:`https://discord.com/channels/1/${channelId}`}},()=>{});
  for (let i=0; i<20 && state.get(`health:${tabId}`).status !== 'healthy'; i++)
    await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.get(`health:${tabId}`).status,'healthy');
  assert.equal(alerts.length,0,'recovery before two failures should stay in logs only');

  const nextIncident = clockMs + 10 * 60_000;
  clockMs = nextIncident + 3 * 60_000;
  state.set(`health:${tabId}`,{channelId,status:'recovering',attempt:1,
    incidentStartedAt:nextIncident,requestedAt:clockMs - 2 * 60_000 - 1,
    nextAttemptAt:clockMs - 1,lastScanAt:nextIncident,lastGoodAt:nextIncident,
    outcomeNotifiedAt:0});
  state.set(`poll:${tabId}`,{lastSuccessAt:nextIncident,consecutiveFailures:2});
  await vm.runInContext('refreshMonitoredTabs()',context);
  assert.equal(alerts.length,0);
  clockMs += 60_000 + 1;
  await vm.runInContext('refreshMonitoredTabs()',context);
  assert.equal(state.get(`health:${tabId}`).failedAttempts,2);
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].status,'timeout');
  assert.equal(alerts[0].attempt,2);
  console.log('QQ recovery alert waits for two failed attempts; early success stays in diagnostics.');
})().catch(error=>{console.error(error);process.exitCode=1;});

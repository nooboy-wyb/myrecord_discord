const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
let clock=Date.now(), pollError='', reloads=0;
class FakeDate extends Date { static now(){return clock;} }
const channel='1222944235691708477';
const tab={id:1,url:`https://discord.com/channels/1/${channel}`,active:false,discarded:false};
const data={token:'test',allowedChannels:[channel],lastRefreshByTab:{1:clock},periodicScheduleVersion:1,recoveryRetryVersion:3,
  'health:1':{lastScanAt:clock,lastGoodAt:clock,status:'healthy'},'poll:1':{lastSuccessAt:clock,consecutiveFailures:0}};
const reports=[], noop=()=>{};
const local={async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,structuredClone(data[k])]));},
  async set(v){Object.assign(data,structuredClone(v));}};
const chrome={storage:{local},tabs:{query:async()=>[tab],sendMessage:async()=>pollError?{error:pollError}:{allowed:true,extracted:1},
  reload:async()=>{reloads++;},onUpdated:{addListener:noop}},alarms:{get:async()=>({}),create:noop,onAlarm:{addListener:noop}},
  runtime:{onMessage:{addListener:noop},onStartup:{addListener:noop},onInstalled:{addListener:noop}},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
const ctx=vm.createContext({chrome,console,crypto:webcrypto,setInterval:noop,setTimeout,clearTimeout,AbortSignal,
  Date:FakeDate,URL,URLSearchParams,BigInt,Buffer,fetch:async(_url,opts)=>{reports.push(JSON.parse(opts.body));return {ok:true};}});
vm.runInContext(fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8'),ctx);
const poll=vm.runInContext('pollMonitoredTabs',ctx), patrol=vm.runInContext('refreshMonitoredTabs',ctx);
(async()=>{
  await poll();
  assert.deepEqual(reports.at(-1),{enabled:[channel],open:[channel],scanning:[channel]});
  pollError='unresponsive'; clock+=60_000; await poll(); await patrol();
  assert.equal(reloads,0,'one failed poll does not reload');
  tab.active=true; clock+=60_000; await poll(); await patrol();
  assert.equal(reloads,1,'two failed polls and stale heartbeat recover any tab');
  assert.deepEqual(reports.filter(x=>Array.isArray(x.scanning)).at(-1).scanning,[]);
  clock+=60_000; await patrol(); assert.equal(reloads,2,'one retry after timeout');
  clock+=60_000; await patrol(); assert.equal(reloads,2,'second failure stops rapid retry');
  assert.equal(data['health:1'].failedAttempts,2);
  clock+=25*60_000; await patrol();
  assert.equal(reloads,2,'recovery refresh does not advance fixed schedule');
  clock+=60_000; await patrol();
  assert.equal(reloads,3,'30-minute refresh runs independently');
  assert.equal(data.refreshHistory[0].reason,'定时巡检');
  assert.equal(data['health:1'].incidentStartedAt,0);
  console.log('Uniform polling, bounded recovery and periodic refresh verified.');
})().catch(e=>{console.error(e);process.exitCode=1;});

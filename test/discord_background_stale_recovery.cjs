const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
let clock=Date.now(), reloads=0;
class FakeDate extends Date { static now(){return clock;} }
const channel='1254782508793593947';
const tab={id:1,url:`https://discord.com/channels/1/${channel}`,active:false,discarded:false};
const data={token:'test',allowedChannels:[channel],lastRefreshByTab:{1:clock-20*60_000},periodicScheduleVersion:1,recoveryRetryVersion:3,
  'health:1':{lastScanAt:clock-3*60_000,lastGoodAt:clock-3*60_000,status:'healthy'},
  'poll:1':{lastSuccessAt:clock-3*60_000,consecutiveFailures:2}};
const noop=()=>{};
const local={async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,structuredClone(data[k])]));},
  async set(v){Object.assign(data,structuredClone(v));}};
const chrome={storage:{local},tabs:{query:async()=>[tab],reload:async()=>{reloads++;},onUpdated:{addListener:noop}},
  alarms:{get:async()=>({}),create:noop,onAlarm:{addListener:noop}},runtime:{onMessage:{addListener:noop},onStartup:{addListener:noop},onInstalled:{addListener:noop}},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
const ctx=vm.createContext({chrome,console,crypto:webcrypto,setInterval:noop,setTimeout,clearTimeout,AbortSignal,
  Date:FakeDate,URL,URLSearchParams,BigInt,Buffer,fetch:async()=>({ok:true})});
vm.runInContext(fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8'),ctx);
const patrol=vm.runInContext('refreshMonitoredTabs',ctx);
(async()=>{
  await patrol(); assert.equal(reloads,1);
  clock+=60_000; data['health:1'].loadedAt=clock-10_000;
  await patrol(); assert.equal(reloads,1,'loaded page has a full minute to scan');
  clock+=50_000; await patrol(); assert.equal(reloads,2);
  console.log('Background page uses uniform failure rule and load grace period.');
})().catch(e=>{console.error(e);process.exitCode=1;});

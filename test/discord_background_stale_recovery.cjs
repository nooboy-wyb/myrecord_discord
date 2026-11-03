const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const channelId = '1254782508793593947';
let now = Date.now();
class FakeDate extends Date { static now() { return now; } }
const tab = {id:1,url:`https://discord.com/channels/1222459489333018634/${channelId}`,
  windowId:1,active:false,discarded:false};
const data = {token:'test',allowedChannels:[channelId],lastRefreshByTab:{1:now-20*60_000},
  periodicScheduleVersion:1,recoveryRetryVersion:3,
  'health:1':{lastScanAt:now-3*60_000,lastGoodAt:now-3*60_000,status:'healthy'}};
const reloads = [];
const noop = () => {};
const local = {
  async get(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter(key=>key in data).map(key=>[key,structuredClone(data[key])]));
  },
  async set(values) { Object.assign(data,structuredClone(values)); }
};
const chrome = {storage:{local},tabs:{query:async()=>[tab],reload:async id=>reloads.push(id),
  sendMessage:async()=>({allowed:true,extracted:1}),onUpdated:{addListener:noop}},
  alarms:{get:async()=>({}),create:noop,onAlarm:{addListener:noop}},
  windows:{getAll:async()=>[{id:1,focused:true}]},
  runtime:{onMessage:{addListener:noop},onStartup:{addListener:noop},onInstalled:{addListener:noop}},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
const context = vm.createContext({chrome,console,crypto:webcrypto,setInterval:noop,setTimeout,clearTimeout,
  AbortSignal,Date:FakeDate,URL,URLSearchParams,BigInt,Buffer,fetch:async()=>({ok:true})});
vm.runInContext(fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8'),context);
const patrol = vm.runInContext('refreshMonitoredTabs',context);

(async()=>{
  assert.equal(await patrol(),true);
  assert.deepEqual(reloads,[1],'an inactive tab with no scan heartbeat must recover before 30 minutes');
  assert.equal(data['health:1'].incidentStartedAt,now);
  assert.equal(data.refreshHistory[0].reason,'异常恢复');
  assert.equal(await patrol(),false,'the same tab must wait for its one-minute retry');
  assert.deepEqual(reloads,[1]);
  now += 60_000;
  assert.equal(await patrol(),true);
  assert.deepEqual(reloads,[1,1]);
  console.log('Inactive Discord pages recover after a stale scan heartbeat.');
})().catch(error=>{console.error(error);process.exitCode=1;});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const channelId = '1222944235691708477';
const now = Date.now();
let clock = now;
class FakeDate extends Date { static now() { return clock; } }
const data = {token:'test',allowedChannels:[channelId],lastRefreshByTab:{1:now},
  'health:1':{lastScanAt:now-5*60_000,lastGoodAt:now-5*60_000,status:'healthy'}};
const tab = {id:1,url:`https://discord.com/channels/1222459489333018634/${channelId}`,
  windowId:1,active:false,discarded:false};
let reloads = 0;
const polls = [];
let windowFocused = true;
const noop = () => {};
const local = {
  async get(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter(key=>key in data).map(key=>[key,structuredClone(data[key])]));
  },
  async set(values) { Object.assign(data,structuredClone(values)); }
};
const chrome = {storage:{local},tabs:{query:async()=>[tab,{id:2,url:'https://discord.com/channels/1/999999999999999999',active:false}],
  sendMessage:async(id,message)=>{polls.push({id,message});},reload:async()=>{reloads++;},
  onUpdated:{addListener:noop}},alarms:{get:async()=>({}),create:noop,onAlarm:{addListener:noop}},
  windows:{getAll:async()=>[{id:1,focused:windowFocused}]},
  runtime:{onMessage:{addListener:noop},onStartup:{addListener:noop},onInstalled:{addListener:noop}},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
const context = vm.createContext({chrome,console,crypto:webcrypto,setInterval:noop,Date:FakeDate,URL,URLSearchParams,BigInt,Buffer,
  fetch:async()=>({ok:true})});
vm.runInContext(fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8'),context);

(async()=>{
  const poll = vm.runInContext('pollMonitoredTabs',context);
  await poll();
  assert.equal(polls.length,1,'minute poll should target only enabled Discord tabs');
  assert.equal(polls[0].id,tab.id);
  assert.equal(polls[0].message.type,'pollScan');
  assert.equal(polls[0].message.channelId,channelId);
  assert.equal(reloads,0,'minute poll must not reload the page');
  const patrol = vm.runInContext('refreshMonitoredTabs',context);
  await patrol();
  assert.equal(reloads,0,'inactive background tab must wait for its periodic refresh');
  tab.active = true;
  windowFocused = false;
  await patrol();
  assert.equal(reloads,0,'selected tab in an unfocused Edge window must not trigger early recovery');
  windowFocused = true;
  await patrol();
  assert.equal(reloads,1,'stalled active tab should recover immediately');
  data.refreshTestMode = {enabled:true,nextAt:0,runId:123,seenTabIds:[]};
  tab.active = false;
  await patrol(false,true);
  assert.equal(reloads,2);
  assert.deepEqual(data.refreshTestMode.seenTabIds,[1]);
  await patrol(false,true);
  assert.equal(reloads,2,'one-pass test must not reload the same tab twice');
  assert.equal(data.refreshTestMode.enabled,false,'one-pass test should stop automatically');
  data['health:1'] = {lastScanAt:clock,lastGoodAt:clock,status:'healthy'};
  data.lastRefreshByTab = {1:clock};
  for (const [index,minutes] of [30,30,30,30,30,30].entries()) {
    clock += (minutes - 1) * 60_000;
    await patrol();
    assert.equal(reloads,2 + index,`periodic refresh ${index + 1} must wait ${minutes} minutes`);
    clock += 60_000;
    if (index === 5) tab.discarded = true;
    await patrol();
    assert.equal(reloads,3 + index,`periodic refresh ${index + 1} is due`);
    assert.equal(data.refreshHistory[0].reason,'定时巡检');
    assert.equal(data['health:1'].incidentStartedAt,0,'periodic refresh must not start an incident');
  }
  tab.discarded = false;
  tab.active = true;
  clock += 60_000;
  await patrol();
  assert.equal(reloads,9,'active stalled page should recover without waiting for the 30-minute schedule');
  assert.ok(data['health:1'].incidentStartedAt);
  clock += 30_000;
  await patrol();
  assert.equal(reloads,9,'failed recovery should wait for its fixed one-minute retry');
  clock += 30_000;
  await patrol();
  assert.equal(reloads,10,'failed recovery retries after one minute');
  assert.equal(data['health:1'].nextAttemptAt,clock + 60_000);
  data.recoveryRetryVersion = 2;
  data['health:1'] = {...data['health:1'],status:'recovering',
    incidentStartedAt:clock - 3 * 60_000,requestedAt:clock - 3 * 60_000,
    nextAttemptAt:clock + 7 * 60_000};
  await patrol();
  assert.equal(reloads,11,'old ten-minute recovery wait should shrink on upgrade');
  assert.equal(data.recoveryRetryVersion,3);
  console.log('Patrol keeps active recovery separate from the fixed 30-minute periodic schedule.');
})().catch(error=>{console.error(error);process.exitCode=1;});

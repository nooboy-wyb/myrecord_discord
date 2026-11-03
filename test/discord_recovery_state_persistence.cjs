const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const channelId = '1405206823727796408';
const tabId = 7;
const now = Date.now();
const incidentAt = now - 3 * 60_000;
const values = new Map([
  ['token','test-token'],
  [`health:${tabId}`,{channelId,status:'recovering',incidentStartedAt:incidentAt,
    requestedAt:incidentAt,loadedAt:incidentAt + 1000,attempt:3,lastGoodAt:incidentAt - 1000,
    failedAttempts:2,outcomeNotifiedAt:incidentAt + 2 * 60_000}]
]);
let onMessage;
let pendingAlert;
const chrome = {
  storage:{local:{
    get:async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .filter(key => values.has(key)).map(key => [key,values.get(key)])),
    set:async changes => { for (const [key,value] of Object.entries(changes)) values.set(key,value); }
  }},
  runtime:{onMessage:{addListener(listener){onMessage=listener;}},
    onStartup:{addListener(){}},onInstalled:{addListener(){}}},
  tabs:{onUpdated:{addListener(){}}},
  alarms:{get:async()=>({}),create:async()=>{},onAlarm:{addListener(){}}},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}
};
const source = fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8');
vm.runInNewContext(source,{chrome,console,crypto,Date,URL,URLSearchParams,BigInt,Buffer,
  setInterval(){},fetch:async url => url.endsWith('/recovery-alert')
    ? new Promise(resolve => {pendingAlert=resolve;}) : {ok:true}});

(async () => {
  onMessage({type:'pageStatus',allowed:true,channel_id:channelId,at:now,extracted:4},
    {tab:{id:tabId,url:`https://discord.com/channels/1/${channelId}`}},()=>{});
  for (let i=0; i<20 && !pendingAlert; i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof pendingAlert,'function','alert upload should still be in flight');
  assert.equal(values.get(`health:${tabId}`).status,'healthy',
    'recovery must be saved before a delayed alert upload');
  pendingAlert({ok:true});
  console.log('Recovery state is saved before alert delivery finishes.');
})().catch(error=>{console.error(error);process.exitCode=1;});

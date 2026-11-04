const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const data = {token:'test'};
const clone = value => structuredClone(value);
const pause = () => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 3)));
const local = {
  async get(keys) {
    await pause();
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter(key => key in data).map(key => [key,clone(data[key])]));
  },
  async set(values) {
    await pause();
    Object.assign(data,clone(values));
  }
};
const noop = () => {};
const context = vm.createContext({
  chrome:{storage:{local},alarms:{get:async()=>({}),create:noop,onAlarm:{addListener:noop}},
    tabs:{onUpdated:{addListener:noop}},runtime:{onMessage:{addListener:noop},onStartup:{addListener:noop},onInstalled:{addListener:noop}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}},
  fetch:async()=>{throw Error('collector offline');},
  setInterval:noop,setTimeout:()=>0,clearTimeout:noop,AbortSignal,console,crypto:webcrypto,Date,URL,URLSearchParams,BigInt,Buffer
});
vm.runInContext(fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8'),context);

(async()=>{
  const messages = Array.from({length:100},(_,index)=>({
    channel_id:'1222944235691708477',source_message_id:String(1000+index),
    body_raw:`message ${index}`,attachments:[]
  }));
  await Promise.all(messages.map(message=>vm.runInContext('enqueue',context)(message)));
  assert.equal(data.queue.length,messages.length);
  assert.equal(new Set(data.queue.map(item=>item.message.source_message_id)).size,messages.length);
  assert.equal(data.diagnosticQueue.length,1,'offline upload error remains in the diagnostic queue');
  console.log('Concurrent Discord captures retained all 100 queued messages.');
})().catch(error=>{console.error(error);process.exitCode=1;});

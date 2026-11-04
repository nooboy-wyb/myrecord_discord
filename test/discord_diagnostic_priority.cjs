const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const sent=[];
const data={token:'test',allowedChannels:[],diagnosticQueue:Array.from({length:30},(_,i)=>
  ({event_id:String(i),at:i+1,code:'TEST_EVENT'}))};
const noop=()=>{};
const local={async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
  .filter(k=>k in data).map(k=>[k,structuredClone(data[k])]));},
async set(v){Object.assign(data,structuredClone(v));}};
const chrome={storage:{local},alarms:{get:async()=>({}),create:noop,onAlarm:{addListener:noop}},
  tabs:{onUpdated:{addListener:noop}},runtime:{onMessage:{addListener:noop},onStartup:{addListener:noop},onInstalled:{addListener:noop}}};
const ctx=vm.createContext({chrome,console,crypto:webcrypto,setInterval:noop,setTimeout:noop,
  clearTimeout:noop,AbortSignal,Date,URL,URLSearchParams,BigInt,Buffer,
  fetch:async(_url,opts)=>{sent.push(JSON.parse(opts.body).at);return {ok:true};}});
vm.runInContext(fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8'),ctx);
const flush=vm.runInContext('flushDiagnostics',ctx);
(async()=>{
  await flush();
  assert.equal(sent.length,25,'one upload batch is bounded');
  assert.deepEqual(sent.slice(0,3),[30,29,28]);
  assert.equal(data.diagnosticQueue.length,5,'old entries remain queued');
  data.diagnosticQueue.push({event_id:'fresh',at:100,code:'TEST_EVENT'});
  await flush();
  assert.equal(sent[25],100,'fresh diagnostic goes before old backlog');
  assert.equal(data.diagnosticQueue.length,0);
  console.log('Fresh diagnostics bypass old backlog without dropping records.');
})().catch(e=>{console.error(e);process.exitCode=1;});

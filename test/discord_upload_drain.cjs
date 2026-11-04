const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8');
const uploadSource="const ENDPOINT='mock://collector';"+source.slice(source.indexOf('let sending = false;'),source.indexOf('let refreshing = false;'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const message=id=>({channel_id:'1',source_message_id:id,body_raw:'test',attachments:[]});
function harness(state={token:'test'},post=async()=>({ok:true})) {
  let clock=100000,active=0,maxActive=0,hook;
  const sent=[],timers=new Map();let timerId=0;
  class Clock extends Date {static now(){return clock;}}
  const local={async get(keys){const names=Array.isArray(keys)?keys:[keys];
    const snapshot=Object.fromEntries(names.filter(k=>k in state).map(k=>[k,structuredClone(state[k])]));
    if(hook)await hook(names,snapshot);return snapshot;},
    async set(values){Object.assign(state,structuredClone(values));}};
  const ctx=vm.createContext({chrome:{storage:{local}},Date:Clock,AbortSignal,console,
    queueDiagnostic:async()=>{},setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},
    clearTimeout:id=>timers.delete(id),fetch:async(_url,options)=>{active++;maxActive=Math.max(maxActive,active);
      const body=JSON.parse(options.body);sent.push(body.source_message_id);
      try{return await post(body,options);}finally{active--;}}});
  vm.runInContext(uploadSource,ctx);
  return {state,sent,timers,enqueue:vm.runInContext('enqueue',ctx),flush:vm.runInContext('flush',ctx),
    busy:()=>vm.runInContext('sending',ctx),maxActive:()=>maxActive,
    setClock:value=>{clock=value;},setHook:value=>{hook=value;}};
}
test('arrival during upload drains immediately and serially without a timer tick',async()=>{
  const entered=deferred(),release=deferred();
  const h=harness(undefined,async m=>{if(m.source_message_id==='A'){entered.resolve();await release.promise;}return {ok:true};});
  const first=h.enqueue(message('A'));await entered.promise;
  await Promise.all([h.enqueue(message('B')),h.enqueue(message('C')),h.flush()]);
  assert.deepEqual(h.sent,['A']);release.resolve();await first;
  assert.deepEqual(h.sent,['A','B','C']);assert.equal(h.state.queue.length,0);
  assert.equal(h.maxActive(),1);assert.equal(h.timers.size,0);assert.equal(h.busy(),false);
});
test('arrival during an empty storage snapshot is not lost at sender shutdown',async()=>{
  const entered=deferred(),release=deferred();const h=harness({token:'test',queue:[]});
  let held=false;h.setHook(async names=>{if(names.includes('captureRetryAt')&&!held){held=true;entered.resolve();await release.promise;}});
  const idle=h.flush();await entered.promise;await h.enqueue(message('B'));release.resolve();await idle;
  assert.deepEqual(h.sent,['B']);assert.equal(h.state.queue.length,0);assert.equal(h.busy(),false);
});
test('failures retain FIFO and persist capped backoff; arrivals and restart respect deadline',async()=>{
  let fails=true;const h=harness(undefined,async()=>{if(fails)throw Error('upload timeout');return {ok:true};});
  await h.enqueue(message('A'));
  const waits=[1000,2000,4000,8000,16000,30000,30000];
  for(let i=0;i<waits.length;i++) {
    const timer=[...h.timers.values()][0];assert.equal(timer.ms,waits[i]);
    const attempts=h.sent.length;await h.enqueue(message('B'));await h.flush();
    assert.equal(h.sent.length,attempts,'wakeups must not bypass backoff');
    if(i===0){const restarted=harness(h.state);await restarted.flush();assert.equal(restarted.sent.length,0,'persisted deadline survives worker restart');}
    if(i<waits.length-1){h.setClock(h.state.captureRetryAt);await h.flush();}
  }
  assert.equal(h.state.queue.length,2);assert.equal(h.busy(),false);
  fails=false;h.setClock(h.state.captureRetryAt);await h.flush();
  assert.deepEqual(h.sent.slice(-2),['A','B']);assert.equal(h.state.queue.length,0);
  assert.equal(h.state.captureRetryAt,0);assert.equal(h.state.captureRetryFailures,0);
  assert.equal(h.timers.size,0);assert.equal(h.maxActive(),1);
});
test('a rejected payload is recorded once and does not block the next message',async()=>{
  const h=harness({token:'test',queue:[{key:'bad',message:message('bad')},{key:'good',message:message('good')}]},
    async m=>m.source_message_id==='bad'?{status:400,text:async()=>'invalid capture'}:{ok:true});
  await h.flush();assert.deepEqual(h.sent,['bad','good']);assert.equal(h.state.queue.length,0);
  assert.equal(h.state.rejectedCaptures.length,1);assert.equal(h.state.captureRetryFailures,0);
});
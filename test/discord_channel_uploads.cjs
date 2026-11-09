const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8');
const tick = () => new Promise(setImmediate);
const message = (channel, id) => ({channel_id:channel,source_message_id:id,body_raw:id,attachments:[]});
const queued = (channel, id) => ({key:id,message:message(channel,id)});
const noop = () => {};

function setup(saved = {}) {
  let now = 1800000000000, timerId = 0, maximum = 0;
  const data = {token:'test',...structuredClone(saved)};
  const pending = new Map(), started = [], activeChannels = new Set(), timers = new Map();
  const local = {
    async get(keys) {
      await tick();
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => key in data).map(key => [key,structuredClone(data[key])]));
    },
    async set(values) { await tick(); Object.assign(data,structuredClone(values)); }
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    chrome:{storage:{local},alarms:{get:async()=>({}),create:noop,onAlarm:{addListener:noop}},
      tabs:{onUpdated:{addListener:noop}},runtime:{onMessage:{addListener:noop},
        onStartup:{addListener:noop},onInstalled:{addListener:noop}}},
    Date:Clock,console,crypto:webcrypto,AbortSignal,URL,URLSearchParams,BigInt,
    setInterval:noop,
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),
    fetch:async (url, options) => {
      if (!url.endsWith('/v1/messages')) return {ok:true};
      const msg = JSON.parse(options.body), id = msg.source_message_id;
      assert(!activeChannels.has(msg.channel_id),'two uploads from one channel must never overlap');
      activeChannels.add(msg.channel_id);
      maximum = Math.max(maximum,activeChannels.size);
      started.push(id);
      return new Promise((resolve,reject) => {
        pending.set(id,{finish(status=200) {
          pending.delete(id); activeChannels.delete(msg.channel_id);
          resolve({ok:status===200,status,text:async()=>status===400 ? 'invalid capture' : '{"id":1}'});
        },fail() {
          pending.delete(id); activeChannels.delete(msg.channel_id);
          reject(Error('offline'));
        }});
      });
    }
  });
  vm.runInContext(source,context);
  return {data,pending,started,timers,context,
    enqueue:vm.runInContext('enqueue',context),flush:vm.runInContext('flush',context),
    maximum:()=>maximum,advance(ms){now+=ms;},
    async until(check) {
      for (let i=0;i<400;i++) { if (check()) return; await tick(); }
      assert(check(),'scheduler did not reach expected state');
    },
    async drain() {
      const flushing = this.flush();
      for (let i=0;i<400;i++) {
        for (const request of [...pending.values()]) request.finish();
        await tick();
        if (!data.queue?.length && !vm.runInContext('sending',context)) {await flushing;return;}
      }
      throw Error('queue did not drain');
    }
  };
}

const deadline = setTimeout(()=>{throw Error('Channel upload test did not complete');},5000);
(async()=>{
  // Reproduce a backlog ahead of tia, with all three upload positions initially busy.
  const app = setup({queue:[...Array.from({length:40},(_,i)=>queued('exchange','old'+i)),
    queued('a','a1'),queued('b','b1')]});
  const running = app.flush();
  await app.until(()=>app.pending.size===3);
  await app.enqueue(message('tia','tia1'));
  app.pending.get('a1').finish();
  await app.until(()=>app.pending.has('tia1'));
  assert.equal(app.started.filter(id=>id.startsWith('old')).length,1,
    'tia must start before the exchange backlog is drained');
  app.pending.get('tia1').finish();
  await app.drain(); await running;
  assert.equal(app.maximum(),3);
  assert.deepEqual(app.started.filter(id=>id.startsWith('old')),
    Array.from({length:40},(_,i)=>'old'+i),'preserve channel order');
  assert.equal(new Set(app.started).size,43,'send each capture once');

  // A new channel must fill a vacant position while another request remains stuck.
  const vacant = setup({queue:[queued('slow','s1')]});
  const slowRun = vacant.flush();
  await vacant.until(()=>vacant.pending.has('s1'));
  await vacant.enqueue(message('tia','t1'));
  await vacant.until(()=>vacant.pending.has('t1'));
  assert(vacant.pending.has('s1'));
  await vacant.drain(); await slowRun;

  // Failure/backoff is isolated, durable, and cannot be bypassed by new captures.
  const failing = setup({queue:[queued('bad','f1'),queued('good','g1')]});
  const failedRun = failing.flush();
  await failing.until(()=>failing.pending.size===2);
  failing.pending.get('f1').fail();
  failing.pending.get('g1').finish();
  await failedRun;
  assert.equal(failing.data.queue.length,1);
  assert.equal(failing.data.captureChannelRetries.bad.failures,1);
  await failing.enqueue(message('bad','f2'));
  const newCapture = failing.enqueue(message('tia','t2'));
  await failing.until(()=>failing.pending.has('t2'));
  assert.equal(failing.started.filter(id=>id==='f1').length,1);
  assert.equal(failing.data.lastError,'Error: offline');
  failing.pending.get('t2').finish();
  await newCapture;
  await failing.until(()=>!vm.runInContext('sending',failing.context));
  assert.equal(failing.data.lastError,'Error: offline','other success must retain failed channel error');
  const restarted = setup(failing.data);
  await restarted.flush();
  assert.equal(restarted.started.length,0,'reload must retain the backoff');
  restarted.advance(1001);
  await restarted.drain();
  assert.deepEqual(restarted.started,['f1','f2']);
  assert.equal(restarted.data.lastError,'');

  // A legacy global retry must only pause the channel it originally belonged to.
  const legacy = setup({queue:[queued('bad','legacy'),queued('tia','new')],
    captureRetryAt:1800000005000,captureRetryFailures:3});
  const migrated = legacy.flush();
  await legacy.until(()=>legacy.pending.has('new'));
  assert(!legacy.pending.has('legacy'));
  assert.equal(legacy.data.captureChannelRetries.bad.failures,3);
  legacy.pending.get('new').finish(); await migrated;
  legacy.advance(5001); await legacy.drain();

  // Simultaneous rejections must retain both rejection records and advance both channels.
  const rejected = setup({queue:[queued('a','reject1'),queued('b','reject2')]});
  const rejectRun = rejected.flush();
  await rejected.until(()=>rejected.pending.size===2);
  for (const request of [...rejected.pending.values()]) request.finish(400);
  await rejectRun;
  assert.equal(rejected.data.queue.length,0);
  assert.equal(rejected.data.rejectedCaptures.length,2);
  console.log('Channel uploads: backlog isolation, 3-channel limit, FIFO, wakeup, persistent retries, migration and concurrent rejections passed.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(deadline));

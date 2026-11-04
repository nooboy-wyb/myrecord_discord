const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const channel = '1265882617530814535';
const url = `https://discord.com/channels/1/${channel}`;
const noop = () => {};
const background = fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8');
const content = fs.readFileSync(require.resolve('../edge-discord-collector/content.js'),'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function verifyPageStages() {
  let resolveConfig;
  const events = [];
  const scope = {Date,document:{visibilityState:'hidden',querySelector:()=>null,querySelectorAll:()=>[]},
    route:()=>({guild_id:'1',channel_id:channel}),ensurePanel:noop,lastRoute:`1/${channel}`,
    panel:null,seen:new Map(),reportedImageGaps:new Set(),visibleMinutes:new Map(),
    messageNodes:()=>({nodesById:[],contentNodes:[],nodes:new Set()}),combineExtracted:x=>x,
    chrome:{storage:{local:{get:()=>new Promise(resolve=>{resolveConfig=resolve;})}},
      runtime:{sendMessage:async event=>{events.push(event);}}}};
  const scan = vm.runInNewContext(content.slice(content.indexOf('  let scanSequence ='),
    content.indexOf('  let timer;'))+'\nscan',scope);
  const pending = scan(false,{requestId:'request-1',requestedAt:Date.now()});
  assert.deepEqual(events.map(x=>x.stage),['received','config_wait']);
  assert(!events.some(x=>x.type==='pageStatus'),'progress is not a successful scan heartbeat');
  resolveConfig({allowedChannels:[channel]});
  const result = await pending;
  assert.equal(result.extracted,0);
  assert.deepEqual(events.filter(x=>x.type==='scanProgress').map(x=>x.stage),
    ['received','config_wait','dom_scan','complete']);
  const status = events.find(x=>x.type==='pageStatus');
  assert.equal(status.scan_trace.request_id,'request-1');
  assert.equal(status.scan_trace.visibility,'hidden');
}

async function verifyPollAndUpload() {
  const now=Date.now(), data={token:'test',allowedChannels:[channel],
    periodicScheduleVersion:1,recoveryRetryVersion:3,lastRefreshByTab:{1:now},
    lastPeriodicRefreshByTab:{1:now},'health:1':{lastScanAt:now-180000,status:'healthy'},
    'poll:1':{lastSuccessAt:now,consecutiveFailures:0}};
  let onMessage, failUpload=true, hangPoll=false, uploadSignal;
  const diagnostics=[];
  const local={async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
    .filter(key=>key in data).map(key=>[key,structuredClone(data[key])]));},
    async set(changes){Object.assign(data,structuredClone(changes));}};
  const tab={id:1,url,discarded:false};
  const chrome={storage:{local},tabs:{query:async()=>[tab],reload:async()=>{},
    onUpdated:{addListener:noop},sendMessage:async(_id,request)=>{
      if(hangPoll) return new Promise(()=>{});
      onMessage({type:'scanProgress',channel_id:channel,request_id:request.requestId,
        stage:'config_wait',at:Date.now(),visibility:'hidden'},{tab},noop);
      return {allowed:true,extracted:0};
    }},runtime:{onMessage:{addListener(fn){onMessage=fn;}},
      onStartup:{addListener:noop},onInstalled:{addListener:noop}},
    alarms:{get:async()=>({}),create:noop,onAlarm:{addListener:noop}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
  const ctx=vm.createContext({chrome,console,crypto:webcrypto,Date,URL,URLSearchParams,BigInt,
    setInterval:noop,setTimeout:(fn,ms)=>setTimeout(fn,ms===12000?1:ms),clearTimeout,
    AbortSignal:{timeout(ms){const controller=new AbortController();
      if(ms===30000&&failUpload)setTimeout(()=>controller.abort(Error('upload timeout')),1);
      return controller.signal;}},
    fetch:async(endpoint,options)=>{
      if(endpoint.endsWith('/diagnostic'))diagnostics.push(JSON.parse(options.body));
      if(endpoint.endsWith('/messages')) {
        uploadSignal=options.signal;
        if(failUpload)return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason)));
      }
      return {ok:true};
    }});
  vm.runInContext(background,ctx);
  await vm.runInContext('refreshMonitoredTabs()',ctx);
  assert.equal(data.watchdogStatus.details[0].status,'healthy','popup must use recent polling success');
  await vm.runInContext('pollMonitoredTabs()',ctx);
  await tick();
  assert(diagnostics.some(x=>x.code==='POLL_SCAN_RESULT'&&x.detail.last_stage==='config_wait'));
  hangPoll=true;
  await vm.runInContext('pollMonitoredTabs()',ctx);
  await tick();
  assert(diagnostics.some(x=>x.code==='POLL_SCAN_RESULT'&&x.detail.last_stage==='request_sent'
    &&x.detail.error==='scan response timeout'),'no page receipt is distinguishable from config wait');
  const message={channel_id:channel,source_message_id:'1567405990654251101',body_raw:'test',attachments:[],
    capture_trace:{scan_id:`${now}-1`,scan_started_at:now,observed_at:now}};
  await vm.runInContext('enqueue',ctx)(message);
  assert(uploadSignal.aborted);
  assert.equal(data.queue.length,1,'timeout keeps the capture queued');
  assert.equal(vm.runInContext('sending',ctx),false,'timeout releases the uploader');
  assert(data.queue[0].message.capture_trace.queued_at>=now);
  failUpload=false;
  data.captureRetryAt=Date.now()-1; // Retry after the persisted deadline.
  await vm.runInContext('flush()',ctx);
  assert.equal(data.queue.length,0,'retry safely acknowledges the retained capture');
}
(async()=>{await verifyPageStages();await verifyPollAndUpload();
  console.log('Scan stages, popup polling and retained upload timeout retries verified.');
})().catch(error=>{console.error(error);process.exitCode=1;});

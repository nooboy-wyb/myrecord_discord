const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {once} = require('node:events');
const {Worker} = require('node:worker_threads');
const {DatabaseSync} = require('node:sqlite');
const {test} = require('node:test');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'muse-storage-'));
  const filename = require.resolve('../scripts/discord_collector_server.cjs');
  let failNext = false;
  class Storage extends DatabaseSync {
    exec(sql) {
      if (failNext && sql === 'BEGIN IMMEDIATE') {
        failNext = false;
        throw Object.assign(Error('database is locked'),{code:'ERR_SQLITE_ERROR',errcode:5});
      }
      return super.exec(sql);
    }
  }
  const localRequire = name => {
    if (name === 'node:sqlite') return {DatabaseSync:Storage};
    if (name === './collector_logger.cjs') return {};
    if (name === './collector_diagnostics.cjs') return {saveDiagnostic:()=>{}};
    if (name === './collector_page_status.cjs') return {createPageStatusReporter:()=>({})};
    return name.startsWith('.') ? require(path.resolve(path.dirname(filename),name)) : require(name);
  };
  localRequire.main = {};
  const exported = {exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:localRequire,module:exported,
    __dirname:path.join(root,'scripts'),process:{env:{MUSE_DATA_DIR:root}},Buffer,URL,
    console:{log:()=>{},warn:()=>{},error:()=>{}},setTimeout});
  const {server} = exported.exports;
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const token = fs.readFileSync(path.join(root,'collector-token.txt'),'utf8').trim();
  const url = `http://127.0.0.1:${server.address().port}/v1/messages`;
  const message = {source:'discord_web',channel_id:'1381176601802440744',
    source_message_id:'1568190318510088314',body_raw:'fixture',attachments:[]};
  const post = body => fetch(url,{method:'POST',headers:{'x-collector-token':token},
    body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
  const file = () => path.join(root,fs.readdirSync(root).find(name => /^\d{4}-\d{2}-\d{2}$/.test(name)),'messages.sqlite');
  return {url,token,message,post,file,fail:() => {failNext = true;}};
}

test('temporary DC storage failure retains the extension queue and retry inserts exactly once',async t => {
  const setup = await fixture(t);
  let clock = Date.now();
  class Clock extends Date {static now() {return clock;}}
  const data = {token:setup.token};
  const local = {async get(keys) {
    return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data)
      .map(key => [key,structuredClone(data[key])]));
  },async set(values) {Object.assign(data,structuredClone(values));}};
  const source = fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8');
  const context = vm.createContext({chrome:{storage:{local}},Date:Clock,AbortSignal,console,
    queueDiagnostic:async()=>{},setTimeout:()=>1,clearTimeout:()=>{},
    fetch:async(...args) => {
      const response = await fetch(...args);
      if (!data.queue?.length) assert.fail('capture removed before HTTP acknowledgement');
      return response;
    }});
  vm.runInContext(`const ENDPOINT=${JSON.stringify(setup.url)};`+
    source.slice(source.indexOf('let sending = false;'),source.indexOf('let refreshing = false;')),context);
  setup.fail();
  await vm.runInContext('enqueue',context)(setup.message);
  assert.equal(data.queue.length,1);
  assert.equal(data.rejectedCaptures,undefined);
  assert.equal(data.captureChannelRetries[setup.message.channel_id].failures,1);
  clock = data.captureChannelRetries[setup.message.channel_id].retryAt;
  await vm.runInContext('flush()',context);
  assert.equal(data.queue.length,0);
  assert.equal((await setup.post(setup.message)).status,200);
  const database = new DatabaseSync(setup.file(),{readOnly:true});
  try {assert.equal(database.prepare('SELECT COUNT(*) AS count FROM discord_web_messages').get().count,1);}
  finally {database.close();}
});

test('invalid DC identity and malformed JSON remain permanent client rejections',async t => {
  const setup = await fixture(t);
  assert.equal((await setup.post({...setup.message,channel_id:'invalid'})).status,400);
  assert.equal((await setup.post({...setup.message,source_timestamp:'2000-01-01T00:00:00Z'})).status,400);
  const malformed = await fetch(setup.url,{method:'POST',headers:{'x-collector-token':setup.token},body:'{'});
  assert.equal(malformed.status,400);
});

test('DC capture waits for a short concurrent archive reader and still commits',async t => {
  const setup = await fixture(t);
  assert.equal((await setup.post(setup.message)).status,200);
  const worker = new Worker(`
    const {parentPort,workerData} = require('node:worker_threads');
    const {DatabaseSync} = require('node:sqlite');
    const database = new DatabaseSync(workerData);
    database.exec('BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    setTimeout(() => {database.exec('COMMIT');database.close();},250);
  `,{eval:true,workerData:setup.file()});
  t.after(() => worker.terminate());
  const exited = once(worker,'exit');
  await once(worker,'message');
  const response = await setup.post({...setup.message,source_message_id:'1568190318510088315'});
  const status = response.status;
  await exited;
  assert.equal(status,200);
});

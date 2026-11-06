const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {DatabaseSync} = require('node:sqlite');
const {createAttachmentQueue,originalAttachmentUrl} = require('../scripts/collector_attachment_queue.cjs');

const deferred = () => {let resolve;const promise = new Promise(r => {resolve=r;});return {promise,resolve};};
const image = name => ({source_url:`https://cdn.discordapp.com/attachments/1/2/${name}.png`});
const message = (id,attachments=[]) => ({source:'discord_web',channel_id:'1381176601802440744',
  source_message_id:String(id),body_raw:'synthetic test',attachments});
const response = () => ({ok:true,headers:new Headers(),arrayBuffer:async()=>Buffer.from('test image')});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'muse-attachment-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  function dbFor(date='2026-11-06') {
    fs.mkdirSync(path.join(root,date),{recursive:true});
    const db = new DatabaseSync(path.join(root,date,'messages.sqlite'));
    db.exec(`CREATE TABLE IF NOT EXISTS discord_web_attachment_files (
      message_id INTEGER NOT NULL,source_url TEXT NOT NULL,local_path TEXT,sha256 TEXT,
      status TEXT NOT NULL,error TEXT,updated_at TEXT NOT NULL,UNIQUE(message_id,source_url));`);
    return db;
  }
  return {root,dbFor};
}

test('HTTP acknowledges durable captures while a slow image is still downloading', {timeout:5000}, async t => {
  const {root} = fixture(t);
  const release = deferred(),entered = deferred();
  let queue;
  const filename = require.resolve('../scripts/discord_collector_server.cjs');
  const source = fs.readFileSync(filename,'utf8');
  const exported = {exports:{}};
  const localRequire = name => {
    if (name === './collector_logger.cjs') return {};
    if (name === './collector_diagnostics.cjs') return {saveDiagnostic:()=>{},recoveryAlertAlreadyHandled:()=>false};
    if (name === './collector_page_status.cjs') return {createPageStatusReporter:()=>({})};
    if (name === './collector_attachment_queue.cjs') return {createAttachmentQueue:options => {
      queue = createAttachmentQueue({...options,fetchImpl:async()=>{entered.resolve();await release.promise;return response();}});
      return queue;
    }};
    return name.startsWith('.') ? require(path.resolve(path.dirname(filename),name)) : require(name);
  };
  localRequire.main = {};
  vm.runInNewContext(source,{require:localRequire,module:exported,
    __dirname:path.join(root,'scripts'),Buffer,URL,console:{log:()=>{},warn:()=>{},error:()=>{}},
    process,setTimeout},{filename});
  const {server} = exported.exports;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  queue.start();
  const dataRoot = path.join(root,'data');
  const token = fs.readFileSync(path.join(dataRoot,'collector-token.txt'),'utf8').trim();
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{
    method:'POST',headers:{'content-type':'application/json','x-collector-token':token},
    body:JSON.stringify(body),signal:AbortSignal.timeout(2000)});
  try {
    const first = await post(message('1568190318510088314',[image('slow')]));
    assert.equal(first.status,200);
    const firstId = (await first.json()).id;
    await entered.promise;
    const second = await post(message('1568206432845955174'));
    assert.equal(second.status,200,'a slow image must not hold up the next capture');
    const date = fs.readdirSync(dataRoot).find(name=>/^\d{4}-\d{2}-\d{2}$/.test(name));
    const db = new DatabaseSync(path.join(dataRoot,date,'messages.sqlite'),{readOnly:true});
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM discord_web_messages').get().n,2);
      assert.equal(db.prepare('SELECT status FROM discord_web_attachment_jobs WHERE message_id=?').get(firstId).status,'downloading');
      assert.equal(db.prepare('SELECT status FROM discord_web_attachment_files WHERE message_id=?').get(firstId).status,'pending');
    } finally { db.close(); }
  } finally {
    release.resolve();
    await queue.stop();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('download failures persist retries, survive restart, and stop at a bounded attempt count', async t => {
  const {root,dbFor} = fixture(t);
  let clock = Date.parse('2026-11-06T10:00:00Z'),calls = 0;
  const events = [];
  const options = {root,now:()=>clock,maxAttempts:2,retryDelays:[5000],
    fetchImpl:async()=>{calls++;throw Error('private signed URL must not enter diagnostics');},onEvent:e=>events.push(e)};
  let queue = createAttachmentQueue(options);
  let db = dbFor();
  queue.enqueue(db,'2026-11-06',1,message('1568190318510088314',[image('unavailable')]));db.close();
  await queue.runOnce();
  assert.equal(calls,1);
  queue = createAttachmentQueue(options);queue.recover();
  await queue.runOnce();assert.equal(calls,1,'restart must honor the persisted retry deadline');
  clock += 5000;await queue.runOnce();assert.equal(calls,2);
  clock += 100000;await queue.runOnce();assert.equal(calls,2);
  db = dbFor();
  try {
    assert.equal(db.prepare('SELECT status FROM discord_web_attachment_files').get().status,'failed');
    assert.equal(db.prepare('SELECT attempts FROM discord_web_attachment_jobs').get().attempts,2);
    queue.enqueue(db,'2026-11-06',1,message('1568190318510088314',[image('unavailable')]));
  } finally { db.close(); }
  await queue.runOnce();assert.equal(calls,2,'duplicate captures must not reset an exhausted retry loop');
  assert.equal(events.at(-1).code,'ATTACHMENT_DOWNLOAD_FAILED');
  assert(!JSON.stringify(events).includes('private'));
  assert(!JSON.stringify(events).includes('https:'));
});

test('restart recovers interrupted downloads into the original archive date across midnight', async t => {
  const {root,dbFor} = fixture(t);
  const queue = createAttachmentQueue({root,now:()=>Date.parse('2026-11-07T00:00:00Z'),fetchImpl:async()=>response()});
  const db = dbFor();
  queue.enqueue(db,'2026-11-06',7,message('1568190318510088314',[image('midnight')]));
  db.exec("UPDATE discord_web_attachment_jobs SET status='downloading',attempts=1");db.close();
  queue.recover();await queue.runOnce();
  const check = dbFor();
  try {
    const row = check.prepare('SELECT status,local_path FROM discord_web_attachment_files').get();
    assert.equal(row.status,'saved');assert(fs.existsSync(row.local_path));
    assert(row.local_path.startsWith(path.join(root,'2026-11-06','attachments')));
  } finally { check.close(); }
  assert(!fs.existsSync(path.join(root,'2026-11-07')));
});

test('bounded workers let a fast image finish while another download is blocked', async t => {
  const {root,dbFor} = fixture(t);
  const release = deferred(),entered = deferred(),fast = deferred();
  let active=0,maxActive=0;
  const queue = createAttachmentQueue({root,concurrency:2,fetchImpl:async url=>{
    active++;maxActive=Math.max(maxActive,active);
    try {if(url.includes('slow')){entered.resolve();await release.promise;}return response();}
    finally {active--;}
  },onEvent:event=>{if(event.source_message_id==='1568190318510088314') fast.resolve();}});
  const db=dbFor();
  queue.enqueue(db,'2026-11-06',1,message('1568190318510088314',[image('fast')]));
  queue.enqueue(db,'2026-11-06',2,message('1568206432845955174',[image('slow')]));db.close();
  const running=queue.runOnce();
  try {await entered.promise;await fast.promise;assert.equal(maxActive,2);}
  finally {release.resolve();await running;}
});

test('a rolled-back capture leaves no orphan download and cannot block later jobs', async t => {
  const {root,dbFor}=fixture(t);let calls=0;
  const queue=createAttachmentQueue({root,fetchImpl:async()=>{calls++;return response();}});
  const db=dbFor();
  db.exec('BEGIN IMMEDIATE');
  queue.enqueue(db,'2026-11-06',1,message('1568190318510088314',[image('rolled-back')]));
  db.exec('ROLLBACK');
  await queue.runOnce();assert.equal(calls,0);
  db.exec('BEGIN IMMEDIATE');
  queue.enqueue(db,'2026-11-06',2,message('1568206432845955174',[image('committed')]));
  db.exec('COMMIT');db.close();
  await queue.runOnce();assert.equal(calls,1);
});

test('only supported HTTPS originals are downloaded and signed query keys are preserved',()=>{
  assert.equal(originalAttachmentUrl('https://media.discordapp.net/attachments/1/2/chart.png?width=100&ex=a&is=b&hm=c#x'),
    'https://cdn.discordapp.com/attachments/1/2/chart.png?ex=a&is=b&hm=c');
  assert.equal(originalAttachmentUrl('http://cdn.discordapp.com/attachments/1/2/chart.png'),null);
  assert.equal(originalAttachmentUrl('https://example.com/attachments/1/2/chart.png'),null);
});

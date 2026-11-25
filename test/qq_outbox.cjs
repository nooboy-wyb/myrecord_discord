const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {DatabaseSync} = require('node:sqlite');
const {createOutbox} = require('../scripts/qq/core/outbox.cjs');
const {acquireLock} = require('../scripts/qq/core/process_lock.cjs');

const message = (id, source = 'discord') => ({channel_id:source === 'telegram' ? 'telegram:-1001:all' : '123',
  source_message_id:source === 'telegram' ? `telegram:-1001:${id}` : String(id),
  source_timestamp:`2026-11-25T00:00:${String(id).padStart(2,'0')}Z`,content_sha256:`hash-${id}`,body_raw:'fixture'});
const context = {group_openid:'TESTGROUP'};

test('durable queue survives restart and terminal outcomes never resend',async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse-outbox-'));
  t.after(() => fs.rmSync(folder,{recursive:true,force:true}));
  let state = new DatabaseSync(path.join(folder,'state.sqlite'));
  let queue = createOutbox({state,send:async() => {throw Error('must remain offline');}});
  const key = queue.enqueue(message(1),context);
  queue.enqueue(message(1),context);
  const interrupted = queue.enqueue(message(2,'telegram'),context);
  state.prepare("UPDATE sender_outbox SET status='processing' WHERE task_key=?").run(interrupted);
  state.close();
  state = new DatabaseSync(path.join(folder,'state.sqlite'));
  const sent = [];
  queue = createOutbox({state,send:async item => {sent.push(item.source_message_id);return 'accepted';}});
  try {
    assert.equal(state.prepare('SELECT status FROM sender_outbox WHERE task_key=?').get(interrupted).status,'processing');
    queue.recover();
    await queue.drain();
    queue.enqueue(message(1),context);
    await queue.drain();
    assert.deepEqual(sent,['1','telegram:-1001:2']);
    assert.equal(state.prepare('SELECT status FROM sender_outbox WHERE task_key=?').get(key).status,'accepted');
  } finally { state.close(); }
});

test('unknown jobs are isolated and route errors do not stop another source',async () => {
  const state = new DatabaseSync(':memory:');
  let clock = 1000;
  const sent = [];
  let disabled = true;
  const queue = createOutbox({state,now:() => clock,
    allowed:item => {if (item.source_message_id === '1') throw Error('invalid DC config');return !disabled || item.source_message_id !== '2';},
    send:async item => {sent.push(item.source_message_id);if (item.source_message_id.endsWith(':3')) throw Error('uncertain HTTP result');return 'accepted';}});
  try {
    for (const item of [message(1),message(2),message(3,'telegram'),message(4,'telegram')]) queue.enqueue(item,context);
    await queue.drain();
    assert.deepEqual(sent,['telegram:-1001:3','telegram:-1001:4']);
    assert.equal(state.prepare("SELECT COUNT(*) AS n FROM sender_outbox WHERE status='unknown'").get().n,1);
    disabled = false;
    clock += 6000;
    await queue.drain();
    assert.deepEqual(sent,['telegram:-1001:3','telegram:-1001:4','2']);
    assert.equal(state.prepare("SELECT attempts FROM sender_outbox WHERE source_message_id='telegram:-1001:3'").get().attempts,1);
  } finally {state.close();}
});

test('deferred attachment snapshots can refresh without resetting accepted jobs',async () => {
  const state = new DatabaseSync(':memory:');
  const bodies = [];
  const queue = createOutbox({state,send:async item => {bodies.push(item.body_raw);return item.body_raw === 'ready' ? 'accepted' : 'deferred';}});
  try {
    queue.enqueue(message(1),context);
    await queue.drain();
    queue.enqueue({...message(1),body_raw:'ready'},context);
    await queue.drain();
    queue.enqueue({...message(1),body_raw:'changed'},context);
    await queue.drain();
    assert.deepEqual(bodies,['fixture','ready']);
  } finally {state.close();}
});

test('unknown results isolate all queued and later edited versions of the source message',async () => {
  const state = new DatabaseSync(':memory:');
  const sent = [];
  const queue = createOutbox({state,send:async(item,route) => {
    sent.push([item.content_sha256,route.group_openid]);
    return item.content_sha256 === 'hash-1' ? 'unknown' : 'accepted';
  }});
  try {
    queue.enqueue({...message(1,'telegram'),source_timestamp:'2026-11-25T00:00:01.000Z'},context);
    const edited = {...message(1,'telegram'),content_sha256:'edited',source_timestamp:'2026-11-25T00:00:01.001Z'};
    queue.enqueue(edited,context);
    queue.enqueue(message(2,'telegram'),context);
    await queue.drain();
    assert.deepEqual(sent,[['hash-1','TESTGROUP'],['hash-2','TESTGROUP']]);
    const later = {...edited,content_sha256:'later'};
    queue.enqueue(later,context);
    queue.enqueue(later,{group_openid:'OTHER'});
    await queue.drain();
    assert.deepEqual(sent,[['hash-1','TESTGROUP'],['hash-2','TESTGROUP'],['later','OTHER']]);
    assert.equal(queue.terminal(later,context),true);
  } finally {state.close();}
});

test('sender lock rejects a second owner, recovers dead owners and tolerates missing marker',t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse-lock-'));
  t.after(() => fs.rmSync(folder,{recursive:true,force:true}));
  const file = path.join(folder,'sender.lock');
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file),/already running/);
  release();
  fs.writeFileSync(file,JSON.stringify({pid:2147483647,nonce:'dead'}));
  const recovered = acquireLock(file);
  fs.unlinkSync(file);
  recovered();
});

test('a paused backlog cannot starve a later source and watermark failure preserves acceptance',async () => {
  const state = new DatabaseSync(':memory:');
  let clock = 1000;
  const sent = [];
  const queue = createOutbox({state,now:() => clock,allowed:item => item.channel_id.startsWith('telegram:'),
    send:async item => {sent.push(item.source_message_id);return 'accepted';},
    onAccepted:() => {throw Error('watermark failure');}});
  try {
    queue.enqueue(message(1),context);
    queue.enqueue(message(2,'telegram'),context);
    await queue.drain(1);
    clock += 6000;
    await queue.drain(1);
    assert.deepEqual(sent,['telegram:-1001:2']);
    assert.equal(state.prepare("SELECT status FROM sender_outbox WHERE source='telegram'").get().status,'accepted');
  } finally {state.close();}
});

test('group spacing survives a new sender instance while different groups keep independent clocks',async () => {
  const state = new DatabaseSync(':memory:');
  state.exec('CREATE TABLE forward_meta(key TEXT PRIMARY KEY,value TEXT)');
  let clock = 100000;
  const waits = [],requests = [];
  class Clock extends Date {static now() {return clock;}}
  const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
  const postSource = source.slice(source.indexOf('async function post('),source.indexOf('function sourceFiles('));
  function sender() {
    return vm.runInNewContext(postSource+'\npost',{state,Date:Clock,target:{group_openid:'TESTGROUP'},
      token:async() => 'fixture-token',lastMessageAttemptAt:new Map(),messageSpacingMs:2000,AbortSignal,
      setTimeout:(callback,delay) => {waits.push(delay);clock += delay;callback();},
      fetch:async url => {requests.push({url,at:clock});return {ok:true,json:async() => ({id:'accepted'})};}});
  }
  try {
    await sender()('messages',{},'GROUPA');
    clock += 500;
    await sender()('messages',{},'GROUPA');
    await sender()('messages',{},'GROUPB');
    assert.deepEqual(waits,[1500]);
    assert.deepEqual(requests.map(item => item.at),[100000,102000,102000]);
  } finally {state.close();}
});

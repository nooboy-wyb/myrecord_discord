const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {test} = require('node:test');
const {DatabaseSync} = require('node:sqlite');
const {createSourceIdentityGuard} = require('../scripts/qq/core/source_identity.cjs');
const {createManualRecovery} = require('../scripts/qq/core/manual_recovery.cjs');
const {createOutbox} = require('../scripts/qq/core/outbox.cjs');

const exchange = '1265882617530814535';
const liu = '1222944235691708477';
const sourceId = '1567367892952158238';
function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse-source-'));
  const archives = ['first.sqlite','second.sqlite'].map(name => new DatabaseSync(path.join(folder,name)));
  const state = new DatabaseSync(':memory:');
  t.after(() => {
    archives.forEach(db => db.close());
    state.close();
    fs.rmSync(folder,{recursive:true,force:true});
  });
  for (const db of archives) db.exec(`CREATE TABLE discord_web_messages(id INTEGER PRIMARY KEY,
    channel_id TEXT,source_message_id TEXT,source_timestamp TEXT,captured_at TEXT,
    author_display TEXT,body_raw TEXT,attachments_json TEXT,content_sha256 TEXT);
    CREATE TABLE discord_web_attachment_files(message_id INTEGER,source_url TEXT,local_path TEXT,status TEXT);`);
  const insert = (index,channelId,id = sourceId) => archives[index].prepare(`INSERT INTO discord_web_messages
    (channel_id,source_message_id,source_timestamp,captured_at,author_display,body_raw,attachments_json,content_sha256)
    VALUES (?,?,?,?,'synthetic author','fixture','[]',?)`)
    .run(channelId,id,'2026-11-04T02:40:25.967Z',`2026-11-0${4+index}T03:00:00Z`,'a'.repeat(64));
  const sourceFiles = () => ['first.sqlite','second.sqlite'].map(name => path.join(folder,name));
  const guard = createSourceIdentityGuard({sourceFiles});
  const message = {channel_id:exchange,source_message_id:sourceId,content_sha256:'a'.repeat(64),
    source_timestamp:'2026-11-04T02:40:25.967Z'};
  return {folder,archives,state,insert,sourceFiles,guard,message};
}

test('Discord IDs may repeat across days only in the same channel; new conflicts are checked afresh',async t => {
  const {insert,guard,message} = fixture(t);
  insert(0,exchange);
  insert(1,exchange);
  assert.equal(await guard.check(message),true);
  assert.equal(guard.channels().get(sourceId).size,1);
  insert(1,liu);
  assert.equal(await guard.check(message),false);
  assert.equal(await guard.check({...message,channel_id:liu}),false);
  assert.equal(guard.channels().get(sourceId).size,2);
  insert(0,exchange,'1567367892952158239');
  assert.equal(await guard.check({...message,source_message_id:'1567367892952158239'}),true);
  assert.equal(await guard.check({...message,source_message_id:'1567367892952158240'}),false);
  assert.equal(await guard.check({source_message_id:'telegram:-1001:10',channel_id:'telegram:-1001:all'}),true);
});

test('already queued messages are blocked before QQ network calls and remain terminal after restart',async t => {
  const {state,insert,guard,message} = fixture(t);
  insert(0,exchange);
  const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
  const start = source.indexOf('async function processMessage(');
  const end = source.indexOf('\nconst manualRecovery',start);
  const requests = [],diagnostics = [];
  const send = vm.runInNewContext(source.slice(start,end)+'\nprocessMessage',{
    sourceIdentity:guard,crypto,Date,saveDiagnostic:event => diagnostics.push(event),
    post:async(...args) => requests.push(args),console
  });
  const queue = createOutbox({state,send});
  const context = {group_openid:'exchange-group'};
  queue.enqueue(message,context);
  insert(1,liu);
  await queue.drain();
  assert.deepEqual(requests,[]);
  assert.equal(diagnostics[0].code,'QQ_SOURCE_CONFLICT_BLOCKED');
  assert.equal(state.prepare('SELECT status FROM sender_outbox').get().status,'blocked_source');
  const restarted = createOutbox({state,send:async()=>assert.fail('must not retry a quarantined source')});
  restarted.recover();
  restarted.enqueue(message,context);
  await restarted.drain();
  assert.equal(restarted.terminal(message,context),true);
});

test('archive read failures defer sending without network calls or terminal quarantine',async t => {
  const {guard,message,archives} = fixture(t);
  archives[1].exec('DROP TABLE discord_web_messages');
  const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
  const start = source.indexOf('async function processMessage(');
  const send = vm.runInNewContext(source.slice(start,source.indexOf('\nconst manualRecovery',start))+'\nprocessMessage',{
    sourceIdentity:guard,console:{warn:()=>{}},post:()=>assert.fail('must not send without validation')
  });
  assert.equal(await send(message),'deferred');
});

test('manual preview and queue reject conflicting sources and an unconfigured target group',async t => {
  const {state,insert,sourceFiles,guard,message} = fixture(t);
  state.exec(`CREATE TABLE replay_requests(id INTEGER PRIMARY KEY,channel_id TEXT,message_limit INTEGER,status TEXT,
    created_at TEXT,completed_at TEXT,group_openid TEXT,mode TEXT);
    CREATE TABLE replay_items(request_id INTEGER,source_message_id TEXT,content_sha256 TEXT,channel_id TEXT,source_timestamp TEXT,status TEXT);
    CREATE TABLE forward_attempts(source_message_id TEXT,status TEXT,group_openid TEXT,replay_request_id INTEGER);`);
  insert(0,exchange);
  let sends = 0;
  const recovery = createManualRecovery({state,target:{group_openid:'primary'},additionalChannelIds:new Set([exchange]),
    additionalTargets:()=>[{qq_group_number:'1130863739',group_openid:'exchange-group',channel_ids:[exchange]}],
    sourceFiles,sourceIdentity:guard,sourceTime:row=>Date.parse(row.source_timestamp),
    replayMessages:()=>[message],processMessage:async item => {
      if (!await guard.check(item)) return 'blocked_source';
      sends++;
      return 'accepted';
    },isOnline:()=>true,isPaused:()=>false,pauseGroup:()=>assert.fail('conflicts must not pause other channels')});
  const preview = () => recovery.recoveryCandidates(exchange,'1130863739');
  assert.equal(preview().items[0].ready,true);
  assert.throws(()=>recovery.recoveryCandidates(exchange,'1132949059'),/路由/);
  const selected = [{id:sourceId,hash:message.content_sha256}];
  const request = recovery.queueRecovery(exchange,'1130863739',selected);
  insert(1,liu);
  assert.equal(preview().source_conflict_count,1);
  await recovery.processNext();
  assert.equal(sends,0);
  const status = recovery.recoveryStatus(request.request_id);
  assert.equal(status.request.status,'blocked');
  assert.equal(status.items[0].status,'blocked_source');
  recovery.cancelRecovery(exchange,'1130863739');
  assert.equal(preview().items[0].source_conflict,true);
  assert.equal(preview().items[0].ready,false);
  assert.throws(()=>recovery.queueRecovery(exchange,'1130863739',selected),/来源频道冲突/);
});

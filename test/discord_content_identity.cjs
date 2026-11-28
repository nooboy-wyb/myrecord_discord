const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {DatabaseSync} = require('node:sqlite');
const {attachmentIdentityUrl,discordContentIdentity} = require('../scripts/discord_content_identity.cjs');
const {createAttachmentQueue} = require('../scripts/collector_attachment_queue.cjs');
const {createOutbox} = require('../scripts/qq/core/outbox.cjs');

const image = (signature,name='chart') => ({kind:'image',
  source_url:`https://cdn.discordapp.com/attachments/1/2/${name}.png?ex=${signature}&is=issued&hm=${signature}`});
const capture = (signature,extra={}) => ({source:'discord_web',channel_id:'1222944235691708477',
  source_message_id:'1575327687650578512',body_raw:'synthetic chart',attachments:[image(signature)],...extra});
function snapshot(signature,extra={}) {
  const m = capture(signature);
  return {...m,source_timestamp:'2026-11-26T01:00:00Z',captured_at:`2026-11-27T00:00:0${signature.length}Z`,
    content_sha256:crypto.createHash('sha256').update(JSON.stringify([m.body_raw,m.attachments])).digest('hex'),
    attachments_json:JSON.stringify(m.attachments),attachments:m.attachments.map(item => ({...item,status:'pending'})),...extra};
}
const route = {group_openid:'FIXTURE'};
function legacyJob(state,message,status='queued',context=route) {
  const key=crypto.createHash('sha256').update(JSON.stringify([context.group_openid,message.channel_id,
    message.source_message_id,message.content_sha256])).digest('hex');
  state.prepare(`INSERT INTO sender_outbox(task_key,source,group_openid,channel_id,source_message_id,
    source_timestamp,message_json,context_json,status,updated_at) VALUES (?,'discord',?,?,?,?,?,?,?,?)`)
    .run(key,context.group_openid,message.channel_id,message.source_message_id,message.source_timestamp,
      JSON.stringify(message),JSON.stringify(context),status,message.captured_at);
  return key;
}

test('only Discord signature metadata is excluded; real content and external URL changes remain versions',()=>{
  assert.equal(discordContentIdentity(capture('old')),discordContentIdentity(capture('new')));
  assert.notEqual(discordContentIdentity(capture('old')),discordContentIdentity(capture('new',{body_raw:'edited'})));
  assert.notEqual(discordContentIdentity(capture('old')),discordContentIdentity(capture('new',{attachments:[image('new'),image('new','second')]})));
  assert.notEqual(attachmentIdentityUrl('https://example.com/chart.png?hm=old'),attachmentIdentityUrl('https://example.com/chart.png?hm=new'));
  assert.notEqual(attachmentIdentityUrl(image('old').source_url+'&width=100'),attachmentIdentityUrl(image('new').source_url+'&width=200'));
  assert.equal(attachmentIdentityUrl(image('new').source_url.replace('cdn.discordapp.com','media.discordapp.net')),
    attachmentIdentityUrl(image('old').source_url));
});

test('refresh reuses a legacy archive row and saved image; later edits and added images are retained',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'muse-content-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const filename=require.resolve('../scripts/discord_collector_server.cjs');
  const exported={exports:{}};
  let queue,calls=0;
  const localRequire=name=>{
    if(name==='./collector_logger.cjs')return {};
    if(name==='./collector_diagnostics.cjs')return {saveDiagnostic:()=>{}};
    if(name==='./collector_page_status.cjs')return {createPageStatusReporter:()=>({})};
    if(name==='./collector_attachment_queue.cjs')return {createAttachmentQueue:options=>{
      queue=createAttachmentQueue({...options,fetchImpl:async()=>{calls++;return {ok:true,headers:new Headers(),arrayBuffer:async()=>Buffer.from('fixture png')};}});
      return queue;
    }};
    return name.startsWith('.')?require(path.resolve(path.dirname(filename),name)):require(name);
  };
  localRequire.main={};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:localRequire,module:exported,
    __dirname:path.dirname(filename),process:{env:{MUSE_DATA_DIR:root}},Buffer,URL,setTimeout,
    console:{log:()=>{},warn:()=>{},error:()=>{}}});
  const {save}=exported.exports;
  const first=save(capture('old'));
  await queue.runOnce();
  const file=path.join(root,fs.readdirSync(root).find(name=>/^\d{4}-\d{2}-\d{2}$/.test(name)),'messages.sqlite');
  const db=new DatabaseSync(file);
  try {
    const rawHash=snapshot('old').content_sha256;
    db.prepare('UPDATE discord_web_messages SET content_sha256=?,content_identity=NULL WHERE id=?').run(rawHash,first);
    assert.equal(save(capture('new')),first);
    await queue.runOnce();
    assert.equal(calls,1,'signature refresh reuses the saved original without downloading it again');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM discord_web_messages').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM discord_web_observations').get().n,2);
    const row=db.prepare('SELECT * FROM discord_web_messages').get();
    assert.equal(row.content_sha256,rawHash,'existing task hashes remain addressable');
    assert.equal(JSON.parse(row.attachments_json)[0].source_url,image('new').source_url);
    assert.equal(db.prepare('SELECT status FROM discord_web_attachment_files WHERE source_url=?').get(image('new').source_url).status,'saved');
    assert.notEqual(save(capture('new',{attachments:[image('new'),image('new','second')]})),first);
    assert.notEqual(save(capture('new',{body_raw:'edited'})),first);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM discord_web_messages').get().n,3);
  } finally {db.close();}
});

test('three signed snapshots queued together send once and stay accepted across restart and refresh',async()=>{
  const state=new DatabaseSync(':memory:');let sends=0;
  try {
    let queue=createOutbox({state,send:async()=>{sends++;return 'accepted';}});
    const keys=['a','bb','ccc'].map(signature=>queue.enqueue(snapshot(signature),route));
    assert.equal(new Set(keys).size,1);
    await queue.drain();
    queue=createOutbox({state,send:async()=>assert.fail('accepted message must not send again')});
    queue.recover();queue.enqueue(snapshot('dddd'),route);await queue.drain();
    assert.equal(sends,1);assert.equal(queue.terminal(snapshot('eeeee'),route),true);
  } finally {state.close();}
});

test('legacy pending copies of accepted content are retired without touching receipts or other messages',async()=>{
  const state=new DatabaseSync(':memory:');const sent=[];
  try {
    const queue=createOutbox({state,send:async m=>{sent.push(m.source_message_id);return 'accepted';}});
    const accepted=legacyJob(state,snapshot('a'),'accepted');
    legacyJob(state,snapshot('bb'));legacyJob(state,snapshot('ccc'),'deferred');
    queue.enqueue(snapshot('a',{source_message_id:'1575327687650578513'}),route);
    assert.equal(queue.recover().skipped_duplicate_tasks,2);
    assert.equal(state.prepare('SELECT status FROM sender_outbox WHERE task_key=?').get(accepted).status,'accepted');
    await queue.drain();assert.deepEqual(sent,['1575327687650578513']);
    assert.equal(queue.recover().skipped_duplicate_tasks,0);
    assert.equal(queue.terminal(snapshot('fresh'),route),true);
  } finally {state.close();}
});

test('legacy unfinished copies retain acknowledged parts and newest usable images through repeated recovery',async()=>{
  const state=new DatabaseSync(':memory:');
  state.exec('CREATE TABLE forward_attempts(task_key TEXT,part_index INTEGER,part_type TEXT,status TEXT,attempted_at TEXT,PRIMARY KEY(task_key,part_index))');
  const sent=[];
  try {
    const queue=createOutbox({state,send:async m=>{sent.push(m);return 'accepted';}});
    const a=snapshot('a',{attachments:[{...image('a'),status:'saved',local_path:'fixture.png'}]}),b=snapshot('bb');
    const first=legacyJob(state,a,'deferred'),second=legacyJob(state,b);
    state.prepare('INSERT INTO forward_attempts VALUES (?,0,?, ?,?)').run(first,'text','accepted','2026-11-27T00:00:00Z');
    state.prepare('INSERT INTO forward_attempts VALUES (?,1,?, ?,?)').run(second,'image','accepted','2026-11-27T00:00:01Z');
    assert.equal(queue.recover().skipped_duplicate_tasks,1);
    queue.recover();await queue.drain();
    assert.equal(sent.length,1);assert.equal(sent[0].content_sha256,a.content_sha256);
    assert.equal(sent[0].attachments[0].source_url,image('bb').source_url);
    assert.equal(sent[0].attachments[0].status,'saved');
    assert.equal(state.prepare("SELECT COUNT(*) n FROM forward_attempts WHERE task_key=? AND status='accepted'").get(first).n,2);
  } finally {state.close();}
});

test('unknown sends remain quarantined while genuine edits, new images, groups and channels stay distinct',async()=>{
  const state=new DatabaseSync(':memory:');const sent=[];
  try {
    const queue=createOutbox({state,send:async(m,c)=>{sent.push([m.source_message_id,c.group_openid]);return 'accepted';}});
    legacyJob(state,snapshot('a'),'unknown');legacyJob(state,snapshot('bb'));
    queue.recover();queue.enqueue(snapshot('ccc'),route);await queue.drain();assert.equal(sent.length,0);
    const other={...snapshot('edit'),source_message_id:'1575327687650578513'};
    queue.enqueue(other,route);
    queue.enqueue({...other,body_raw:'actual edit',content_sha256:'actual-edit-hash'},route);
    queue.enqueue({...other,attachments_json:JSON.stringify([image('edit'),image('edit','second')]),content_sha256:'added-image-hash'},route);
    queue.enqueue(other,{group_openid:'OTHER'});
    queue.enqueue({...other,channel_id:'other-channel'},route);
    await queue.drain();assert.equal(sent.length,5);
  } finally {state.close();}
});

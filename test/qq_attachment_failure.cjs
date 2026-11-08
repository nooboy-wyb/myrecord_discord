const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {DatabaseSync} = require('node:sqlite');
const {test} = require('node:test');
const liuyudong = require('../scripts/qq_channels/liuyudong/index.cjs');

const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
const section = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const functions = [
  section('function splitText(','async function token('),
  section('function liveMessageEligible(','function speakerName('),
  section('function attachmentFiles(','async function processMessage('),
  section('async function processMessage(','const manualRecovery ='),
  section('async function tick(','function start('),
].join('\n');
const keyFor = (message,group = 'primary') => crypto.createHash('sha256').update(JSON.stringify([
  group,message.channel_id,message.source_message_id,message.content_sha256
])).digest('hex');
const image = status => ({source_url:'https://cdn.discordapp.com/attachments/1/2/image.png',
  local_path:'test/image.png',status,download_status:status,download_attempts:5,error:'attachment download timeout'});
const message = (id,attachments = []) => ({channel_id:liuyudong.channelId,source_message_id:String(id),
  content_sha256:'digest',source_timestamp:new Date(Date.now()-180000).toISOString(),body_raw:'synthetic',
  attachments_json:JSON.stringify(attachments.map(item=>({source_url:item.source_url}))),attachments});
function fixture(t) {
  const state = new DatabaseSync(':memory:');
  t.after(()=>state.close());
  state.exec(`CREATE TABLE forward_meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO forward_meta VALUES ('start_at','2026-11-01T00:00:00Z');
    CREATE TABLE forward_attempts(task_key TEXT,part_index INTEGER,part_type TEXT,source_message_id TEXT,
      group_openid TEXT,status TEXT,attempted_at TEXT,http_status INTEGER,platform_code TEXT,
      platform_message_id TEXT,error TEXT,channel_id TEXT,source_timestamp TEXT,origin TEXT,replay_request_id INTEGER,
      PRIMARY KEY(task_key,part_index));
    CREATE TABLE replay_requests(id INTEGER,status TEXT,mode TEXT);`);
  const messages = [],requests = [],diagnostics = [],warnings = [],advanced = [];
  const fileSystem = {existsSync:()=>true,statSync:()=>({size:5}),readFileSync:()=>Buffer.from('image')};
  const liuModule = {exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/qq_channels/liuyudong/index.cjs'),'utf8'),
    {module:liuModule,require:()=>fileSystem,Date});
  const context = vm.createContext({crypto,path,Date,Buffer,state,liuyudong:liuModule.exports,
    target:{group_openid:'primary'},running:false,online:true,paused:false,
    fs:fileSystem,
    tia:{channelId:'tia'},fengxun:{channelId:'feng',afterSend:()=>{}},
    yanchi:{channelIds:[],fanwanChannelId:'fan',afterSend:()=>{}},
    groupCooldownUntil:new Map(),rateLimitCooldownMs:120000,pausedGroups:new Set(),reportedUnconfirmed:new Set(),
    primaryControl:()=>({}),primaryAcceptsMessage:()=>true,additionalTargets:()=>[],pendingMessages:()=>messages,
    sourceTime:item=>Date.parse(item.source_timestamp),liveWatermark:()=>null,isAfterLiveWatermark:()=>true,
    advanceLiveWatermark:(group,item)=>advanced.push(item.source_message_id),
    manualRecovery:{processNext:async()=>{}},messageHeading:()=> 'heading',sourceTimeLabel:()=>'',
    post:async endpoint=>{requests.push(endpoint);return endpoint==='files'?{file_info:'file'}:{id:'accepted'};},
    saveDiagnostic:event=>diagnostics.push(event),alerts:{notify:()=>{throw Error('unexpected alert');}},
    pauseGroup:()=>{throw Error('unexpected group pause');},
    console:{log:()=>{},warn:line=>warnings.push(line),error:()=>{}},
  });
  const api = vm.runInContext(functions+'\n({processMessage,tick,record,liveMessageEligible,attachmentFiles})',context);
  return {state,context,api,messages,requests,diagnostics,warnings,advanced};
}

test('exhausted Liu attachments are recorded once and the next message sends in the same tick',async t=>{
  const {state,context,api,messages,requests,diagnostics,warnings,advanced} = fixture(t);
  const failed = message('1568956663539695738',[image('failed'),{...image('failed'),source_url:'https://cdn.discordapp.com/attachments/1/2/second.png'}]);
  const next = message('1568956663539695739');
  api.record(keyFor(failed),0,'image',failed,'preparing');
  messages.push(failed,next);
  await api.tick();
  assert.equal(state.prepare('SELECT status FROM forward_attempts WHERE task_key=? AND part_index=0').get(keyFor(failed)).status,'skipped_attachment');
  assert.equal(state.prepare('SELECT count(*) AS n FROM forward_attempts WHERE task_key=?').get(keyFor(failed)).n,2);
  assert.deepEqual(requests,['messages']);
  assert.deepEqual(advanced,[next.source_message_id]);
  assert.equal(diagnostics.length,1);
  assert.equal(diagnostics[0].code,'QQ_ATTACHMENT_SKIPPED');
  assert.equal(diagnostics[0].detail.failures[0].attempts,5);
  assert.equal(diagnostics[0].detail.failures.length,2);
  assert.equal(api.liveMessageEligible('primary',failed,0),false);
  assert.equal(await api.processMessage(failed),'skipped_attachment');
  vm.runInContext(functions,context);
  assert.equal(await vm.runInContext('processMessage',context)(failed),'skipped_attachment');
  assert.equal(diagnostics.length,1);
  assert.equal(warnings.length,1);
  assert.equal(requests.length,1);
});

test('failed images stop retrying without changing accepted text or resending it',async t=>{
  const {state,api,requests} = fixture(t);
  const item = {...message('1568956663539695740',[image('failed')]),channel_id:'exchange'};
  api.record(keyFor(item),0,'text',item,'accepted',{platformId:'existing'});
  api.record(keyFor(item),1,'image',item,'failed_preflight');
  assert.equal(await api.processMessage(item),'skipped_attachment');
  const text = state.prepare('SELECT status,platform_message_id FROM forward_attempts WHERE task_key=? AND part_index=0').get(keyFor(item));
  assert.equal(text.status,'accepted');
  assert.equal(text.platform_message_id,'existing');
  assert.equal(requests.length,0);
});

test('unknown QQ send results remain unknown when a different attachment fails',async t=>{
  const {state,api,requests,diagnostics} = fixture(t);
  const item = message('1568956663539695741',[image('saved'),{...image('failed'),source_url:'https://cdn.discordapp.com/attachments/1/2/other.png'}]);
  api.record(keyFor(item),0,'image',item,'unknown');
  assert.equal(await api.processMessage(item),'unknown');
  assert.equal(state.prepare('SELECT status FROM forward_attempts WHERE task_key=?').get(keyFor(item)).status,'unknown');
  assert.equal(requests.length,0);
  assert.equal(diagnostics.length,0);
});

test('pending downloads keep waiting and send as soon as originals are saved',async t=>{
  const {api,messages,requests,diagnostics} = fixture(t);
  const item = message('1568956663539695742',[image('pending')]);
  messages.push(item);
  await api.tick();
  assert.equal(requests.length,0);
  assert.equal(diagnostics.length,0);
  item.attachments[0] = image('saved');
  await api.tick();
  assert.deepEqual(requests,['files','messages']);
});

test('failure records redact URLs and are isolated by target group',async t=>{
  const {api,diagnostics,warnings} = fixture(t);
  const item = message('1568956663539695743',[{...image('failed'),error:'private https://example.com/?secret=token'}]);
  assert.equal(await api.processMessage(item),'skipped_attachment');
  assert.equal(api.liveMessageEligible('other-group',item,0),true);
  assert.equal(await api.processMessage(item,{group_openid:'other-group'}),'skipped_attachment');
  assert.equal(diagnostics.length,2);
  const output = JSON.stringify({diagnostics,warnings});
  assert(!output.includes('https:'));
  assert(!output.includes('secret'));
  assert(!output.includes('private'));
});

test('attachment reads use persisted attempts and support archives without a job table',t=>{
  const {state,api} = fixture(t);
  state.exec(`CREATE TABLE discord_web_attachment_files(message_id INTEGER,source_url TEXT,
    local_path TEXT,status TEXT,error TEXT);
    INSERT INTO discord_web_attachment_files VALUES(1,'image',NULL,'failed','attachment download timeout');`);
  assert.equal(api.attachmentFiles(state,1)[0].download_status,undefined);
  state.exec(`CREATE TABLE discord_web_attachment_jobs(message_id INTEGER,source_url TEXT,status TEXT,attempts INTEGER);
    INSERT INTO discord_web_attachment_jobs VALUES(1,'image','failed',5);`);
  const row = api.attachmentFiles(state,1)[0];
  assert.equal(row.download_status,'failed');
  assert.equal(row.download_attempts,5);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn,execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {once} = require('node:events');
const {DatabaseSync} = require('node:sqlite');
const {policy,transition,assess,stopStalledTelegram,run} = require('../scripts/service_monitor.cjs');
const {buildHandoff} = require('../scripts/monitor_handoff.cjs');
const {notifyTelegram} = require('../scripts/monitor_notices.cjs');
const project = path.resolve(__dirname,'..');
const now = Date.now();
const old = new Date(now-600000).toISOString();
const iso = new Date(now).toISOString();
const command = root => `python "${path.join(root,'scripts','telegram','collector.py')}" monitor --data-dir "${path.join(root,'data','telegram')}"`;

test('only a single verified stale TG instance qualifies; two observations and the original restart budget apply',() => {
  const processes = [{ProcessId:10,ParentProcessId:1,CreatedAt:old,CommandLine:command(project)}];
  const observation = assess('telegram',{processes,telegram:{at:old,phase:'scanning'},recover:true},now,project);
  assert(observation.stalled);
  let state = transition({},observation,now);
  assert.equal(state.action,'none');
  state = transition(state,observation,now+60000);
  assert.equal(state.action,'restart');
  assert.equal(transition({...state,restarts:[now]},observation,now+60000).state,'COOLDOWN');
  assert.equal(transition({...state,restarts:[now-600000,now-400000,now]},observation,now+60000).state,'RESTART_LIMITED');
  for (const fields of [{paused:true},{inspection_error:'unreadable'},{recover:false}])
    assert.equal(transition(state,{...observation,...fields},now+60000).action,'none');
  for (const extra of [
    {telegram:{at:iso}},
    {telegram:{at:old,error:'PermissionError',error_message:'Telegram session is unauthorized'}},
    {processes:[{...processes[0],CreatedAt:null}]},
    {processes:[...processes,{...processes[0],ProcessId:12}]}
  ]) assert(!assess('telegram',{processes,telegram:{at:old},recover:true,...extra},now,project).stalled);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'muse telegram recovery '));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'monitor','handoff'),{recursive:true});
  fs.mkdirSync(path.join(root,'telegram'));
  fs.writeFileSync(path.join(root,'qq-bot-credential.xml'),'placeholder; transport is mocked');
  fs.writeFileSync(path.join(root,'qq-alert-recipient.json'),'{}');
  const observation = {state:'DEGRADED',running:true,instance_count:1,first_failure_at:old,issues:[]};
  const packet = buildHandoff(null,'telegram',observation,{a:{role:'telegram',code:'SCAN_STATUS_STALE',category:'BUSINESS',first_seen_at:old}},iso);
  const file = path.join(root,'monitor','handoff','telegram.json');
  fs.writeFileSync(file,JSON.stringify(packet));
  const sent = [];
  const options = {project,root,now,report:{roles:{telegram:observation}},send:async ({notice}) => {sent.push(notice);return true;}};
  return {root,file,options,sent,packet,observation};
}

test('TG fault and recovery notices persist deduplication across monitor restarts',async t => {
  const f = fixture(t);
  assert.equal((await notifyTelegram(f.options)).accepted,true);
  await notifyTelegram(f.options);
  assert.equal(f.sent.length,1);
  const resolved = buildHandoff(f.packet,'telegram',{...f.observation,state:'HEALTHY'}, {}, iso);
  fs.writeFileSync(f.file,JSON.stringify(resolved));
  await notifyTelegram(f.options);
  await notifyTelegram(f.options);
  assert.deepEqual(f.sent.map(item => item.kind),['opened','recovered']);
});

test('private notification failures retry with a five minute cooldown and stop after three attempts',async t => {
  const f = fixture(t);
  let attempts = 0;
  const options = {...f.options,send:async () => {attempts++;return false;}};
  await notifyTelegram(options);
  await notifyTelegram({...options,now:now+60000});
  assert.equal(attempts,1);
  for (const delta of [300000,600000,900000]) await notifyTelegram({...options,now:now+delta});
  assert.equal(attempts,3);
});

test('a connection repaired between supervisor ticks still generates one recovery notice',async t => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  fs.writeFileSync(path.join(f.root,'telegram','connection-recovery.json'),JSON.stringify({
    id:f.packet.id,state:'recovered',recovered_at:iso,attempts:1}));
  await notifyTelegram(f.options);
  await notifyTelegram(f.options);
  assert.deepEqual(f.sent.map(item => item.kind),['recovered']);
  assert.match(f.sent[0].content,/重建连接/);
});

test('paused or uncertain inspection never sends or falsely announces a recovery',async t => {
  const f = fixture(t);
  for (const fields of [{paused:true},{inspection_error:'CIM unavailable'}])
    await notifyTelegram({...f.options,report:{roles:{telegram:{...f.observation,...fields}}}});
  assert.equal(f.sent.length,0);
});

test('complete monitor rounds stop only stalled TG, confirm absence and preserve the committed restart budget on failure',async t => {
  for (const failed of [false,true]) {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.root,'logs'));
    fs.writeFileSync(path.join(f.root,'collector-token.txt'),'fixture-only-token');
    fs.writeFileSync(path.join(f.root,'telegram','monitor-status.json'),JSON.stringify({at:old,phase:'scanning',sources:[]}));
    const db = new DatabaseSync(path.join(f.root,'qq-forward.sqlite'));
    db.exec('CREATE TABLE sender_outbox(source TEXT,status TEXT,source_timestamp TEXT,updated_at TEXT,error TEXT); CREATE TABLE forward_attempts(status TEXT);');
    db.close();
    let alive = true,stops = 0,starts = 0;
    const opts = {project,root:f.root,recover:true,now,notify:async () => ({}),
      inspect:async () => ({processes:alive ? [{ProcessId:100,ParentProcessId:1,CreatedAt:old,
        CommandLine:`python "${path.join(project,'scripts','telegram','collector.py')}" monitor --data-dir "${path.join(f.root,'telegram')}"`}] : [],listeners:[]}),
      probe:async () => ({}),
      stop:async () => {stops++;if (failed) throw Error('Identity changed');alive=false;return {pids:[100]};},
      start:async role => {assert.equal(role,'telegram');assert(!alive);starts++;return {pid:101};}};
    await run(opts);
    const report = await run({...opts,now:now+60000});
    assert.equal(stops,1);
    assert.equal(starts,failed ? 0 : 1);
    assert.equal(report.roles.telegram.state,failed ? 'START_FAILED' : 'STARTING');
    const state = JSON.parse(fs.readFileSync(path.join(f.root,'monitor','state.json'),'utf8'));
    assert.deepEqual(state.roles.telegram.restarts,[now+60000]);
  }
});

test('Windows stall recovery rechecks live identity and heartbeat before stopping a temporary TG worker',
  {skip:process.platform !== 'win32',timeout:20000},async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse isolated TG '));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) {child.kill();await once(child,'exit');}
      await fs.promises.rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    });
    fs.mkdirSync(path.join(folder,'scripts','telegram'),{recursive:true});
    fs.mkdirSync(path.join(folder,'data','telegram'),{recursive:true});
    fs.copyFileSync(path.join(project,'scripts','stop_stalled_telegram.ps1'),path.join(folder,'scripts','stop_stalled_telegram.ps1'));
    const entry = path.join(folder,'scripts','telegram','collector.py');
    fs.writeFileSync(entry,'import time\ntime.sleep(30)\n');
    const python = process.env.MUSE_TEST_PYTHON || path.join(project,'data','local-validation','python','Scripts','python.exe');
    child = spawn(python,[entry,'monitor','--data-dir',path.join(folder,'data','telegram')],{windowsHide:true,stdio:'ignore'});
    await once(child,'spawn');
    const stopped = once(child,'exit');
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${child.pid} -or $_.ParentProcessId -eq ${child.pid} } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='CreatedAt';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`;
    const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});
    const processes = [JSON.parse(stdout)].flat();
    const observation = assess('telegram',{processes,telegram:{at:old},recover:true},now,folder);
    assert(observation.stalled);
    const statusFile = path.join(folder,'data','telegram','monitor-status.json');
    fs.writeFileSync(statusFile,JSON.stringify({at:iso}));
    await assert.rejects(stopStalledTelegram(observation,folder,path.join(folder,'data')),/progressed|no longer stale/);
    process.kill(child.pid,0);
    fs.writeFileSync(statusFile,JSON.stringify({at:old}));
    const result = await stopStalledTelegram(observation,folder,path.join(folder,'data'));
    assert.equal(result.reason,'confirmed_scan_stall');
    await stopped;
  });

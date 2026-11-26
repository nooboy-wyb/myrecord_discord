const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {DatabaseSync} = require('node:sqlite');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {policy,transition,assess,processMatches,gatewayStatus,classifyError,scrub,run,launch,incidents} = require('../scripts/service_monitor.cjs');
const now = Date.parse('2026-11-26T07:00:00Z');
const iso = new Date(now).toISOString();
const project = path.resolve(__dirname,'..');
const missing = {running:false,starting:false,issues:[],recover:true};
const ready = {running:true,issues:[],recover:true};
const health = role => role === 'discord' ? {role:'discord-collector',received:0,last_capture_at:null,
  pages:{at:iso,enabled:['100'],open:['100'],scanning:['100'],issues:[]}}
  : {role:'qq-sender',online:true,running:false,planners:{discord:{ok:true,at:iso},telegram:{at:iso,blocked:[]}}};

test('FSM confirms missing twice, respects cooldown, caps persisted attempts and reopens the rolling window',() => {
  let state = transition(undefined,missing,now);
  assert.equal(state.state,'SUSPECT');
  assert.equal(state.action,'none');
  state = transition(state,missing,now+60000);
  assert.equal(state.action,'start');
  state = {...state,restarts:[now+60000],last_start_at:now+60000};
  assert.equal(transition(state,missing,now+90000).state,'STARTING');
  assert.equal(transition(state,missing,now+200000).state,'COOLDOWN');
  assert.equal(transition(state,missing,now+400000).action,'start');
  state.restarts = [now-600000,now-300000,now];
  state.last_start_at = now-300000;
  assert.equal(transition(state,missing,now+60000).state,'RESTART_LIMITED');
  assert.equal(transition(state,missing,now+policy.window_ms+1).action,'start');
});

test('FSM never restarts live business failures, paused roles, uncertain inspections, port conflicts or stale launchers',() => {
  assert.equal(transition({},ready,now).state,'HEALTHY');
  for (const issue of ['NETWORK','AUTHORIZATION','PERMISSION','STORAGE_OR_DATA','ATTACHMENT','SEND_UNKNOWN']) {
    const result = transition({}, {...ready,issues:[{code:issue}]},now);
    assert.equal(result.state,'DEGRADED');
    assert.equal(result.action,'none');
  }
  for (const [fields,state] of [
    [{paused:true},'PAUSED'],[{inspection_error:'CIM unavailable'},'INSPECTION_FAILED'],
    [{port_busy:true},'CONFLICT'],[{health_present:true},'CONFLICT'],
    [{recover:false},'STOPPED'],[{recovery_blocked:true},'MANUAL_REQUIRED'],[{starting:true},'DEGRADED']
  ]) {
    const result = transition({missing_count:5},{...missing,...fields},now);
    assert.equal(result.state,state);
    assert.equal(result.action,'none');
  }
});

test('pause and failed inspection preserve existing incidents without claiming recovery',() => {
  const log = [];
  const initial = {discord:{issues:[]},telegram:{issues:[{code:'SCAN_ERROR',error:'ConnectionError'}]},qq:{issues:[]}};
  const before = incidents({},initial,iso,event => log.push(event));
  for (const fields of [{paused:true},{inspection_error:'CIM unavailable'}]) {
    const after = incidents(before,{...initial,telegram:{issues:[],...fields}},iso,event => log.push(event));
    assert.deepEqual(after,before);
  }
  assert(!log.some(event => event.event === 'resolved'));
  const observed = assess('telegram',{inspection_error:'CIM unavailable'},now,project);
  assert(!observed.issues.some(issue => issue.code === 'PROCESS_ABSENT'));
});

test('no new messages and an idle QQ drain are healthy while scan progress and heartbeat remain current',() => {
  const discord = assess('discord',{processes:[{ProcessId:1,CommandLine:`node "${path.join(project,'scripts','discord_collector_server.cjs')}"`}],
    health:{present:true,value:health('discord')}},now,project);
  assert.deepEqual(discord.issues,[]);
  const qq = assess('qq',{processes:[{ProcessId:2,CommandLine:`node "${path.join(project,'scripts','qq','sender.cjs')}"`}],
    health:{present:true,value:health('qq')},gateway:{last_ack_at:iso,ack_age_ms:0},queue:{groups:[],unknown_parts:0}},now,project);
  assert.deepEqual(qq.issues,[],'running=false means an idle planner/drain, not an exited service');
});

test('Python venv launcher and child count as one instance; different data directories and entry suffixes do not match',() => {
  const command = `python "${path.join(project,'scripts','telegram','collector.py')}" monitor --data-dir "${path.join(project,'data','telegram')}"`;
  const processes = [{ProcessId:10,ParentProcessId:1,CommandLine:command},{ProcessId:11,ParentProcessId:10,CommandLine:command}];
  const input = {processes,telegram:{at:iso,sources:[{status:'ok',scan_until:iso,read:0,inserted:0}]}};
  const result = assess('telegram',input,now,project);
  assert.equal(result.instance_count,1);
  assert.deepEqual(result.issues,[]);
  assert.equal(assess('telegram',input,now,project,path.join(project,'other-data')).running,false);
  assert.equal(processMatches(command,path.join(project,'scripts','telegram','collector.py.bak')),false);
  assert.equal(processMatches(`node "${path.join(project,'scripts','qq','sender.cjs')}.bak"`,path.join(project,'scripts','qq','sender.cjs')),false);
  processes.push({ProcessId:12,ParentProcessId:1,CommandLine:command});
  assert(assess('telegram',input,now,project).issues.some(item => item.code === 'MULTIPLE_PROCESSES'));
});

test('remote error classes retain corrective handling and never authorize replaying unknown sends',() => {
  for (const [message,expected] of [
    ['Telethon ConnectionError: Server closed the connection','NETWORK'],
    ['PermissionError Telegram session is unauthorized','AUTHORIZATION'],
    ['ChannelPrivateError','PERMISSION'],['Original image unavailable: HTTP 404','ATTACHMENT'],
    ['SQLite disk write failed','STORAGE_OR_DATA'],['QQ rate_limited','RATE_LIMIT'],['send unknown','SEND_UNKNOWN']
  ]) assert.equal(classifyError(message).category,expected);
  assert.equal(classifyError('unknown').handling,'quarantine_no_retry');
  const telegram = assess('telegram',{telegram:{at:iso,error:'PermissionError',error_message:'Telegram session is unauthorized'}},now,project);
  assert.equal(transition({missing_count:5},{...telegram,recover:true},now).state,'MANUAL_REQUIRED');
});

test('stale pages, SQLite failures, TG permissions, planner errors, queue backlog and unknown outcomes are distinct',() => {
  const dc = assess('discord',{health:{value:{...health('discord'),pages:{at:iso,issues:[{id:'123',status:'scan unresponsive'}]},
    last_storage_error:{at:iso,error:'SQLITE_BUSY'}}}},now,project);
  assert(dc.issues.some(item => item.code === 'PAGE_SCAN_ERROR'));
  assert(dc.issues.some(item => item.code === 'SQLITE_WRITE_FAILED'));
  const qq = assess('qq',{health:{value:{...health('qq'),online:false,
    planners:{discord:{ok:false,error:'SQLite busy',at:iso},telegram:{at:iso,blocked:['route missing']}}}},
    gateway:{last_ack_at:new Date(now-600000).toISOString(),ack_age_ms:600000},
    queue:{unknown_parts:1,groups:[{source:'discord',status:'deferred',count:3,oldest_source_at:new Date(now-3600000).toISOString()}],
      recent_errors:[{source:'discord',status:'deferred',updated_at:iso,error:'Original image unavailable: HTTP 404'}]}},now,project);
  for (const code of ['GATEWAY_OFFLINE','GATEWAY_ACK_STALE','PLANNER_ERROR','PLANNER_BLOCKED','QUEUE_BACKLOG','QUEUE_ERROR','SEND_UNKNOWN'])
    assert(qq.issues.some(item => item.code === code),code);
  assert.equal(qq.issues.find(item => item.code === 'SEND_UNKNOWN').automatic_retry,false);
});

test('bounded Gateway log reader recognizes actual ACKs instead of HTTP responses or heartbeat sends',() => {
  const text = '[2026-11-26 14:59:00 +08:00] LOG QQ Gateway 心跳确认：{"connection_id":"a","round_trip_ms":62,"heartbeat_acked":5}\n'
    +'[2026-11-26 14:59:42 +08:00] LOG QQ Gateway 心跳发送：{"connection_id":"b","heartbeat_sent":1}\n';
  const result = gatewayStatus(text,now);
  assert.equal(result.ack_age_ms,60000);
  assert.equal(result.connection_id,'b');
  assert.equal(gatewayStatus('no ACK',now).last_ack_at,null);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'muse monitor '));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'telegram'));
  fs.mkdirSync(path.join(root,'logs'));
  fs.writeFileSync(path.join(root,'collector-token.txt'),'test-health-token');
  fs.writeFileSync(path.join(root,'telegram','monitor-status.json'),JSON.stringify({role:'telegram-collector',at:iso,sources:[]}));
  fs.writeFileSync(path.join(root,'logs','qq-sender-2026-11-26.log'),
    '[2026-11-26 15:00:00 +08:00] LOG QQ Gateway 心跳确认：{"connection_id":"test","round_trip_ms":1,"heartbeat_acked":1}\n');
  const db = new DatabaseSync(path.join(root,'qq-forward.sqlite'));
  db.exec(`CREATE TABLE sender_outbox(source TEXT,status TEXT,source_timestamp TEXT,updated_at TEXT,error TEXT);
    CREATE TABLE forward_attempts(status TEXT);
    INSERT INTO forward_attempts VALUES ('unknown');
    INSERT INTO sender_outbox VALUES ('discord','unknown','2026-11-26T00:00:00Z','2026-11-26T00:00:00Z','uncertain');`);
  db.close();
  const commands = {
    discord:`node "${path.join(project,'scripts','discord_collector_server.cjs')}"`,
    qq:`node "${path.join(project,'scripts','qq','sender.cjs')}"`,
    telegram:`python "${path.join(project,'scripts','telegram','collector.py')}" monitor --data-dir "${path.join(root,'telegram')}"`
  };
  const alive = new Set(['discord','qq']);
  const starts = [];
  const options = {project,root,recover:true,now,
    inspect:async () => ({processes:[...alive].map((role,index) => ({ProcessId:index+100,CommandLine:commands[role]})),listeners:[]}),
    probe:async port => ({present:true,value:health(port === 8765 ? 'discord' : 'qq')}),
    start:async role => {starts.push(role);return {pid:999};}};
  return {root,options,alive,starts};
}

test('full local rounds recover only missing TG, persist budget, preserve unknown DB rows and record resolution',async t => {
  const f = fixture(t);
  const dbBefore = fs.readFileSync(path.join(f.root,'qq-forward.sqlite'));
  let report = await run(f.options);
  assert.equal(report.roles.telegram.state,'SUSPECT');
  report = await run({...f.options,now:now+60000});
  assert.deepEqual(f.starts,['telegram']);
  assert.equal(report.roles.telegram.state,'STARTING');
  await run({...f.options,now:now+90000});
  assert.equal(f.starts.length,1);
  f.alive.add('telegram');
  report = await run({...f.options,now:now+120000});
  assert.equal(report.roles.telegram.state,'HEALTHY');
  assert.deepEqual(report.roles.telegram.restarts,[now+60000]);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'qq-forward.sqlite')),dbBefore);
  const events = fs.readFileSync(path.join(f.root,'monitor','events-2026-11-26.jsonl'),'utf8');
  assert(events.includes('restart_started'));
  assert(events.includes('resolved'));
  assert(events.includes('SEND_UNKNOWN'));
});

test('each missing role independently receives the start action and leaves the other two running',async t => {
  for (const selected of ['discord','telegram','qq']) {
    const f = fixture(t);
    f.alive.clear();
    for (const role of ['discord','telegram','qq']) if (role !== selected) f.alive.add(role);
    f.options.probe = async port => {
      const role = port === 8765 ? 'discord' : 'qq';
      return role === selected ? {present:false,error:'ECONNREFUSED'} : {present:true,value:health(role)};
    };
    await run(f.options);
    const result = await run({...f.options,now:now+60000});
    assert.deepEqual(f.starts,[selected]);
    assert.equal(result.roles[selected].state,'STARTING');
    for (const role of ['discord','telegram','qq']) if (role !== selected) assert.equal(result.roles[role].action,'none');
  }
});

test('queue isolation remains visible when the QQ health endpoint is down',() => {
  const qq = assess('qq',{health:{present:false,error:'ECONNREFUSED'},queue:{groups:[],unknown_parts:1}},now,project);
  assert(qq.issues.some(item => item.code === 'SEND_UNKNOWN'));
  assert(qq.issues.some(item => item.code === 'HEALTH_UNAVAILABLE'));
});

test('long Telegram catch-up and persistent network failures remain observable without restarting a live process',async t => {
  const f = fixture(t);
  f.alive.add('telegram');
  fs.writeFileSync(path.join(f.root,'telegram','monitor-status.json'),JSON.stringify({at:iso,phase:'scanning',
    sources:[{peer_id:'-1001',status:'scanning',started_at:iso,last_progress_at:iso,read:10000,verified:10000}]}));
  const report = await run({...f.options,now:now+1800000});
  assert.equal(report.roles.telegram.state,'DEGRADED');
  assert(report.roles.telegram.issues.some(issue => issue.code === 'SCAN_STATUS_STALE'));
  assert.deepEqual(f.starts,[]);
});

test('independent monitor rounds consume failed launch budgets and stop after three attempts',async t => {
  const f = fixture(t);
  f.options.start = async role => {f.starts.push(role);throw Error('simulated launch failure');};
  await run(f.options);
  for (const offset of [60000,400000,800000]) await run({...f.options,now:now+offset});
  const report = await run({...f.options,now:now+1200000});
  assert.equal(f.starts.length,3);
  assert.equal(report.roles.telegram.state,'RESTART_LIMITED');
  assert.equal(report.roles.discord.restarts.length,0);
  assert.equal(report.roles.qq.restarts.length,0);
});

test('subsequent rounds retain and audit a monitored process exit code',async t => {
  const f = fixture(t);
  const exitFile = path.join(f.root,'monitor','fixture-exit.json');
  f.options.start = async () => ({pid:999,exit_file:exitFile});
  await run(f.options);
  await run({...f.options,now:now+60000});
  fs.writeFileSync(exitFile,JSON.stringify({role:'telegram',exited_at:iso,exit_code:7,error_type:'RuntimeException'}));
  const report = await run({...f.options,now:now+300000});
  assert.equal(report.roles.telegram.last_launch.exit.exit_code,7);
  const events = fs.readFileSync(path.join(f.root,'monitor','events-2026-11-26.jsonl'),'utf8');
  assert.equal(events.split('\n').filter(line => line.includes('process_exited')).length,1);
});

test('manual pause, observation mode, inventory failure, corrupted state and overlapping runs cannot launch services',async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root,'monitor'));
  fs.writeFileSync(path.join(f.root,'monitor','pause-telegram'),'');
  assert.equal((await run(f.options)).roles.telegram.state,'PAUSED');
  fs.unlinkSync(path.join(f.root,'monitor','pause-telegram'));
  assert.equal((await run({...f.options,recover:false})).roles.telegram.state,'STOPPED');
  assert.equal((await run({...f.options,inspect:async () => {throw Error('CIM unavailable');}})).roles.telegram.state,'INSPECTION_FAILED');
  let release;
  const waiting = run({...f.options,inspect:() => new Promise(resolve => {release = () => resolve({processes:[]});})});
  await assert.rejects(run(f.options),/already running/);
  release();
  await waiting;
  fs.writeFileSync(path.join(f.root,'monitor','state.json'),'{broken');
  await assert.rejects(run(f.options),SyntaxError);
  fs.writeFileSync(path.join(f.root,'monitor','state.json'),JSON.stringify({roles:{telegram:{restarts:'invalid',missing_count:2}},incidents:{}}));
  await assert.rejects(run(f.options),/Invalid monitor recovery budget/);
  assert.deepEqual(f.starts,[]);
});

test('local recovery action starts a real disposable child for the selected role only',async t => {
  const f = fixture(t);
  let child;
  t.after(async () => {if (child && child.exitCode === null) {const closed = once(child,'close');child.kill();await closed;}});
  f.options.start = async role => {
    assert.equal(role,'telegram');
    child = spawn(process.execPath,['-e','setInterval(() => {},1000)'],{stdio:'ignore',windowsHide:true});
    await once(child,'spawn');
    return {pid:child.pid};
  };
  await run(f.options);
  const report = await run({...f.options,now:now+60000});
  assert.equal(report.roles.telegram.recovery.pid,child.pid);
  process.kill(child.pid,0);
  assert.equal(report.roles.qq.action,'none');
  assert.equal(report.roles.discord.action,'none');
});

test('status and logs redact credentials, URLs and message payloads',async t => {
  const f = fixture(t);
  const redacted = scrub({token:'private',body_raw:'message',error_message:'api_hash=private https://proxy.invalid/secret test-health-token'},['test-health-token']);
  assert(!JSON.stringify(redacted).includes('private'));
  assert(!JSON.stringify(redacted).includes('proxy.invalid'));
  f.options.probe = async port => ({present:true,value:{...health(port === 8765 ? 'discord' : 'qq'),
    last_storage_error:{at:iso,error:'SQLite error test-health-token token=private https://example.invalid'}}});
  await run(f.options);
  const files = fs.readdirSync(path.join(f.root,'monitor')).filter(name => /\.(json|jsonl)$/.test(name));
  for (const file of files) {
    const value = fs.readFileSync(path.join(f.root,'monitor',file),'utf8');
    assert(!value.includes('test-health-token'),file);
    assert(!value.includes('token=private'),file);
    assert(!value.includes('example.invalid'),file);
  }
});

test('actual Windows role launcher preserves warnings and writes exit results in a temporary project',
  {skip:process.platform !== 'win32',timeout:20000},async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse role launch '));
    t.after(() => fs.rmSync(folder,{recursive:true,force:true}));
    fs.mkdirSync(path.join(folder,'scripts'));
    fs.mkdirSync(path.join(folder,'data','monitor'),{recursive:true});
    fs.mkdirSync(path.join(folder,'data','telegram','runtime','Scripts'),{recursive:true});
    fs.writeFileSync(path.join(folder,'data','telegram','runtime','Scripts','python.exe'),'unused runtime marker');
    fs.copyFileSync(path.join(project,'scripts','start_monitored_role.ps1'),path.join(folder,'scripts','start_monitored_role.ps1'));
    for (const exitCode of [0,7]) {
      fs.writeFileSync(path.join(folder,'scripts','start_telegram.ps1'),
        `param([string]$Action)\n$ErrorActionPreference='Continue'\n& $env:MUSE_NODE_PATH -e "process.stderr.write('WARNING: fixture disconnect\\n'); process.exit(${exitCode})"\nif ($LASTEXITCODE -ne 0) { throw 'Fixture service exited' }\n`);
      const child = await launch('telegram',folder,path.join(folder,'data'),now+exitCode);
      const deadline = Date.now()+7000;
      while (!fs.existsSync(child.exit_file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,30));
      const stdout = fs.readFileSync(child.stdout,'utf8');
      const stderr = fs.readFileSync(child.stderr,'utf8');
      assert(fs.existsSync(child.exit_file),`wrapper did not record exit: ${stdout}\n${stderr}`);
      const result = JSON.parse(fs.readFileSync(child.exit_file,'utf8'));
      assert.equal(result.role,'telegram');
      assert.equal(result.exit_code,exitCode);
      assert.match(stderr,/WARNING: fixture disconnect/);
    }
  });

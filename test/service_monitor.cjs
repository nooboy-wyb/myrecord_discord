const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {DatabaseSync} = require('node:sqlite');
const {spawn,execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {once} = require('node:events');
const {policy,transition,assess,processMatches,gatewayStatus,classifyError,scrub,run,launch,incidents,control,parseArguments} = require('../scripts/service_monitor.cjs');
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

test('unreadable runtime command lines block recovery instead of confirming a process exit',() => {
  for (const [role,runtime] of [['discord','node.exe'],['telegram','python.exe'],['qq','node.exe']]) {
    const observation = assess(role,{processes:[{ProcessId:10,Name:runtime,CommandLine:null}],recover:true},now,project);
    assert(observation.inspection_error);
    assert(!observation.issues.some(issue => issue.code === 'PROCESS_ABSENT'));
    const decision = transition({missing_count:5},observation,now);
    assert.equal(decision.state,'INSPECTION_FAILED');
    assert.equal(decision.action,'none');
    assert.equal(decision.missing_count,0);
  }
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

test('role selection restricts recovery while all three roles continue to be inspected',async t => {
  const context = fixture(t);
  context.alive.clear();
  context.options.probe = async () => ({present:false,error:'ECONNREFUSED'});
  await run({...context.options,recoverRoles:['telegram']});
  const result = await run({...context.options,recoverRoles:['telegram'],now:now+60000});
  assert.deepEqual(context.starts,['telegram']);
  assert.equal(result.roles.discord.state,'STOPPED');
  assert.equal(result.roles.qq.state,'STOPPED');
  assert.deepEqual(result.recovery_roles,['telegram']);
  assert.deepEqual(parseArguments(['--recover','--role','telegram']).recoverRoles,['telegram']);
  for (const args of [['--role','typo'],['--unexpected'],['--recover','--control','pause'],['--role']])
    assert.throws(() => parseArguments(args));
  await assert.rejects(run({...context.options,recoverRoles:['typo']}),/Invalid recovery role/);
});

test('pause and resume controls preserve budgets, respect global pause and retain individual pause markers',async t => {
  const context = fixture(t);
  await run(context.options);
  await run({...context.options,now:now+60000});
  const budget = fs.readFileSync(path.join(context.root,'monitor','state.json'));
  control({root:context.root,action:'pause',role:'all'});
  control({root:context.root,action:'pause',role:'telegram'});
  const result = control({root:context.root,action:'resume',role:'all'});
  assert.equal(result.paused_all,false);
  assert.deepEqual(result.paused_roles,['telegram']);
  control({root:context.root,action:'pause',role:'all'});
  assert.equal(control({root:context.root,action:'resume',role:'telegram'}).paused_all,true);
  assert.deepEqual(fs.readFileSync(path.join(context.root,'monitor','state.json')),budget);
  assert.equal((await run({...context.options,now:now+400000})).roles.telegram.state,'PAUSED');
  assert.deepEqual(context.starts,['telegram']);
});

test('handoff failures remain visible without erasing or retrying an already committed launch',async t => {
  const context = fixture(t);
  await run(context.options);
  fs.writeFileSync(path.join(context.root,'monitor','handoff','telegram.json'),'{bad');
  const report = await run({...context.options,now:now+60000});
  assert.equal(report.handoff_error,'HANDOFF_WRITE_FAILED');
  assert.deepEqual(report.roles.telegram.restarts,[now+60000]);
  await run({...context.options,now:now+90000});
  assert.deepEqual(context.starts,['telegram']);
  const state = JSON.parse(fs.readFileSync(path.join(context.root,'monitor','state.json'),'utf8'));
  assert.deepEqual(state.roles.telegram.restarts,[now+60000]);
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
    t.after(() => fs.promises.rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
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

test('a recovered Windows role survives the one-shot monitor process exiting',
  {skip:process.platform !== 'win32',timeout:15000},async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse independent role '));
    let role;
    t.after(async () => {
      if (role) {
        fs.writeFileSync(path.join(folder,'data','release'),'');
        const deadline = Date.now()+5000;
        while (Date.now() < deadline) {
          try {process.kill(role.pid,0);} catch {break;}
          await new Promise(resolve => setTimeout(resolve,20));
        }
        try {process.kill(role.pid);} catch (error) {if (error.code !== 'ESRCH') throw error;}
      }
      await fs.promises.rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    });
    fs.mkdirSync(path.join(folder,'scripts'));
    fs.mkdirSync(path.join(folder,'data','monitor'),{recursive:true});
    fs.mkdirSync(path.join(folder,'data','telegram','runtime','Scripts'),{recursive:true});
    fs.writeFileSync(path.join(folder,'data','telegram','runtime','Scripts','python.exe'),'unused runtime marker');
    fs.copyFileSync(path.join(project,'scripts','start_monitored_role.ps1'),path.join(folder,'scripts','start_monitored_role.ps1'));
    fs.writeFileSync(path.join(folder,'scripts','start_telegram.ps1'),
      "param([string]$Action)\n$deadline=[DateTime]::UtcNow.AddSeconds(30)\nwhile (-not (Test-Path -LiteralPath (Join-Path $env:MUSE_DATA_DIR 'release')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }\n");
    const resultFile = path.join(folder,'launch.json');
    const code = `require(${JSON.stringify(path.join(project,'scripts','service_monitor.cjs'))}).launch('telegram',${JSON.stringify(folder)},${JSON.stringify(path.join(folder,'data'))},${now})`
      +`.then(result => require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result)))`
      +'.catch(error => {console.error(error.message);process.exitCode=1;});';
    const worker = spawn(process.execPath,['-e',code],{windowsHide:true,stdio:'ignore'});
    assert.equal((await once(worker,'close'))[0],0);
    role = JSON.parse(fs.readFileSync(resultFile,'utf8'));
    await new Promise(resolve => setTimeout(resolve,300));
    process.kill(role.pid,0);
    assert(!fs.existsSync(role.exit_file),'fixture role exited with its monitor parent');
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${role.pid}').CommandLine | ConvertTo-Json -Compress`;
    const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {windowsHide:true,timeout:5000});
    const launching = assess('telegram',{processes:[{ProcessId:role.pid,CommandLine:JSON.parse(stdout)}]},now,folder);
    assert.equal(launching.starting,true,'independent wrapper must remain recognizable during slow startup');
    assert.equal(transition({missing_count:5},{...launching,recover:true},now).action,'none');
  });

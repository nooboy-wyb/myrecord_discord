const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {DatabaseSync} = require('node:sqlite');
const {acquireLock} = require('./qq/core/process_lock.cjs');
const {writeHandoffs} = require('./monitor_handoff.cjs');
const {notifyTelegram} = require('./monitor_notices.cjs');

const policy = {window_ms:3600000,max_restarts:3,cooldown_ms:300000,startup_ms:120000,missing_checks:2,stale_ms:300000,backlog_ms:900000};
const roles = ['discord','telegram','qq'];
const entries = {discord:'discord_collector_server.cjs',telegram:'telegram/collector.py',qq:'qq/sender.cjs'};

function safeText(value) {
  return String(value ?? '').replace(/(?:https?|wss?|socks\d?):\/\/\S+/gi,'[url]')
    .replace(/\b(token|secret|password|api_hash|auth_key)\b([\s:=]+)\S+/gi,'$1$2[redacted]').slice(0,1000);
}
function scrub(value,secrets = []) {
  if (typeof value === 'string') {
    let result = safeText(value);
    for (const secret of secrets.filter(Boolean)) result = result.replaceAll(secret,'[redacted]');
    return result;
  }
  if (Array.isArray(value)) return value.map(item => scrub(item,secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) =>
    [key,/^(?:token|secret|password|api_hash|auth_key|session_id|authorization|body_raw|message_json|context_json)$/i.test(key) ? '[redacted]' : scrub(item,secrets)]));
  return value;
}
function age(value,now) {
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? Math.max(0,now-stamp) : Infinity;
}
function transition(previous = {}, observation, now, options = policy) {
  const restarts = (previous.restarts || []).filter(stamp => stamp > now-options.window_ms);
  const base = {restarts,last_start_at:previous.last_start_at ?? null,
    stalled_count:observation.stalled ? (previous.stalled_count || 0)+1 : 0,
    missing_count:observation.running || observation.inspection_error ? 0 : (previous.missing_count || 0)+1,action:'none'};
  if (observation.paused) return {...base,stalled_count:0,missing_count:0,state:'PAUSED'};
  if (observation.inspection_error) return {...base,stalled_count:0,state:'INSPECTION_FAILED'};
  if (observation.running) {
    if (observation.issues.length && previous.last_start_at != null && now-previous.last_start_at < options.startup_ms)
      return {...base,state:'STARTING'};
    if (observation.stalled && observation.recover && !observation.recovery_blocked
        && base.stalled_count >= options.missing_checks) {
      if (restarts.length >= options.max_restarts) return {...base,state:'RESTART_LIMITED'};
      if (restarts.length && now-restarts.at(-1) < options.cooldown_ms) return {...base,state:'COOLDOWN'};
      return {...base,state:'DEGRADED',action:'restart'};
    }
    return {...base,state:observation.issues.length ? 'DEGRADED' : 'HEALTHY'};
  }
  if (previous.state !== 'START_FAILED' && previous.last_start_at != null && now-previous.last_start_at < options.startup_ms)
    return {...base,state:'STARTING'};
  if (observation.starting) return {...base,state:'DEGRADED'};
  if (observation.port_busy || observation.health_present) return {...base,state:'CONFLICT'};
  if (observation.recovery_blocked) return {...base,state:'MANUAL_REQUIRED'};
  if (!observation.recover) return {...base,state:'STOPPED'};
  if (base.missing_count < options.missing_checks) return {...base,state:'SUSPECT'};
  if (restarts.length >= options.max_restarts) return {...base,state:'RESTART_LIMITED'};
  if (restarts.length && now-restarts.at(-1) < options.cooldown_ms) return {...base,state:'COOLDOWN'};
  return {...base,state:'STOPPED',action:'start'};
}
function classifyError(value) {
  const text = String(value || '');
  if (/unauthoriz|authkey|auth_key|sessionrevoked|sessionexpired|login|401|鉴权|授权/i.test(text)) return {category:'AUTHORIZATION',handling:'manual_login'};
  if (/permission|forbidden|chatadmin|channelprivate|权限/i.test(text)) return {category:'PERMISSION',handling:'check_source_access'};
  if (/unknown|uncertain|未知/i.test(text)) return {category:'SEND_UNKNOWN',handling:'quarantine_no_retry'};
  if (/floodwait|ratelimit|rate.limit|限频|限流|429/i.test(text)) return {category:'RATE_LIMIT',handling:'wait_existing_backoff'};
  if (/image|attachment|download|404|图片|附件/i.test(text)) return {category:'ATTACHMENT',handling:'inspect_attachment_keep_checkpoint'};
  if (/sqlite|database|storage|disk|constraint|archive|verification|数据|校验/i.test(text)) return {category:'STORAGE_OR_DATA',handling:'inspect_storage_keep_checkpoint'};
  if (/connect|network|timeout|offline|socket|disconnect|网络/i.test(text)) return {category:'NETWORK',handling:'allow_existing_reconnect'};
  return {category:'BUSINESS',handling:'inspect_error_no_restart'};
}
function processMatches(command,entry) {
  const normalized = String(command || '').replace(/\\/g,'/').toLowerCase();
  const target = entry.replace(/\\/g,'/').toLowerCase();
  let offset = normalized.indexOf(target);
  while (offset >= 0) {
    const before = normalized[offset-1];
    const after = normalized[offset+target.length];
    if ((!before || /[\s"']/.test(before)) && (!after || /[\s"']/.test(after))) return true;
    offset = normalized.indexOf(target,offset+1);
  }
  return false;
}
async function inspectProcesses() {
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
    $processes=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','python.exe','pythonw.exe','powershell.exe','pwsh.exe') } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='CreatedAt';e={$_.CreationDate.ToUniversalTime().ToString('o')}});
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @(8765,8766) } | Select-Object LocalPort,OwningProcess);
    @{processes=$processes;listeners=$listeners} | ConvertTo-Json -Depth 4 -Compress`;
  const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,timeout:20000,maxBuffer:2*1024*1024});
  return JSON.parse(stdout.replace(/^\uFEFF/,''));
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
function atomicJson(file,value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(value,null,2),'utf8');
  fs.renameSync(temporary,file);
}
function health(port,token) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) {settled = true;resolve(value);} };
    const request = http.get({hostname:'127.0.0.1',port,path:'/v1/health',headers:{'x-collector-token':token}},response => {
      let body = '';
      response.on('data',chunk => {
        body += chunk;
        if (body.length > 1024*1024) request.destroy(Error('health response too large'));
      });
      response.on('error',error => done({present:true,error:safeText(error.message)}));
      response.on('end',() => {
        if (response.statusCode !== 200) return done({present:true,error:`HTTP ${response.statusCode}`});
        try {done({present:true,value:JSON.parse(body)});}
        catch {done({present:true,error:'Invalid health JSON'});}
      });
    });
    const timer = setTimeout(() => request.destroy(Error('Health request timed out')),5000);
    request.on('close',() => clearTimeout(timer));
    request.on('error',error => done({present:false,error:safeText(error.message)}));
  });
}
function tail(file,limit = 131072) {
  if (!fs.existsSync(file)) return '';
  const descriptor = fs.openSync(file,'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size,limit));
    fs.readSync(descriptor,buffer,0,buffer.length,Math.max(0,size-buffer.length));
    return buffer.toString('utf8');
  } finally {fs.closeSync(descriptor);}
}
function gatewayStatus(text,now) {
  let ack = null,latest = null;
  for (const line of text.split(/\r?\n/)) {
    const stamp = line.match(/^\[([^\]]+)\]/)?.[1];
    if (!stamp || !line.includes('QQ Gateway')) continue;
    const at = new Date(stamp.replace(' ','T').replace(' +08:00','+08:00')).getTime();
    if (!Number.isFinite(at)) continue;
    const payload = line.indexOf('{');
    let detail;
    try {detail = payload < 0 ? {} : JSON.parse(line.slice(payload));} catch {continue;}
    if (detail.round_trip_ms != null && detail.heartbeat_acked != null) ack = {at,connection_id:detail.connection_id};
    latest = {at,connection_id:detail.connection_id ?? null};
  }
  return {last_ack_at:ack ? new Date(ack.at).toISOString() : null,
    ack_age_ms:ack ? Math.max(0,now-ack.at) : null,connection_id:latest?.connection_id ?? null};
}
function queueStatus(file) {
  if (!fs.existsSync(file)) return {error:'Queue database missing'};
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=1000');
    return {groups:db.prepare(`SELECT source,status,COUNT(*) AS count,MIN(source_timestamp) AS oldest_source_at,
      MIN(updated_at) AS oldest_updated_at FROM sender_outbox GROUP BY source,status`).all(),
    unknown_parts:db.prepare("SELECT COUNT(*) AS count FROM forward_attempts WHERE status='unknown'").get().count,
    recent_errors:db.prepare(`SELECT source,status,updated_at,error FROM sender_outbox WHERE error IS NOT NULL
      AND status NOT IN ('accepted','skipped_duplicate','skipped_attachment') ORDER BY updated_at DESC LIMIT 5`).all()};
  } finally {db.close();}
}
function assess(role,{processes = [],listeners = [],health:probe = {},telegram,queue,gateway,inspection_error,paused = false,recover = false},now,project,root = path.join(project,'data')) {
  const entry = path.join(project,'scripts',entries[role]);
  const matches = processes.filter(item => processMatches(item.CommandLine,entry)
    && (role !== 'telegram' || (/\smonitor(?:\s|$)/i.test(item.CommandLine)
      && processMatches(item.CommandLine,path.join(root,'telegram')))));
  const matchedIds = new Set(matches.map(item => item.ProcessId));
  const instances = matches.filter(item => !matchedIds.has(item.ParentProcessId));
  const runtimeNames = role === 'telegram' ? ['python.exe','pythonw.exe'] : ['node.exe'];
  if (!matches.length && processes.some(item => runtimeNames.includes(String(item.Name || '').toLowerCase())
      && !String(item.CommandLine || '').trim()))
    inspection_error ||= 'Runtime process command line unavailable; cannot confirm process identity';
  const launcherNames = {discord:'start_discord_collector.ps1',telegram:'start_telegram.ps1',qq:'start_qq_sender.ps1'};
  const launchers = processes.filter(item =>
    (processMatches(item.CommandLine,path.join(project,'scripts','start_monitored_role.ps1'))
      && new RegExp(`-Role\\s+"?${role}(?:"|\\s|$)`,'i').test(item.CommandLine))
    || (processMatches(item.CommandLine,path.join(project,'scripts',launcherNames[role]))
      && (role !== 'telegram' || /-Action\s+"?Monitor(?:"|\s|$)/i.test(item.CommandLine))));
  const issues = [];
  const issue = (code,detail = {}) => issues.push({code,...detail,...classifyError(`${code} ${detail.error || ''} ${detail.message || ''}`)});
  const result = {running:matches.length > 0,starting:launchers.length > 0,pids:matches.map(item => item.ProcessId),
    process_identities:matches.map(item => ({pid:item.ProcessId,created_at:item.CreatedAt})),
    port_busy:listeners.some(item => Number(item.LocalPort) === (role === 'discord' ? 8765 : role === 'qq' ? 8766 : -1)),
    health_present:!!probe.present,inspection_error,paused,recover,issues};
  if (result.starting && !result.running) issue('LAUNCHER_WITHOUT_PROCESS');
  if (inspection_error) issue('PROCESS_INSPECTION_UNAVAILABLE',{error:inspection_error});
  else if (!result.running) issue('PROCESS_ABSENT');
  result.instance_count = instances.length;
  if (instances.length > 1) issue('MULTIPLE_PROCESSES');
  if (role !== 'telegram') {
    if (probe.error || !probe.value) issue('HEALTH_UNAVAILABLE',{error:safeText(probe.error || 'No health response')});
    else if (probe.value.role !== (role === 'discord' ? 'discord-collector' : 'qq-sender')) issue('HEALTH_ROLE_MISMATCH');
    const owners = listeners.filter(item => Number(item.LocalPort) === (role === 'discord' ? 8765 : 8766));
    if (owners.length && !owners.some(item => result.pids.includes(item.OwningProcess))) issue('PORT_OWNER_MISMATCH');
  }
  const value = probe.value;
  if (role === 'discord' && value) {
    result.capture = {last_capture_at:value.last_capture_at,received:value.received};
    result.pages = value.pages ?? null;
    if (age(value.pages?.at,now) > policy.stale_ms) issue('PAGE_REPORT_STALE');
    for (const page of value.pages?.issues || []) issue('PAGE_SCAN_ERROR',{channel_id:page.id,error:safeText(page.status),at:value.pages.at});
    if (value.last_storage_error) issue('SQLITE_WRITE_FAILED',value.last_storage_error);
    if (value.last_validation_error && age(value.last_validation_error.at,now) < policy.stale_ms)
      issue('CAPTURE_REJECTED',value.last_validation_error);
  }
  if (role === 'telegram') {
    result.scan = telegram ? {at:telegram.at,phase:telegram.phase,round_started_at:telegram.round_started_at,
      round_finished_at:telegram.round_finished_at,error:telegram.error,error_message:safeText(telegram.error_message),
      sources:(telegram.sources || []).map(source => Object.fromEntries(['peer_id','topic_id','status','started_at','since','until','scan_until',
        'last_progress_at','finished_at','read','inserted','verified','scan_complete_to_boundary','error','error_message','error_at'].filter(key => source[key] !== undefined).map(key => [key,source[key]])))} : null;
    if (age(telegram?.at,now) > policy.stale_ms) issue('SCAN_STATUS_STALE',{at:telegram?.at ?? null});
    if (telegram?.error) issue('SCAN_ERROR',{error:telegram.error,message:safeText(telegram.error_message),at:telegram.error_at || telegram.at});
    for (const source of telegram?.sources || []) {
      if (source.error) issue('SOURCE_SCAN_ERROR',{peer_id:source.peer_id,topic_id:source.topic_id,error:source.error,
        message:safeText(source.error_message),at:source.error_at || telegram.at});
      if (source.status === 'ok' && age(source.scan_until,now) > policy.stale_ms)
        issue('SOURCE_PROGRESS_STALE',{peer_id:source.peer_id,topic_id:source.topic_id,at:source.scan_until});
    }
  }
  if (role === 'qq') {
    result.gateway = gateway;
    result.planners = value?.planners;
    result.queue = queue;
    if (value && !value.online) issue('GATEWAY_OFFLINE');
    if (!gateway?.last_ack_at || gateway.ack_age_ms > policy.stale_ms) issue('GATEWAY_ACK_STALE',{at:gateway?.last_ack_at ?? null});
    for (const source of ['discord','telegram']) {
      const planner = value?.planners?.[source];
      if (age(planner?.at,now) > policy.stale_ms) issue('PLANNER_STALE',{source,at:planner?.at ?? null});
      if (planner?.error || planner?.ok === false) issue('PLANNER_ERROR',{source,error:safeText(planner.error),at:planner.at});
      for (const blocked of planner?.blocked || []) issue('PLANNER_BLOCKED',{source,detail:safeText(JSON.stringify(blocked)),at:planner.at});
    }
    if (queue?.error) issue('QUEUE_INSPECTION_FAILED',{error:safeText(queue.error)});
    if (queue?.unknown_parts || queue?.groups?.some(item => item.status === 'unknown')) issue('SEND_UNKNOWN',{automatic_retry:false});
    for (const group of queue?.groups || []) {
      if (['queued','deferred','processing'].includes(group.status)
          && age(group.oldest_source_at,now) > policy.backlog_ms
          && (age(group.oldest_updated_at,now) > policy.backlog_ms || age(group.pending_observed_since,now) > policy.backlog_ms))
        issue('QUEUE_BACKLOG',{source:group.source,status:group.status,count:group.count,oldest_source_at:group.oldest_source_at,
          oldest_updated_at:group.oldest_updated_at,pending_observed_since:group.pending_observed_since});
    }
    for (const error of queue?.recent_errors || []) issue('QUEUE_ERROR',{...error,error:safeText(error.error)});
  }
  result.recovery_blocked = issues.some(item => ['AUTHORIZATION','PERMISSION'].includes(item.category));
  result.stalled = role === 'telegram' && result.running && instances.length === 1
    && Number.isFinite(Date.parse(telegram?.at)) && age(telegram.at,now) > policy.stale_ms
    && result.process_identities.every(item => Number.isSafeInteger(item.pid) && Number.isFinite(Date.parse(item.created_at)))
    && !result.recovery_blocked;
  if (result.stalled) issues.find(item => item.code === 'SCAN_STATUS_STALE').handling = 'restart_verified_stall';
  return result;
}
async function stopStalledTelegram(observation,project,root) {
  const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',path.join(project,'scripts','stop_stalled_telegram.ps1'),
    '-DataDirectory',path.join(root,'telegram'),'-EntryPoint',path.join(project,'scripts','telegram','collector.py'),
    '-ExpectedStatusAt',observation.scan.at,'-ExpectedProcesses',
    Buffer.from(JSON.stringify(observation.process_identities)).toString('base64')],
    {windowsHide:true,timeout:25000,maxBuffer:131072});
  return JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
}
async function launch(role,project,root,now) {
  if (role === 'qq' && !fs.existsSync(path.join(root,'qq-bot-credential.xml'))) throw Error('QQ credential missing; configure interactively');
  if (role === 'telegram' && !fs.existsSync(path.join(root,'telegram','runtime','Scripts','python.exe'))) throw Error('Telegram runtime missing');
  const log = path.join(root,'monitor',`${role}-${now}`);
  const quote = value => "'"+value.replaceAll("'","''")+"'";
  const childScript = `$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue';$PSDefaultParameterValues=@{'Out-File:Encoding'='utf8'};
    $env:MUSE_DATA_DIR=${quote(root)};$env:MUSE_NODE_PATH=${quote(process.execPath)};$env:MUSE_MONITOR_LAUNCH_RESULT=${quote(`${log}.exit.json`)};
    & ${quote(path.join(project,'scripts','start_monitored_role.ps1'))} -Role ${role} 1>${quote(`${log}.stdout.log`)} 2>${quote(`${log}.stderr.log`)};
    exit $LASTEXITCODE`;
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
    $command='"'+(Join-Path $PSHOME 'powershell.exe')+'" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command '+${quote('"'+childScript+'"')};
    $created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;CurrentDirectory=${quote(project)}};
    if ($created.ReturnValue -ne 0) {throw ('Independent role launch failed, Windows code '+$created.ReturnValue)};
    Write-Output $created.ProcessId`;
  const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {cwd:project,env:process.env,
      windowsHide:true,timeout:15000,maxBuffer:131072});
  const pid = Number(stdout.trim());
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Role launcher returned an invalid PID');
  return {pid,at:new Date(now).toISOString(),stdout:`${log}.stdout.log`,stderr:`${log}.stderr.log`,exit_file:`${log}.exit.json`};
}
function incidents(previous,observations,at,append) {
  const active = {};
  for (const role of roles) {
    if (observations[role].paused || observations[role].inspection_error)
      for (const [key,value] of Object.entries(previous)) if (value.role === role) active[key] = value;
    if (observations[role].paused) continue;
    for (const issue of observations[role].issues) {
      const key = JSON.stringify([role,issue.code,issue.peer_id,issue.topic_id,issue.channel_id,issue.source,issue.status]);
      const before = previous[key];
      active[key] = {role,...issue,first_seen_at:before?.first_seen_at || at,last_seen_at:at};
      if (!before || JSON.stringify({...before,first_seen_at:undefined,last_seen_at:undefined}) !==
        JSON.stringify({...active[key],first_seen_at:undefined,last_seen_at:undefined})) append({event:before ? 'updated' : 'opened',...active[key]});
    }
  }
  for (const [key,value] of Object.entries(previous)) if (!active[key]) append({event:'resolved',...value,resolved_at:at});
  return active;
}
async function run({project = path.resolve(__dirname,'..'),root = path.resolve(process.env.MUSE_DATA_DIR || path.join(project,'data')),
  recover = false,recoverRoles = roles,inspect = inspectProcesses,probe = health,start = launch,
  stop = stopStalledTelegram,notify = notifyTelegram,now = Date.now()} = {}) {
  if (!Array.isArray(recoverRoles) || !recoverRoles.length || recoverRoles.some(role => !roles.includes(role)))
    throw Error('Invalid recovery role');
  const folder = path.join(root,'monitor');
  fs.mkdirSync(folder,{recursive:true});
  const release = acquireLock(path.join(folder,'monitor.lock'));
  try {
    const stateFile = path.join(folder,'state.json');
    const previous = fs.existsSync(stateFile) ? readJson(stateFile) : {roles:{},incidents:{}};
    if (!previous.roles || !previous.incidents || Array.isArray(previous.roles) || Array.isArray(previous.incidents))
      throw Error('Invalid monitor state; manual inspection required');
    for (const role of roles) {
      const state = previous.roles[role];
      if (state && (!Array.isArray(state.restarts) || state.restarts.some(stamp => !Number.isFinite(stamp))
          || (state.last_start_at != null && !Number.isFinite(state.last_start_at))
          || !Number.isInteger(state.missing_count) || state.missing_count < 0
          || (state.stalled_count != null && (!Number.isInteger(state.stalled_count) || state.stalled_count < 0))))
        throw Error('Invalid monitor recovery budget; manual inspection required');
    }
    const at = new Date(now).toISOString();
    const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now));
    let token,token_error;
    const append = event => fs.appendFileSync(path.join(folder,`events-${day}.jsonl`),JSON.stringify(scrub({observed_at:at,...event},[token]))+'\n');
    let inventory,inspection_error;
    try {inventory = await inspect();} catch (error) {inventory = {};inspection_error = safeText(error.message);}
    try {token = fs.readFileSync(path.join(root,'collector-token.txt'),'utf8').trim();if (!token) throw Error('Empty health token');}
    catch (error) {token_error = safeText(error.message);}
    const [discord,qq] = token ? await Promise.all([probe(8765,token),probe(8766,token)]) : [{error:token_error},{error:token_error}];
    let telegram,queue,gateway;
    try {telegram = readJson(path.join(root,'telegram','monitor-status.json'));} catch (error) {telegram = {error:'STATUS_UNAVAILABLE',error_message:safeText(error.message)};}
    try {queue = queueStatus(path.join(root,'qq-forward.sqlite'));} catch (error) {queue = {error:safeText(error.message)};}
    const queue_since = {};
    for (const group of queue.groups || []) if (['queued','deferred','processing'].includes(group.status)) {
      queue_since[group.source] = previous.queue_since?.[group.source] || at;
      group.pending_observed_since = queue_since[group.source];
    }
    try {
      const yesterday = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now-86400000));
      gateway = gatewayStatus(tail(path.join(root,'logs',`qq-sender-${yesterday}.log`))+'\n'+tail(path.join(root,'logs',`qq-sender-${day}.log`)),now);
    } catch (error) {gateway = {error:safeText(error.message)};}
    const observations = {},next = {};
    for (const role of roles) {
      const paused = fs.existsSync(path.join(folder,'pause-all')) || fs.existsSync(path.join(folder,`pause-${role}`));
      const observation = assess(role,{...inventory,health:role === 'discord' ? discord : role === 'qq' ? qq : {},
        telegram,queue,gateway,inspection_error:inspection_error || token_error,paused,recover:recover && recoverRoles.includes(role)},now,project,root);
      const decision = transition(previous.roles[role],observation,now);
      decision.last_launch = previous.roles[role]?.last_launch ?? null;
      if (decision.last_launch?.exit_file && fs.existsSync(decision.last_launch.exit_file)) {
        try {
          const exit = readJson(decision.last_launch.exit_file);
          if (!decision.last_launch.exit) append({event:'process_exited',role,...exit});
          decision.last_launch = {...decision.last_launch,exit};
        } catch (error) {observation.issues.push({code:'EXIT_RESULT_UNREADABLE',error:safeText(error.message)});}
      }
      decision.consecutive_failures = decision.state === 'HEALTHY' || decision.state === 'PAUSED' ? 0 : (previous.roles[role]?.consecutive_failures || 0)+1;
      decision.first_failure_at = decision.consecutive_failures ? previous.roles[role]?.first_failure_at || at : null;
      decision.last_success_at = decision.state === 'HEALTHY' ? at : previous.roles[role]?.last_success_at ?? null;
      if (['start','restart'].includes(decision.action)) {
        decision.restarts.push(now);
        decision.last_start_at = now;
        next[role] = {...decision,state:'STARTING'};
        atomicJson(stateFile,{...previous,roles:{...previous.roles,...next}});
        try {
          if (decision.action === 'restart') {
            observation.stopped = await stop(observation,project,root);
            append({event:'stalled_process_stopped',role,...observation.stopped});
            const refreshed = await inspect();
            const checked = assess('telegram',{...refreshed,telegram},Date.now(),project,root);
            if (checked.inspection_error || checked.running || checked.instance_count)
              throw Error('Telegram process absence could not be confirmed after stopping stalled worker');
          }
          observation.recovery = await start(role,project,root,now);
          decision.last_launch = observation.recovery;
          decision.state = 'STARTING';
          append({event:'restart_started',role,reason:decision.action === 'restart' ? 'confirmed_scan_stall' : 'confirmed_process_absent',...observation.recovery});
        } catch (error) {
          decision.state = 'START_FAILED';
          observation.issues.push({code:'START_FAILED',error:safeText(error.message)});
          append({event:'restart_failed',role,error:safeText(error.message)});
        }
      }
      next[role] = decision;
      observations[role] = {...observation,...decision};
      if (previous.roles[role]?.state !== decision.state) append({event:'state_changed',role,from:previous.roles[role]?.state ?? null,to:decision.state});
    }
    const active = incidents(previous.incidents,observations,at,append);
    atomicJson(stateFile,scrub({at,roles:next,incidents:active,queue_since},[token]));
    const report = scrub({at,recovery_enabled:recover,recovery_roles:recover ? recoverRoles : [],policy,
      inspection_error:inspection_error || token_error || null,roles:observations},[token]);
    try {report.handoffs = writeHandoffs(folder,report,active,append);}
    catch (error) {
      report.handoff_error = 'HANDOFF_WRITE_FAILED';
      append({event:'handoff_failed',error:safeText(error.message)});
    }
    atomicJson(path.join(folder,'status.json'),report);
    try {report.notifications = await notify({project,root,report,now,append});}
    catch (error) {
      report.notification_error = 'TELEGRAM_NOTICE_FAILED';
      append({event:'notification_failed',role:'telegram',error:safeText(error.message)});
    }
    atomicJson(path.join(folder,'status.json'),report);
    return report;
  } finally {release();}
}
function control({action,role = 'all',root = path.resolve(process.env.MUSE_DATA_DIR || path.join(__dirname,'..','data'))}) {
  if (!['pause','resume'].includes(action) || !['all',...roles].includes(role)) throw Error('Invalid monitor control');
  const folder = path.join(root,'monitor');
  fs.mkdirSync(folder,{recursive:true});
  const release = acquireLock(path.join(folder,'monitor.lock'));
  try {
    const file = path.join(folder,`pause-${role}`);
    if (action === 'pause') fs.writeFileSync(file,new Date().toISOString(),'utf8');
    else fs.rmSync(file,{force:true});
    const now = new Date();
    const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now);
    fs.appendFileSync(path.join(folder,`events-${day}.jsonl`),JSON.stringify({event:'manual_control',action,role,observed_at:now.toISOString()})+'\n');
    return {action,role,paused_all:fs.existsSync(path.join(folder,'pause-all')),
      paused_roles:roles.filter(item => fs.existsSync(path.join(folder,`pause-${item}`)))};
  } finally {release();}
}
function parseArguments(args) {
  const options = {recover:false,recoverRoles:roles};
  let selected = 'all';
  for (let index = 0;index < args.length;index++) {
    if (args[index] === '--recover') options.recover = true;
    else if (args[index] === '--role' && args[index+1]) selected = args[++index].toLowerCase();
    else if (args[index] === '--control' && args[index+1]) options.control = args[++index].toLowerCase();
    else throw Error('Invalid monitor argument');
  }
  if (!['all',...roles].includes(selected)) throw Error('Invalid recovery role');
  if (options.control && (!['pause','resume'].includes(options.control) || options.recover)) throw Error('Invalid monitor control');
  return {...options,role:selected,recoverRoles:selected === 'all' ? roles : [selected]};
}
async function main(args) {
  const options = parseArguments(args);
  if (options.control) return console.log(JSON.stringify(control({action:options.control,role:options.role})));
  const report = await run(options);
  console.log(JSON.stringify({at:report.at,states:Object.fromEntries(roles.map(role => [role,report.roles[role].state])),
    handoff_error:report.handoff_error || null}));
  if (report.handoff_error) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(`Monitor failed: ${safeText(error.message)}`);process.exitCode = 1;
});
module.exports = {policy,transition,processMatches,gatewayStatus,assess,incidents,run,launch,stopStalledTelegram,safeText,scrub,classifyError,control,parseArguments};

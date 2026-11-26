const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFile,spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {once} = require('node:events');
const execute = promisify(execFile);
const project = path.resolve(__dirname,'..');
const now = Date.parse('2026-11-26T07:00:00Z');

function fixture(t,code) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse supervisor '));
  t.after(async () => {
    const businessFile = path.join(folder,'data','business.pid');
    if (fs.existsSync(businessFile)) {
      const pid = Number(fs.readFileSync(businessFile,'utf8'));
      try {process.kill(pid);} catch (error) {if (error.code !== 'ESRCH') throw error;}
      const deadline = Date.now()+2000;
      while (Date.now() < deadline) {
        try {process.kill(pid,0);} catch {break;}
        await new Promise(resolve => setTimeout(resolve,20));
      }
    }
    fs.rmSync(folder,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  });
  fs.mkdirSync(path.join(folder,'scripts'));
  fs.mkdirSync(path.join(folder,'data','telegram'),{recursive:true});
  for (const file of ['check_services.ps1','recover_services.ps1'])
    fs.copyFileSync(path.join(project,'scripts',file),path.join(folder,'scripts',file));
  fs.writeFileSync(path.join(folder,'scripts','service_monitor.cjs'),code);
  const options = {windowsHide:true,timeout:10000,env:{...process.env,MUSE_DATA_DIR:path.join(folder,'data')}};
  const args = extra => ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(folder,'scripts','check_services.ps1'),'-NodePath',process.execPath,...extra];
  return {folder,root:path.join(folder,'data'),options,args,
    status:() => JSON.parse(fs.readFileSync(path.join(folder,'data','monitor','supervisor-status.json'),'utf8'))};
}
async function resultOf(args,options) {
  try {return {code:0,...await execute('powershell.exe',args,options)};}
  catch (error) {if (Number.isInteger(error.code)) return error;throw error;}
}

test('supervisor preserves native failures and warnings, then resets its failure count on a successful next tick',
  {skip:process.platform !== 'win32',timeout:10000},async t => {
    const context = fixture(t,"process.stderr.write('WARNING: fixture native failure\\n');process.exit(Number(process.env.MUSE_FIXTURE_EXIT));");
    const failed = await resultOf(context.args([]),{...context.options,env:{...context.options.env,MUSE_FIXTURE_EXIT:'7'}});
    assert.equal(failed.code,7,failed.stderr);
    const failure = context.status();
    assert.equal(failure.state,'FAILED');
    assert.equal(failure.exit_code,7);
    assert.equal(failure.consecutive_failures,1);
    assert.match(fs.readFileSync(failure.stderr,'utf8'),/WARNING: fixture native failure/);
    const success = await resultOf(context.args([]),{...context.options,env:{...context.options.env,MUSE_FIXTURE_EXIT:'0'}});
    assert.equal(success.code,0,success.stderr);
    assert.equal(context.status().state,'SUCCEEDED');
    assert.equal(context.status().consecutive_failures,0);
    assert(context.status().last_success_at);
  });

test('supervisor times out only its owned tick and leaves an existing business process alive',
  {skip:process.platform !== 'win32',timeout:10000},async t => {
    const context = fixture(t,'setInterval(() => {},1000);');
    const childFile = path.join(context.root,'business.pid');
    const business = spawn(process.execPath,['-e','setInterval(() => {},1000)'],{stdio:'ignore',windowsHide:true});
    await once(business,'spawn');
    fs.writeFileSync(childFile,String(business.pid));
    const result = await resultOf(context.args(['-TimeoutSeconds','1']),context.options);
    assert.equal(result.code,124,result.stderr);
    const status = context.status();
    assert.equal(status.state,'TIMED_OUT');
    assert.equal(status.exit_code,124);
    assert.throws(() => process.kill(status.tick_pid,0),{code:'ESRCH'});
    process.kill(Number(fs.readFileSync(childFile,'utf8')),0);
  });

test('overlapping invocations skip without replacing the active supervisor status and the OS lock releases after timeout',
  {skip:process.platform !== 'win32',timeout:15000},async t => {
    const context = fixture(t,'setInterval(() => {},1000);');
    const child = spawn('powershell.exe',context.args(['-TimeoutSeconds','3']),{...context.options,stdio:'ignore'});
    const closed = once(child,'close');
    t.after(async () => {if (child.exitCode === null) {child.kill();await closed;}});
    const deadline = Date.now()+2000;
    let original;
    while (Date.now() < deadline) {
      try {original = context.status();if (original.tick_pid) break;} catch {}
      await new Promise(resolve => setTimeout(resolve,20));
    }
    assert(original?.tick_pid,'first tick did not start');
    const skipped = await resultOf(context.args([]),context.options);
    assert.equal(skipped.code,0,skipped.stderr);
    assert.equal(JSON.parse(skipped.stdout).supervisor,'ALREADY_RUNNING');
    assert.equal(context.status().tick_pid,original.tick_pid);
    assert.equal((await closed)[0],124);
    fs.writeFileSync(path.join(context.folder,'scripts','service_monitor.cjs'),"console.log('{}');");
    assert.equal((await resultOf(context.args([]),context.options)).code,0);
    assert.equal(context.status().state,'SUCCEEDED');
  });

test('a monitor killed after persisting a restart budget is reclaimed next tick without launching the role again',
  {skip:process.platform !== 'win32',timeout:15000},async t => {
    const context = fixture(t,[
      "const fs = require('node:fs');const path = require('node:path');",
      `const {run} = require(${JSON.stringify(path.join(project,'scripts','service_monitor.cjs'))});`,
      "const root = process.env.MUSE_DATA_DIR;const project = path.resolve(__dirname,'..');",
      "const now = Number(process.env.MUSE_FIXTURE_NOW);const at = new Date(now).toISOString();",
      "run({project,root,now,recover:process.argv.includes('--recover'),",
      "inspect:async () => ({processes:[{ProcessId:10,CommandLine:'node \\\"'+path.join(project,'scripts','discord_collector_server.cjs')+'\\\"'},",
      "{ProcessId:11,CommandLine:'node \\\"'+path.join(project,'scripts','qq','sender.cjs')+'\\\"'}],listeners:[]}),",
      "probe:async port => ({present:true,value:port === 8765 ? {role:'discord-collector',pages:{at,issues:[]}}",
      ": {role:'qq-sender',online:true,planners:{discord:{at,ok:true},telegram:{at,ok:true}}}}),",
      "start:async role => {fs.appendFileSync(path.join(root,'starts.jsonl'),JSON.stringify({role})+'\\n');",
      "setInterval(() => {},1000);return new Promise(() => {});}}).then(report => console.log(JSON.stringify({at:report.at})))",
      ".catch(error => {console.error(error.message);process.exitCode=1;});"
    ].join('\n'));
    fs.writeFileSync(path.join(context.root,'collector-token.txt'),'fixture-token');
    fs.writeFileSync(path.join(context.root,'telegram','monitor-status.json'),JSON.stringify({at:new Date(now).toISOString(),sources:[]}));
    const optionsFor = offset => ({...context.options,env:{...context.options.env,MUSE_FIXTURE_NOW:String(now+offset)}});
    assert.equal((await resultOf(context.args(['-Recover']),optionsFor(0))).code,0);
    const timedOut = await resultOf(context.args(['-Recover','-TimeoutSeconds','1']),optionsFor(60000));
    assert.equal(timedOut.code,124,timedOut.stderr);
    const stateFile = path.join(context.root,'monitor','state.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')).roles.telegram.restarts,[now+60000]);
    assert.equal((await resultOf(context.args(['-Recover']),optionsFor(240000))).code,0);
    const report = JSON.parse(fs.readFileSync(path.join(context.root,'monitor','status.json'),'utf8'));
    assert.equal(report.roles.telegram.state,'COOLDOWN');
    assert.deepEqual(report.roles.telegram.restarts,[now+60000]);
    assert.equal(fs.readFileSync(path.join(context.root,'starts.jsonl'),'utf8').trim().split('\n').length,1);
    assert.equal(context.status().state,'SUCCEEDED');
  });

test('manual recovery uses the supervisor and forwards the selected role, recovery switch and native exit code',
  {skip:process.platform !== 'win32',timeout:10000},async t => {
    const context = fixture(t,[
      "const fs = require('node:fs');const path = require('node:path');",
      "fs.writeFileSync(path.join(process.env.MUSE_DATA_DIR,'arguments.json'),JSON.stringify(process.argv.slice(2)));",
      'process.exit(Number(process.env.MUSE_FIXTURE_EXIT || 0));'
    ].join('\n'));
    const args = context.args(['-Action','Recover','-Role','telegram']);
    args[args.indexOf('-File')+1] = path.join(context.folder,'scripts','recover_services.ps1');
    const result = await resultOf(args,{...context.options,env:{...context.options.env,MUSE_FIXTURE_EXIT:'7'}});
    assert.equal(result.code,7,result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(context.root,'arguments.json'),'utf8')),['--role','telegram','--recover']);
    const status = context.status();
    assert.equal(status.recovery_role,'telegram');
    assert.equal(status.recovery_enabled,true);
    assert.equal(status.state,'FAILED');
  });

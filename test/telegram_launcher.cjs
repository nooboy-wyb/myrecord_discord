const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');

test('Windows PowerShell Telegram launcher preserves warnings and checks native exit codes',
  {skip:process.platform !== 'win32'},async context => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse tg launcher '));
    const scripts = path.join(folder,'scripts');
    const data = path.join(folder,'data');
    const runtime = path.join(data,'telegram','runtime','Scripts','python.exe');
    const entry = path.join(scripts,'telegram','collector.py');
    fs.mkdirSync(path.dirname(runtime),{recursive:true});
    fs.mkdirSync(path.dirname(entry),{recursive:true});
    const launcher = path.join(scripts,'start_telegram.ps1');
    fs.copyFileSync(path.resolve(__dirname,'../scripts/start_telegram.ps1'),launcher);
    try { fs.linkSync(process.execPath,runtime); }
    catch { fs.copyFileSync(process.execPath,runtime); }
    fs.writeFileSync(entry,`
process.stderr.write('WARNING: simulated recoverable Telegram disconnect\\n');
setTimeout(() => {
  console.log('child-completed',JSON.stringify(process.argv.slice(2)));
  process.exit(Number(process.env.MUSE_TEST_TELEGRAM_EXIT));
},100);
`);
    const quoted = value => "'"+value.replaceAll("'","''")+"'";
    try {
      for (const exitCode of [0,7]) {
        await context.test(`stderr warning with native exit ${exitCode}`,() => {
          const log = path.join(folder,`native-${exitCode}.log`);
          const command = `
$ErrorActionPreference='Stop'
$env:TELEGRAM_PROXY='http://before-test.invalid:80'
$env:PYTHONIOENCODING='before-test'
$originalTemp=$env:TEMP
$originalTmp=$env:TMP
$failureMessage=$null
try { . ${quoted(launcher)} -Action Monitor -Proxy 'http://during-test.invalid:80' *> ${quoted(log)} }
catch { $failureMessage=$_.Exception.Message }
if ($env:TELEGRAM_PROXY -ne 'http://before-test.invalid:80' -or $env:PYTHONIOENCODING -ne 'before-test' -or $env:TEMP -ne $originalTemp -or $env:TMP -ne $originalTmp -or $ErrorActionPreference -ne 'Stop') { throw 'Launcher did not restore its environment' }
if ($failureMessage) { Write-Output $failureMessage; exit 9 }
Write-Output 'launcher-completed'
`;
          const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',
            Buffer.from(command,'utf16le').toString('base64')],{
            encoding:'utf8',timeout:30000,
            env:{...process.env,MUSE_DATA_DIR:data,MUSE_TEST_TELEGRAM_EXIT:String(exitCode)}
          });
          assert.ifError(result.error);
          const output = result.stdout+result.stderr;
          assert.equal(result.status,exitCode ? 9 : 0,output);
          const captured = fs.readFileSync(log,'utf16le');
          assert.match(captured,/WARNING: simulated recoverable Telegram disconnect/);
          assert.match(captured,/child-completed/);
          assert.match(captured,/"monitor"/);
          assert.match(captured,/"--seconds","0"/);
          if (exitCode) assert.match(output,/Telegram Monitor exited with code 7/);
          else assert.match(output,/launcher-completed/);
        });
      }
    } finally { fs.rmSync(folder,{recursive:true,force:true}); }
  });

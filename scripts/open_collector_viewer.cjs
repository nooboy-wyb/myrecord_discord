'use strict';
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');
const [target,hostAlias,remoteRoot] = process.argv.slice(2);
if (!target || !hostAlias || !remoteRoot || !/^[A-Za-z0-9_@.:-]+$/.test(target) || !/^[A-Za-z0-9_.:-]+$/.test(hostAlias) || /[\r\n']/.test(remoteRoot)) {
  console.error('Usage: node scripts/open_collector_viewer.cjs <ssh-target> <saved-host-alias> <remote-project-path>');
  process.exit(1);
}
const localPort = Number(process.env.MUSE_VIEWER_LOCAL_PORT || 18770);
const tunnelPort = Number(process.env.MUSE_VIEWER_TUNNEL_PORT || 18771);
const sshOptions = ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o',`HostKeyAlias=${hostAlias}`];
let tunnel, server, keepAlive, stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  tunnel?.kill();
  server?.close();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('exit', () => tunnel?.kill());
function available(port) {
  return new Promise((resolve,reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port,'127.0.0.1', () => probe.close(resolve));
  });
}
function remote(script) {
  return new Promise((resolve,reject) => {
    const encoded = Buffer.from(script,'utf16le').toString('base64');
    const child = spawn('ssh',[...sshOptions,target,`powershell -NoProfile -EncodedCommand ${encoded}`],{windowsHide:true});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(Error(`Remote viewer startup failed (${code})`)));
  });
}
async function start() {
  await available(localPort);
  await available(tunnelPort);
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root='${remoteRoot}'
$tokenPath=Join-Path $root 'data\\viewer\\token.txt'
if (-not (Test-Path $tokenPath)) {
  New-Item -ItemType Directory -Path (Split-Path $tokenPath) -Force | Out-Null
  $bytes=New-Object byte[] 32
  $random=[Security.Cryptography.RandomNumberGenerator]::Create()
  $random.GetBytes($bytes)
  $random.Dispose()
  [IO.File]::WriteAllText($tokenPath,([BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()),[Text.Encoding]::ASCII)
}
Get-Content -LiteralPath $tokenPath -Raw`;
  const token = await remote(script);
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid viewer startup response');
  const serve = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root='${remoteRoot}'
if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8770 -State Listen -ErrorAction SilentlyContinue) {
  while ($true) { Start-Sleep -Seconds 30 }
} else {
  Set-Location -LiteralPath $root
  & python (Join-Path $root 'scripts\\collector_viewer.py') --idle-timeout 120
}`;
  tunnel = spawn('ssh',[...sshOptions,'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
    '-T','-L',`127.0.0.1:${tunnelPort}:127.0.0.1:8770`,target,
    `powershell -NoProfile -EncodedCommand ${Buffer.from(serve,'utf16le').toString('base64')}`],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  tunnel.stderr.on('data', () => {});
  tunnel.on('error', error => {console.error(error.message);stop(1);});
  tunnel.on('exit', () => {if (!stopping) {console.error('SSH tunnel closed');stop(1);}});
  await new Promise((resolve,reject) => {
    let attempts = 0;
    const check = () => {
      if (stopping || attempts++ > 40) {reject(Error('SSH tunnel unavailable'));return;}
      const socket = net.connect(tunnelPort,'127.0.0.1');
      socket.once('connect', () => {socket.destroy();resolve();});
      socket.once('error', () => {socket.destroy();setTimeout(check,250);});
    };
    check();
  });
  server = http.createServer((request,response) => {
    const origin = `http://127.0.0.1:${localPort}`;
    if (request.headers.host !== `127.0.0.1:${localPort}` || request.headers.origin && request.headers.origin !== origin
        || request.headers['sec-fetch-site'] === 'cross-site') {
      response.writeHead(403);response.end();return;
    }
    const pathname = new URL(request.url,origin).pathname;
    if (!['GET','HEAD'].includes(request.method) || !(/^\/(?:index\.html|app\.js|live-data\.js|styles\.css|assets\/mark\.svg)?$/.test(pathname)
        || pathname === '/viewer/v1/snapshot' || /^\/viewer\/v1\/attachments\/(?:tg:\d+|dc:\d{4}-\d{2}-\d{2}:\d+)$/.test(pathname))) {
      response.writeHead(404);response.end();return;
    }
    const upstream = http.request({hostname:'127.0.0.1',port:tunnelPort,path:pathname,method:request.method,
      headers:{'x-viewer-token':token},timeout:15000}, incoming => {
      response.writeHead(incoming.statusCode,incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {if (!response.headersSent) response.writeHead(502);response.end();});
    response.on('close', () => {if (!response.writableFinished) upstream.destroy();});
    upstream.end();
  });
  server.on('error', error => {console.error(error.message);stop(1);});
  server.listen(localPort,'127.0.0.1', () => {
    console.log(`Live read-only viewer: http://127.0.0.1:${localPort}`);
    console.log('Refresh: 5 seconds. Ctrl+C closes the tunnel; remote viewer exits after 120 idle seconds.');
  });
  const ping = () => {
    const request = http.get({hostname:'127.0.0.1',port:tunnelPort,path:'/viewer/v1/ping',headers:{'x-viewer-token':token},timeout:5000}, response => response.resume());
    request.on('timeout',()=>request.destroy());
    request.on('error',()=>{});
  };
  ping();
  keepAlive = setInterval(ping,30000);
}
start().catch(error => {console.error(error.message);stop(1);});

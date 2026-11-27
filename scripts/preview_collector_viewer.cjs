/* Local static preview only. Never imports collector/sender business modules. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'../viewer');
const allowed = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/styles.css', ['styles.css','text/css; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/demo-data.js', ['demo-data.js','text/javascript; charset=utf-8']],
  ...['mark','chart-demo','notes-demo'].map(name=>[`/assets/${name}.svg`,[`assets/${name}.svg`,'image/svg+xml']])
]);
const port = Number(process.env.MUSE_VIEWER_PREVIEW_PORT || 18770);
if(!Number.isInteger(port)||port<1||port>65535) throw Error('Invalid preview port');
const server = http.createServer((req,res)=>{
  let name;
  try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end();return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'allow':'GET, HEAD'});res.end();return;}
  const entry=allowed.get(name);
  if(!entry){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Not found');return;}
  fs.readFile(path.join(root,entry[0]),(error,bytes)=>{
    if(error){res.writeHead(500);res.end('Preview file unavailable');return;}
    res.writeHead(200,{'content-type':entry[1],'content-length':bytes.length,'cache-control':'no-store',
      'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
    res.end(req.method==='HEAD'?undefined:bytes);
  });
});
server.on('error',error=>{console.error(`Preview failed: ${error.code || error.message}`);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`Muse UI preview: http://127.0.0.1:${port} (demo data only)`));

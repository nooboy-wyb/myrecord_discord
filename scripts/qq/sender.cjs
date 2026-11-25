process.env.MUSE_LOG_ROLE = 'qq-sender';
require('../collector_logger.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {acquireLock} = require('./core/process_lock.cjs');
const {createControlHandler} = require('./core/control_api.cjs');
const {collectorToken} = require('../collector_token.cjs');

function startSender() {
  const root = path.resolve(process.env.MUSE_DATA_DIR || path.resolve(__dirname,'../../data'));
  fs.mkdirSync(root,{recursive:true});
  const release = acquireLock(path.join(root,'qq-sender.lock'));
  process.once('exit',release);
  const tokenFile = path.join(root,'collector-token.txt');
  const token = collectorToken(tokenFile);
  const authorized = req => {
    const given = Buffer.from(req.headers['x-collector-token'] || ''),expected = Buffer.from(token);
    return given.length === expected.length && crypto.timingSafeEqual(given,expected);
  };
  const forwarder = require('./core/forwarder.cjs');
  const handle = createControlHandler({root,forwarder,authorized});
  const server = http.createServer((req,res) => {
    if (!authorized(req)) {res.writeHead(401);res.end(JSON.stringify({error:'unauthorized'}));return;}
    if (req.method === 'GET' && req.url === '/v1/health') {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(forwarder.health()));
      return;
    }
    handle(req,res);
  });
  server.listen(Number(process.env.MUSE_QQ_PORT || 8766),'127.0.0.1',() => {
    console.log(`QQ sender listening on http://127.0.0.1:${server.address().port}`);
    forwarder.start();
    require('./core/gateway.cjs').startGateway(forwarder.setOnline);
  });
  return server;
}
if (require.main === module) startSender();
module.exports = {startSender};

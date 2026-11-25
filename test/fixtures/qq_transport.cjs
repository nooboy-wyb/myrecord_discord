const fs = require('node:fs');
const path = require('node:path');
const root = process.env.MUSE_DATA_DIR;
if (!root || !process.env.MUSE_TEST_TRANSPORT) throw Error('Fixture transport requires an isolated test directory');
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const address = new URL(url);
  if (address.hostname === '127.0.0.1') return originalFetch(url,options);
  if (address.origin !== 'https://api.bot.qq.com') throw Error('External network is blocked in local tests');
  if (address.pathname === '/app/getAppAccessToken') return Response.json({access_token:'fixture-token',expires_in:7200});
  if (address.pathname === '/gateway') return Response.json({url:'wss://fixture.invalid'});
  if (/^\/v2\/groups\/[A-Z]+\/messages$/.test(address.pathname)) {
    const payload = JSON.parse(options.body);
    fs.appendFileSync(path.join(root,'mock-sends.jsonl'),JSON.stringify({at:Date.now(),pid:process.pid,
      group_openid:address.pathname.split('/')[3],payload})+'\n');
    return Response.json({id:`fixture-${Date.now()}`});
  }
  throw Error(`Unmocked QQ endpoint: ${address.pathname}`);
};
global.WebSocket = class FixtureSocket {
  constructor(url) {
    if (url !== 'wss://fixture.invalid') throw Error('External WebSocket is blocked');
    this.handlers = {};
    queueMicrotask(() => {
      this.handlers.open?.({});
      this.packet({op:10,d:{heartbeat_interval:10000}});
    });
  }
  addEventListener(name,handler) {this.handlers[name] = handler;}
  packet(value) {this.handlers.message?.({data:JSON.stringify(value)});}
  send(value) {
    const packet = JSON.parse(value);
    if (packet.op === 1) queueMicrotask(() => this.packet({op:11}));
    if (packet.op === 2 && fs.existsSync(path.join(root,'gateway-online'))) {
      queueMicrotask(() => this.packet({op:0,t:'READY',s:1,d:{session_id:'fixture'}}));
    }
  }
  close() {}
};

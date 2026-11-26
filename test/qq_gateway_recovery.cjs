const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(require.resolve('../scripts/qq/core/gateway.cjs'),'utf8');

async function harness({routes = []} = {}) {
  let clock = 100000;
  let timerId = 0;
  const timers = new Map();
  const sockets = [];
  const states = [];
  const logs = [];
  const requests = [];
  const monitors = [];
  const files = new Map([
    ['qq-group-openid.json', JSON.stringify({group_openid:'PRIMARY'})],
    ['qq-additional-routes.json', JSON.stringify({routes})]
  ]);
  class Clock extends Date { static now() { return clock; } }
  class FakeSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.handlers = {};
      this.sent = [];
      this.closeCount = 0;
      sockets.push(this);
    }
    addEventListener(name,handler) { this.handlers[name] = handler; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closeCount++; this.readyState = 3; }
    packet(packet) { this.handlers.message({data:JSON.stringify(packet)}); }
  }
  const addTimer = (callback,ms,interval) => {
    const id = ++timerId;
    timers.set(id,{callback,ms,interval,at:clock+ms});
    return id;
  };
  const record = value => logs.push(value);
  const context = {
    require:name => ['fs','node:fs'].includes(name) ? {
      existsSync:file => files.has(path.basename(file)),
      readFileSync:file => files.get(path.basename(file)),
      writeFileSync:(file,value) => files.set(path.basename(file),value)
    }
      : ['path','node:path'].includes(name) ? path
      : ['crypto','node:crypto'].includes(name) ? {randomUUID:() => `connection-${sockets.length}`}
      : name === 'node:perf_hooks' ? {monitorEventLoopDelay:() => {
        const monitor = {count:1,max:20e6,enabled:false,percentile:() => 20e6,
          enable() {this.enabled = true;},disable() {this.enabled = false;}};
        monitors.push(monitor);
        return monitor;
      }}
      : name === './gateway_diagnostics.cjs' ? require('../scripts/qq/core/gateway_diagnostics.cjs')
      : {bindingCode:() => null},
    __dirname:path.resolve('scripts/qq/core'),module:{exports:{}},Date:Clock,AbortSignal,
    process:{env:{QQ_BOT_APP_ID:'123',QQ_BOT_APP_SECRET:'fake-secret'}},
    console:{log:record,warn:record,error:record},WebSocket:FakeSocket,
    fetch:async (url,options) => {
      requests.push({url,options});
      return {ok:true,json:async() => url.endsWith('getAppAccessToken')
        ? {access_token:'fake-token'} : url.includes('/messages') ? {id:'confirmation'} : {url:'wss://fake-gateway'}};
    },
    setTimeout:(callback,ms) => addTimer(callback,ms,false),
    setInterval:(callback,ms) => addTimer(callback,ms,true),
    clearTimeout:id => timers.delete(id),clearInterval:id => timers.delete(id)
  };
  vm.runInNewContext(source,context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  async function advance(ms) {
    const until = clock+ms;
    for (;;) {
      const entry = [...timers].filter(([,timer]) => timer.at <= until)
        .sort((first,second) => first[1].at-second[1].at)[0];
      if (!entry) break;
      const [id,timer] = entry;
      clock = timer.at;
      if (timer.interval) timer.at += timer.ms;
      else timers.delete(id);
      timer.callback();
      await settle();
    }
    clock = until;
    await settle();
  }
  function hello(socket = sockets.at(-1)) {
    socket.packet({op:10,d:{heartbeat_interval:45000}});
  }
  function ready(socket = sockets.at(-1)) {
    socket.packet({op:0,t:'READY',s:10,d:{session_id:'fake-session'}});
  }
  context.module.exports.startGateway(value => states.push(value));
  await settle();
  return {sockets,timers,states,logs,advance,hello,ready,files,requests,monitors,
    elapseWithoutTimers:ms => {clock += ms;}};
}

test('silent binding saves TG1 OpenID only for its binding message and sends no confirmation',async() => {
  const setup = await harness({routes:[{name:'TG1',qq_group_number:'1137686115',binding_code:'TG1',
    binding_confirmation:false,channel_ids:[]}]});
  setup.hello(); setup.ready();
  const socket = setup.sockets[0];
  for (const d of [
    {group_openid:'OTHER',content:'TG1'},
    {group_openid:'OTHER',content:'bind 1137686115 WRONG'},
    {group_openid:'PRIMARY',content:'bind 1137686115 TG1'}
  ]) socket.packet({op:0,t:'GROUP_AT_MESSAGE_CREATE',d});
  assert.equal(JSON.parse(setup.files.get('qq-additional-routes.json')).routes[0].group_openid,undefined);
  socket.packet({op:0,t:'GROUP_AT_MESSAGE_CREATE',d:{group_openid:'TG_GROUP',content:'bind 1137686115 TG1'}});
  await setup.advance(0);
  const route = JSON.parse(setup.files.get('qq-additional-routes.json')).routes[0];
  assert.equal(route.group_openid,'TG_GROUP');
  assert(route.enabled_at);
  assert.equal(setup.requests.filter(request => request.url.includes('/messages')).length,0);
});

test('existing routes retain the default one-time binding confirmation',async() => {
  const setup = await harness({routes:[{qq_group_number:'12345',binding_code:'CODE',channel_ids:['123']}]});
  setup.hello(); setup.ready();
  const packet = {op:0,t:'GROUP_AT_MESSAGE_CREATE',d:{group_openid:'OTHER',content:'bind 12345 CODE'}};
  setup.sockets[0].packet(packet);
  setup.sockets[0].packet(packet);
  await setup.advance(0);
  assert.equal(setup.requests.filter(request => request.url.includes('/messages')).length,1);
});

test('op:7 reconnects immediately, resumes the last sequence, and ignores the old socket',async() => {
  const setup = await harness();
  setup.hello(); setup.ready();
  const oldSocket = setup.sockets[0];
  oldSocket.packet({op:0,t:'MESSAGE',s:42,d:{}});
  oldSocket.packet({op:7});
  oldSocket.packet({op:7});
  oldSocket.handlers.close({code:4009,reason:'Session timed out'});
  await setup.advance(0);
  assert.equal(setup.sockets.length,2);
  assert.equal(oldSocket.closeCount,1);
  setup.hello();
  assert.deepEqual(setup.sockets[1].sent[0],{op:6,d:{token:'QQBot fake-token',session_id:'fake-session',seq:42}});
  setup.sockets[1].packet({op:0,t:'RESUMED',s:43,d:{}});
  oldSocket.handlers.close({code:4009});
  oldSocket.packet({op:0,t:'READY',s:999,d:{session_id:'stale'}});
  assert.deepEqual(setup.states,[true,false,true]);
  assert.equal([...setup.timers.values()].filter(timer => timer.interval).length,1);
  assert(setup.logs.some(line => line.includes('SERVER_RECONNECT_OP7')));
  assert(setup.logs.some(line => line.includes('"event":"RESUMED"')));
  assert(setup.logs.every(line => !/fake-token|fake-secret|fake-session/.test(line)));
});

test('ACK clears the heartbeat deadline and missing ACK reconnects after one interval',async() => {
  const setup = await harness();
  setup.hello(); setup.ready();
  const socket = setup.sockets[0];
  await setup.advance(45000);
  assert.deepEqual(socket.sent.at(-1),{op:1,d:10});
  await setup.advance(25);
  socket.packet({op:11});
  await setup.advance(44975);
  assert.equal(socket.sent.filter(packet => packet.op === 1).length,2);
  assert.equal(setup.sockets.length,1);
  await setup.advance(45000);
  assert.equal(setup.sockets.length,2);
  assert(setup.logs.some(line => line.includes('"round_trip_ms":25')));
  assert(setup.logs.some(line => line.includes('HEARTBEAT_ACK_TIMEOUT')));
  assert(setup.logs.some(line => line.includes('"heartbeat_sent":2,"heartbeat_acked":1')));
});

test('an invalid resume session falls back to Identify and fresh READY',async() => {
  const setup = await harness();
  setup.hello(); setup.ready();
  setup.sockets[0].packet({op:7});
  await setup.advance(0);
  setup.hello();
  assert.equal(setup.sockets[1].sent[0].op,6);
  setup.sockets[1].packet({op:9,d:false});
  await setup.advance(1000);
  setup.hello();
  assert.equal(setup.sockets[2].sent[0].op,2);
  setup.ready();
  assert.equal(setup.states.at(-1),true);
});

test('4009 without op:7 resets the session and logs the full connection duration',async() => {
  const setup = await harness();
  setup.hello(); setup.ready();
  for (let heartbeat = 0; heartbeat < 80; heartbeat++) {
    await setup.advance(45000);
    setup.sockets[0].packet({op:11});
  }
  setup.sockets[0].handlers.close({code:4009,reason:'Session timed out'});
  assert(setup.logs.some(line => line.includes('"connection_ms":3600000')
    && line.includes('"heartbeat_sent":80,"heartbeat_acked":80')));
  await setup.advance(4999);
  assert.equal(setup.sockets.length,1);
  await setup.advance(1);
  setup.hello();
  assert.equal(setup.sockets[1].sent[0].op,2);
  setup.ready();
  assert(setup.logs.some(line => line.includes('"downtime_ms":5000')));
});

test('handshake timeout and socket error cannot schedule duplicate reconnects',async() => {
  const setup = await harness();
  await setup.advance(30000);
  setup.sockets[0].handlers.error();
  setup.sockets[0].handlers.close({code:1006});
  await setup.advance(5000);
  assert.equal(setup.sockets.length,2);
  setup.sockets[1].handlers.error();
  setup.sockets[1].handlers.close({code:1006});
  await setup.advance(5000);
  assert.equal(setup.sockets.length,3);
});

test('socket errors retain sanitized causes and the subsequent close code without reconnecting twice',async() => {
  const setup = await harness();
  setup.hello(); setup.ready();
  const socket = setup.sockets[0];
  socket.handlers.error({error:Object.assign(Error('socket failed QQBot fake-token'),{
    cause:Object.assign(Error('read ECONNRESET wss://example.invalid/?token=hidden fake-secret fake-session'),{code:'ECONNRESET'})
  })});
  socket.handlers.close({code:1006,reason:'session_id=hidden fake-session',wasClean:false});
  socket.handlers.close({code:1006});
  assert.equal(setup.monitors[0].enabled,false);
  const failure = JSON.parse(setup.logs.find(line => line.startsWith('QQ Gateway 连接错误：')).split('：')[1]);
  assert.equal(failure.error.details[1].code,'ECONNRESET');
  const closes = setup.logs.filter(line => line.startsWith('QQ Gateway 连接关闭：'));
  assert.equal(closes.length,1);
  const closed = JSON.parse(closes[0].split('：')[1]);
  assert.equal(closed.close_code,1006);
  assert.equal(closed.was_clean,false);
  assert.equal(closed.after_finish,true);
  assert(setup.logs.every(line => !/fake-token|fake-secret|fake-session|hidden|example\.invalid/.test(line)));
  await setup.advance(5000);
  assert.equal(setup.sockets.length,2);
  assert.equal(setup.monitors.filter(monitor => monitor.enabled).length,1);
});

test('late heartbeat logs scheduling and event loop delay while retaining normal ACK recovery',async() => {
  const setup = await harness();
  setup.hello(); setup.ready();
  setup.monitors[0].max = 17020e6;
  setup.elapseWithoutTimers(62000);
  [...setup.timers.values()].find(timer => timer.interval).callback();
  const late = JSON.parse(setup.logs.find(line => line.startsWith('QQ Gateway 心跳调度延迟：')).split('：')[1]);
  assert.equal(late.heartbeat_late_ms,17000);
  assert.equal(late.event_loop_max_ms,17020);
  setup.sockets[0].packet({op:11});
  setup.sockets[0].packet({op:7});
  assert(setup.logs.some(line => line.includes('"heartbeat_late_max_ms":17000')
    && line.includes('"heartbeat_sent":1,"heartbeat_acked":1')));
  assert.equal(setup.monitors[0].enabled,false);
});

test('socket errors without runtime details are marked unavailable instead of inventing a cause',async() => {
  const setup = await harness();
  setup.sockets[0].handlers.error();
  const failure = JSON.parse(setup.logs.find(line => line.startsWith('QQ Gateway 连接错误：')).split('：')[1]);
  assert.equal(failure.error.available,false);
  assert.equal(failure.error.details.length,0);
});

test('late close diagnostics still redact the session after invalid-session recovery clears it',async() => {
  const setup = await harness();
  setup.hello(); setup.ready();
  const socket = setup.sockets[0];
  socket.packet({op:9,d:false});
  socket.handlers.close({code:4009,reason:'fake-session fake-token fake-secret'});
  assert(setup.logs.every(line => !/fake-session|fake-token|fake-secret/.test(line)));
  await setup.advance(1000);
  setup.hello();
  assert.equal(setup.sockets[1].sent[0].op,2);
});

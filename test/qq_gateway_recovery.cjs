const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(require.resolve('../scripts/qq/core/gateway.cjs'),'utf8');

async function harness() {
  let clock = 100000;
  let timerId = 0;
  const timers = new Map();
  const sockets = [];
  const states = [];
  const logs = [];
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
    require:name => ['fs','node:fs'].includes(name) ? {existsSync:() => true}
      : ['path','node:path'].includes(name) ? path
      : ['crypto','node:crypto'].includes(name) ? {randomUUID:() => `connection-${sockets.length}`}
      : {bindingCode:() => null},
    __dirname:path.resolve('scripts/qq/core'),module:{exports:{}},Date:Clock,AbortSignal,
    process:{env:{QQ_BOT_APP_ID:'123',QQ_BOT_APP_SECRET:'fake-secret'}},
    console:{log:record,warn:record,error:record},WebSocket:FakeSocket,
    fetch:async url => ({ok:true,json:async() => url.endsWith('getAppAccessToken')
      ? {access_token:'fake-token'} : {url:'wss://fake-gateway'}}),
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
  return {sockets,timers,states,logs,advance,hello,ready};
}

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

const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const readline = require('node:readline');
const {DatabaseSync} = require('node:sqlite');

const project = path.resolve(__dirname,'..');
const channel = '1265882617530814535';
const primaryChannel = '1381176601802440744';
const liveChannel = '1571167749558902885';
const raChannel = '1381635122989891594';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function freePort() {
  const server = net.createServer();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(check, milliseconds = 18000) {
  const deadline = Date.now()+milliseconds;
  let failure;
  while (Date.now() < deadline) {
    try {const result = await check();if (result) return result;} catch (error) {failure = error;}
    await pause(50);
  }
  throw Error(`Fixture condition timed out${failure ? ': '+failure.message : ''}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child,'close');
  child.kill();
  await closed;
}

test('original DC routes survive QQ and TG downtime, drain once, and retain per-group spacing',
  {timeout:45000,skip:!process.env.MUSE_TEST_PYTHON && 'Set MUSE_TEST_PYTHON to run the three-process smoke test'},async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'muse-processes-'));
  const children = [];
  const output = [];
  t.after(async () => {
    for (const child of children.reverse()) await stop(child);
    fs.rmSync(root,{recursive:true,force:true});
  });
  const collectorPort = await freePort(),senderPort = await freePort();
  let token;
  const enabledAt = new Date(Date.now()-60000).toISOString();
  const write = (file,value) => fs.writeFileSync(path.join(root,file),JSON.stringify(value));
  fs.mkdirSync(path.join(root,'telegram'));
  write('qq-group-openid.json',{app_id:'123',group_openid:'PRIMARY'});
  write('qq-forward-controls.json',{primary_enabled:true,
    primary_channel_enabled_at:{[primaryChannel]:enabledAt,[liveChannel]:enabledAt}});
  write('qq-additional-routes.json',{routes:[
    {name:'TG1',group_openid:'SHARED',channel_ids:[channel,raChannel],allow_mixed_sources:true,enabled_at:enabledAt}
  ]});
  write('telegram/sources.json',{sources:[{enabled:true,peer_id:'-1001',topic_id:13,topic_title:'Topic',target:'TG1',enabled_at:enabledAt}]});
  const env = {...process.env,MUSE_DATA_DIR:root,MUSE_COLLECTOR_PORT:String(collectorPort),MUSE_QQ_PORT:String(senderPort),
    MUSE_TEST_TRANSPORT:'1',QQ_BOT_APP_ID:'123',QQ_BOT_APP_SECRET:'fake-secret',NODE_OPTIONS:'',QQ_FORWARD_ENABLED:'1'};
  function launch(program,args) {
    const child = spawn(program,args,{cwd:project,env,stdio:['pipe','pipe','pipe']});
    children.push(child);
    child.stdout.on('data',chunk => output.push(chunk.toString()));
    child.stderr.on('data',chunk => output.push(chunk.toString()));
    return child;
  }
  const preload = path.join(__dirname,'fixtures','qq_transport.cjs');
  const collector = launch(process.execPath,['--require',preload,'scripts/discord_collector_server.cjs']);
  let sender = launch(process.execPath,['--require',preload,'scripts/qq/sender.cjs']);
  const telegram = launch(process.env.MUSE_TEST_PYTHON,['-u','test/fixtures/telegram_monitor.py',path.join(root,'telegram')]);
  const lines = readline.createInterface({input:telegram.stdout});
  async function collectTelegram(id) {
    const response = once(lines,'line');
    telegram.stdin.write(JSON.stringify({id})+'\n');
    const [line] = await response;
    const status = JSON.parse(line);
    assert.equal(status.sources[0].status,'ok');
  }
  async function request(port,route,body) {
    return fetch(`http://127.0.0.1:${port}${route}`,{method:body ? 'POST' : 'GET',
      headers:{'x-collector-token':token,'content-type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(2000)});
  }
  const health = port => request(port,'/v1/health').then(response => response.ok && response.json());
  await until(() => {token = fs.readFileSync(path.join(root,'collector-token.txt'),'utf8').trim();return token;});
  await until(() => health(collectorPort));
  await until(() => health(senderPort));
  assert.equal((await health(senderPort)).online,false);
  assert.equal((await fetch(`http://127.0.0.1:${senderPort}/v1/health`)).status,401);
  async function capture(id,channelId = channel,missingTime = false) {
    const now = Date.now();
    const sourceId = ((BigInt(now)-1420070400000n)<<22n)+BigInt(id);
    const response = await request(collectorPort,'/v1/messages',{source:'discord_web',channel_id:channelId,
      source_message_id:String(sourceId),channel_name:channelId === raChannel ? 'RA' : 'DC fixture',source_timestamp:missingTime ? null : new Date(now).toISOString(),
      body_raw:`DC fixture ${id}`,attachments:[]});
    assert.equal(response.status,200,await response.text());
  }
  await capture(1,channel,true);
  await collectTelegram(1);
  await until(async () => (await health(senderPort)).outbox.reduce((count,item) => count+Number(item.count),0) === 2);
  assert.equal(fs.existsSync(path.join(root,'mock-sends.jsonl')),false);
  await stop(sender);
  await capture(2);
  await collectTelegram(2);
  await stop(telegram);
  await capture(3,primaryChannel);
  await capture(4,liveChannel,true);
  await capture(5,raChannel);
  await capture(6,'1381634972372308060');
  assert.equal((await health(collectorPort)).received,6);
  const unavailable = await request(collectorPort,`/v1/forwarding/status?channel_id=${channel}`);
  assert.equal(unavailable.status,503);
  const archive = new DatabaseSync(path.join(root,'telegram','archive.sqlite'),{readOnly:true});
  assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM telegram_messages').get().n,2);
  archive.close();
  fs.writeFileSync(path.join(root,'gateway-online'),'1');
  sender = launch(process.execPath,['--require',preload,'scripts/qq/sender.cjs']);
  await until(async () => (await health(senderPort))?.online);
  await until(async () => {
    const status = await health(senderPort);
    return !status.running && status.outbox.reduce((count,item) => count+(item.status === 'accepted' ? Number(item.count) : 0),0) === 7;
  });
  const sends = () => fs.readFileSync(path.join(root,'mock-sends.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(sends().length,7,output.join('').slice(-4000));
  assert.equal(new Set(sends().map(item => item.payload.content)).size,7);
  const raSends = sends().filter(item => item.payload.content.includes('🔵RA'));
  assert.equal(raSends.length,1);
  assert.equal(raSends[0].group_openid,'SHARED');
  assert.equal(sends().filter(item => item.payload.content.includes('（由消息 ID 推算）')).length,2);
  assert.equal((await health(senderPort)).timestamps.detected.DC_TIMESTAMP_MISSING,2);
  for (const group of ['PRIMARY','SHARED']) {
    const messages = sends().filter(item => item.group_openid === group);
    assert.equal(messages.length,group === 'PRIMARY' ? 2 : 5);
    for (let index = 1; index < messages.length; index++) assert.ok(messages[index].at-messages[index-1].at >= 1990);
  }
  const proxy = await request(collectorPort,`/v1/forwarding/status?channel_id=${channel}`);
  assert.equal(proxy.status,200);
  const paused = await request(collectorPort,'/v1/forwarding/pause',{channel_id:channel,paused:true});
  assert.equal((await paused.json()).paused,true);
  await stop(sender);
  sender = launch(process.execPath,['--require',preload,'scripts/qq/sender.cjs']);
  await until(async () => (await health(senderPort))?.online);
  await pause(5500);
  assert.equal(sends().length,7,'restart must not replay accepted messages');
  const diagnostics = new DatabaseSync(path.join(root,'collector-diagnostics.sqlite'),{readOnly:true});
  assert.equal(diagnostics.prepare("SELECT COUNT(*) AS n FROM collector_diagnostic_events WHERE code='DC_TIMESTAMP_MISSING'").get().n,2,
    'archive rescans and sender restart must not duplicate timestamp diagnostics');
  diagnostics.close();
  assert.equal(collector.exitCode,null);
  assert.notEqual(telegram.signalCode,null);
});

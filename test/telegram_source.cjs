const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {readSources,planTelegram,telegramAllowed} = require('../scripts/qq/core/telegram_source.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'muse-tg-source-'));
  const folder = path.join(root,'telegram');
  fs.mkdirSync(folder);
  const file = path.join(folder,'sources.json');
  const sources = [{enabled:true,peer_id:'-1001',topic_id:13,topic_title:'Topic',target:'TG1',enabled_at:'2026-11-25T00:00:00Z'}];
  const configure = () => fs.writeFileSync(file,JSON.stringify({sources}));
  configure();
  fs.writeFileSync(path.join(root,'qq-group-openid.json'),JSON.stringify({group_openid:'PRIMARY'}));
  fs.writeFileSync(path.join(root,'qq-additional-routes.json'),JSON.stringify({routes:[{name:'TG1',group_openid:'TESTGROUP',channel_ids:[],enabled_at:sources[0].enabled_at}]}));
  const archive = new DatabaseSync(path.join(folder,'archive.sqlite'));
  archive.exec(`CREATE TABLE telegram_messages (id INTEGER PRIMARY KEY,peer_id TEXT,message_id TEXT,
    channel_name TEXT,body_raw TEXT,source_timestamp TEXT,content_sha256 TEXT,edit_timestamp TEXT,grouped_id TEXT,payload_json TEXT);
    CREATE TABLE telegram_attachments (id INTEGER PRIMARY KEY,message_row_id INTEGER,media_id TEXT,kind TEXT,status TEXT,local_path TEXT,sha256 TEXT);`);
  function insert(id,{topic = '13',timestamp = '2026-11-25T01:00:00+00:00',attachments = []} = {}) {
    const payload = {peer_id:'-1001',message_id:String(id),body_raw:`message ${id}`,source_timestamp:timestamp,
      edit_timestamp:null,grouped_id:null,topic_id:topic,attachments};
    archive.prepare('INSERT INTO telegram_messages VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,'-1001',String(id),
      'Yekoi',payload.body_raw,timestamp,`hash-${id}`,null,null,JSON.stringify(payload));
  }
  t.after(() => {archive.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,file,sources,configure,archive,insert};
}

test('TG planner isolates topics and time boundaries, and disabled sources stop queued work',t => {
  const setup = fixture(t);
  setup.insert(1);
  setup.insert(2,{topic:'99'});
  setup.insert(3,{timestamp:'2026-11-24T23:59:59+00:00'});
  const jobs = [];
  const status = planTelegram(setup.root,(message,context) => jobs.push({message,context}));
  assert.equal(status.queued,1);
  assert.equal(jobs[0].message.channel_name,'Yekoi｜Topic');
  assert.equal(telegramAllowed(setup.root,jobs[0].message,jobs[0].context),true);
  setup.sources[0].enabled = false;
  setup.configure();
  assert.equal(telegramAllowed(setup.root,jobs[0].message,jobs[0].context),false);
});

test('missing image and corrupt payload are visible while valid later messages continue',t => {
  const setup = fixture(t);
  setup.insert(1,{attachments:[{media_id:'image',kind:'image'}]});
  setup.insert(2);
  setup.archive.prepare('UPDATE telegram_messages SET payload_json=? WHERE id=2').run('broken');
  setup.insert(3);
  const jobs = [];
  const status = planTelegram(setup.root,message => jobs.push(message));
  assert.equal(status.blocked.length,2);
  assert.deepEqual(jobs.map(item => item.source_message_id),['telegram:-1001:3']);
  const cached = planTelegram(setup.root,() => {throw Error('terminal jobs must not be reread');},() => true);
  assert.equal(cached.queued,0);
});

test('source configuration rejects ambiguous subscriptions and missing timezone',t => {
  const setup = fixture(t);
  setup.sources.push({...setup.sources[0],topic_id:null});
  setup.configure();
  assert.throws(() => readSources(setup.root),/overlap/);
  setup.sources.pop();
  setup.sources[0].enabled_at = '2026-11-25T00:00:00';
  setup.configure();
  assert.throws(() => readSources(setup.root),/Invalid/);
});

test('whole-peer subscriptions plan every topic under the same source identity',t => {
  const setup = fixture(t);
  setup.sources[0].topic_id = null;
  setup.configure();
  setup.insert(1,{topic:null});
  setup.insert(2);
  setup.insert(3,{topic:'99'});
  const jobs = [];
  const status = planTelegram(setup.root,(message,context) => jobs.push({message,context}));
  assert.equal(status.queued,3);
  assert.equal(status.blocked.length,0);
  assert.ok(jobs.every(job => job.message.channel_id === 'telegram:-1001:all'));
  assert.ok(jobs.every(job => telegramAllowed(setup.root,job.message,job.context)));
});

test('TG rejects primary, unbound or ambiguous targets both when planning and before sending',t => {
  const setup = fixture(t);
  setup.insert(1);
  const jobs = [];
  planTelegram(setup.root,(message,context) => jobs.push({message,context}));
  const file = path.join(setup.root,'qq-additional-routes.json');
  const valid = JSON.parse(fs.readFileSync(file,'utf8')).routes[0];
  for (const routes of [[{...valid,group_openid:'PRIMARY'}],[{...valid,enabled_at:null}],[valid,{...valid}]]) {
    fs.writeFileSync(file,JSON.stringify({routes}));
    const status = planTelegram(setup.root,() => assert.fail('invalid target must not enqueue'));
    assert.equal(status.queued,0);
    assert.equal(status.blocked.length,1);
    assert.equal(telegramAllowed(setup.root,jobs[0].message,jobs[0].context),false);
  }
});

test('one explicitly shared route keeps TG planning and send checks enabled alongside DC',t => {
  const setup = fixture(t);
  setup.insert(1);
  const file = path.join(setup.root,'qq-additional-routes.json');
  const route = JSON.parse(fs.readFileSync(file,'utf8')).routes[0];
  route.channel_ids = ['1381634972372308060'];
  const configure = () => fs.writeFileSync(file,JSON.stringify({routes:[route]}));
  configure();
  assert.equal(planTelegram(setup.root,() => assert.fail('sharing must be explicit')).blocked.length,1);
  route.allow_mixed_sources = true;
  configure();
  const jobs = [];
  assert.equal(planTelegram(setup.root,(message,context) => jobs.push({message,context})).queued,1);
  assert.equal(telegramAllowed(setup.root,jobs[0].message,jobs[0].context),true);
  for (const channelIds of [['invalid'],['1381634972372308060','1381634972372308060']]) {
    route.channel_ids = channelIds;
    configure();
    assert.equal(planTelegram(setup.root,() => assert.fail('invalid mixed route')).blocked.length,1);
    assert.equal(telegramAllowed(setup.root,jobs[0].message,jobs[0].context),false);
  }
});

test('Yekoi rules preserve other sources and stop a disabled source before planning and sending',t => {
  const {decorateChannelLabel} = require('../scripts/qq/core/channel_title_style.cjs');
  assert.equal(decorateChannelLabel('telegram:-1004472038576:13613','old title'),'Yekoi盘中状态更新');
  assert.equal(decorateChannelLabel('telegram:-1001:13','other topic'),'other topic');
  assert.equal(decorateChannelLabel('1381634972372308060','RA'),'🔵RA');
  const setup = fixture(t);
  setup.insert(1);
  const jobs = [];
  assert.equal(planTelegram(setup.root,(message,context) => jobs.push({message,context})).queued,1);
  assert.equal(telegramAllowed(setup.root,jobs[0].message,jobs[0].context),true);
  setup.sources[0].peer_id = '-1003432435785';
  setup.sources[0].topic_id = null;
  setup.configure();
  const row = setup.archive.prepare('SELECT payload_json FROM telegram_messages WHERE id=1').get();
  const payload = {...JSON.parse(row.payload_json),peer_id:'-1003432435785',topic_id:null};
  setup.archive.prepare('UPDATE telegram_messages SET peer_id=?,payload_json=? WHERE id=1')
    .run(payload.peer_id,JSON.stringify(payload));
  const status = planTelegram(setup.root,() => assert.fail('disabled Yekoi source must not enqueue'));
  assert.equal(status.queued,0);
  assert.equal(status.blocked.length,0);
  assert.equal(telegramAllowed(setup.root,{...jobs[0].message,channel_id:'telegram:-1003432435785:all'},jobs[0].context),false);
});

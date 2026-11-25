const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {archivedMessage, previousStatus} = require('../scripts/telegram/send_qq_history.cjs');

function fixture() {
  const archive = new DatabaseSync(':memory:');
  archive.exec(`CREATE TABLE telegram_messages (id INTEGER PRIMARY KEY,peer_id TEXT,message_id TEXT,
    channel_name TEXT,body_raw TEXT,source_timestamp TEXT,content_sha256 TEXT,edit_timestamp TEXT,grouped_id TEXT,payload_json TEXT);
    CREATE TABLE telegram_attachments (id INTEGER PRIMARY KEY,message_row_id INTEGER,media_id TEXT,kind TEXT,status TEXT,local_path TEXT,sha256 TEXT);`);
  const expected = {row_id:1,message_id:'77695',body_raw:'原始正文',source_timestamp:'2026-11-24T16:33:37+00:00',
    content_sha256:'verified-content',edit_timestamp:null,grouped_id:null,attachments:[],verification_errors:[]};
  const audit = {peer_id:'-1004472038576',channel_name:'Yekoi',topic_id:13613,topic_title:'ye-koi盘中状态更新'};
  const payload = {topic_id:'13613',body_raw:expected.body_raw,source_timestamp:expected.source_timestamp,attachments:[]};
  archive.prepare('INSERT INTO telegram_messages VALUES (?,?,?,?,?,?,?,?,?,?)').run(1,audit.peer_id,expected.message_id,
    audit.channel_name,expected.body_raw,expected.source_timestamp,expected.content_sha256,null,null,JSON.stringify(payload));
  return {archive,audit,expected,payload};
}

test('archived topic keeps source identity and the requested channel title', () => {
  const setup = fixture();
  try {
    const message = archivedMessage(setup.archive,setup.audit,setup.expected);
    assert.equal(message.channel_name,'Yekoi｜ye-koi盘中状态更新');
    assert.equal(message.channel_id,'telegram:-1004472038576:13613');
    assert.equal(message.source_message_id,'telegram:-1004472038576:77695');
    assert.equal(message.body_raw,'原始正文');
    setup.archive.prepare('UPDATE telegram_messages SET body_raw=?').run('corrupted');
    assert.throws(() => archivedMessage(setup.archive,setup.audit,setup.expected), /differs/);
  } finally { setup.archive.close(); }
});

test('wrong topic and missing or corrupted image stop preflight', () => {
  const setup = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'telegram-qq-'));
  try {
    assert.throws(() => archivedMessage(setup.archive,{...setup.audit,topic_id:8},setup.expected), /payload/);
    const image = {media_id:'123',kind:'image',mime_type:'image/jpeg',size:4};
    setup.expected.attachments = [image];
    setup.payload.attachments = [image];
    setup.archive.prepare('UPDATE telegram_messages SET payload_json=?').run(JSON.stringify(setup.payload));
    assert.throws(() => archivedMessage(setup.archive,setup.audit,setup.expected), /count/);
    const file = path.join(directory,'image.jpg');
    fs.writeFileSync(file,'data');
    const hash = crypto.createHash('sha256').update('data').digest('hex');
    setup.archive.prepare('INSERT INTO telegram_attachments (message_row_id,media_id,kind,status,local_path,sha256) VALUES (?,?,?,?,?,?)')
      .run(1,'123','image','saved',file,hash);
    const message = archivedMessage(setup.archive,setup.audit,setup.expected);
    assert.equal(message.attachments[0].local_path,file);
    assert.match(message.attachments[0].source_url,/telegram:\/\//);
    fs.writeFileSync(file,'corrupted');
    assert.throws(() => archivedMessage(setup.archive,setup.audit,setup.expected), /SHA-256/);
  } finally {
    setup.archive.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('only a fully accepted identical message can be skipped without sending', () => {
  const parts = [{type:'text'},{type:'image'}];
  const accepted = parts.map((part,index) => ({task_key:'same',part_index:index,part_type:part.type,
    status:'accepted',platform_message_id:`platform-${index}`}));
  assert.equal(previousStatus([],'same',parts),'pending');
  assert.equal(previousStatus(accepted,'same',parts),'already_accepted');
  assert.throws(() => previousStatus(accepted.slice(0,1),'same',parts), /incomplete/);
  assert.throws(() => previousStatus(accepted,'changed',parts), /changed/);
  assert.throws(() => previousStatus([{...accepted[0],status:'unknown'},accepted[1]],'same',parts), /uncertain/);
  assert.throws(() => previousStatus([{...accepted[0],platform_message_id:null},accepted[1]],'same',parts), /uncertain/);
});

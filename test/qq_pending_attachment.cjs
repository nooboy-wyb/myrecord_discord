const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {test} = require('node:test');

test('a live image waiting for download remains eligible after a newer message advances the watermark',()=>{
  const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
  const remember = source.slice(source.indexOf('function rememberPendingLiveImage('),source.indexOf('async function processMessage('));
  const eligibility = source.slice(source.indexOf('function liveMessageEligible('),source.indexOf('function speakerName('));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE forward_attempts(task_key TEXT,part_index INTEGER,status TEXT,error TEXT);
    CREATE UNIQUE INDEX ix_attempt ON forward_attempts(task_key,part_index);`);
  const writes=[];
  const ctx = vm.createContext({crypto,Date,state:db,liuyudong:{channelId:'liu'},
    sourceTime:m=>Date.parse(m.source_timestamp),isAfterLiveWatermark:()=>false,
    liveWatermark:()=>({source_timestamp:'2026-11-06T10:20:00Z'}),
    record:(key,index,type,message,status)=>{
      writes.push(status);
      db.prepare('INSERT INTO forward_attempts VALUES (?,?,?,NULL)').run(key,index,status);
    }});
  const functions=vm.runInContext(remember+'\n'+eligibility+'\n({rememberPendingLiveImage,liveMessageEligible})',ctx);
  const message={channel_id:'liu',source_message_id:'1568206430002094202',content_sha256:'test',
    source_timestamp:'2026-11-06T10:12:28Z',attachments:[{status:'pending'}]};
  try {
    functions.rememberPendingLiveImage(message,'group');
    assert.equal(functions.liveMessageEligible('group',message,0),true);
    db.exec("UPDATE forward_attempts SET status='accepted'");
    functions.rememberPendingLiveImage(message,'group');
    assert.equal(db.prepare('SELECT status FROM forward_attempts').get().status,'accepted');
    assert.deepEqual(writes,['preparing'],'accepted sends must never be reset to pending');
  } finally {db.close();}
});

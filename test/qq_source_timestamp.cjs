const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const {DatabaseSync} = require('node:sqlite');
const {resolveSourceTimestamp,normalizeSourceTimestamp} = require('../scripts/qq/core/source_timestamp.cjs');
const {createOutbox} = require('../scripts/qq/core/outbox.cjs');

const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
const helpers = vm.runInNewContext(source.slice(source.indexOf('function sourceTime('),
  source.indexOf('function liveWatermark('))+'\n({sourceTime,sourceTimeLabel})',{resolveSourceTimestamp});
const grouped = (id = '1575373315126595588') => ({channel_id:'1381176601802440744',
  source_message_id:id,source_timestamp:null,captured_at:'2026-11-26T04:51:18.978Z',content_sha256:'fixture'});

test('grouped Discord messages retain their own ID times and inferred labels after queue normalization',() => {
  const first = grouped(),second = grouped('1575373324362453093');
  assert.equal(normalizeSourceTimestamp(first).source_timestamp,'2026-11-26T04:51:07.347Z');
  assert.equal(normalizeSourceTimestamp(second).source_timestamp,'2026-11-26T04:51:09.549Z');
  assert.equal(helpers.sourceTimeLabel(first),'【2026-11-26 12:51:07 UTC+8】（由消息 ID 推算）');
  assert.equal(helpers.sourceTimeLabel(normalizeSourceTimestamp(first)),helpers.sourceTimeLabel(first));
  assert.equal(first.source_timestamp,null);
  assert.equal(helpers.sourceTime(normalizeSourceTimestamp(first)),helpers.sourceTime(first));
});

test('valid source times stay unchanged and invalid values use the same inference as missing values',() => {
  const explicit = {...grouped(),source_timestamp:'2026-11-26T12:51:07.347+08:00'};
  assert.equal(normalizeSourceTimestamp(explicit),explicit);
  assert.equal(helpers.sourceTimeLabel(explicit),'【2026-11-26 12:51:07 UTC+8】');
  for (const value of ['',null,undefined,'invalid','999999-11-26T00:00:00Z']) {
    const normalized = normalizeSourceTimestamp({...grouped(),source_timestamp:value});
    assert.equal(normalized.source_timestamp,'2026-11-26T04:51:07.347Z');
    assert.equal(normalized.source_timestamp_origin,'discord_snowflake');
  }
});

test('capture plus one second is a stable last fallback and is explicitly labelled as estimated',() => {
  for (const id of ['invalid','telegram:-1001:12','999999999999999999999','18446744073709551616']) {
    const item = {...grouped(id),source_timestamp:'invalid'};
    const normalized = normalizeSourceTimestamp(item);
    assert.equal(normalized.source_timestamp,'2026-11-26T04:51:19.978Z');
    assert.equal(normalized.source_timestamp_origin,'captured_plus_1s');
    assert.equal(helpers.sourceTimeLabel(normalized),'【2026-11-26 12:51:19 UTC+8】（采集时间+1秒估算）');
    assert.deepEqual(normalizeSourceTimestamp(normalized),normalized);
    assert.equal(helpers.sourceTime(item),Date.parse(normalized.source_timestamp));
  }
  const invalid = {...grouped('invalid'),captured_at:null};
  assert.equal(resolveSourceTimestamp(invalid),null);
  assert.equal(helpers.sourceTimeLabel(invalid),'【时间未知】');
  assert.throws(() => normalizeSourceTimestamp(invalid),{code:'SOURCE_TIMESTAMP_UNAVAILABLE'});
});

test('null timestamps persist in both queue fields, survive recovery and do not change accepted task identity',async t => {
  const state = new DatabaseSync(':memory:');
  t.after(() => state.close());
  const sent = [];
  const context = {group_openid:'FIXTURE'};
  let queue = createOutbox({state,send:async () => {throw Error('offline');}});
  const item = grouped(),key = queue.enqueue(item,context);
  const row = state.prepare('SELECT * FROM sender_outbox WHERE task_key=?').get(key);
  assert.equal(row.source_timestamp,'2026-11-26T04:51:07.347Z');
  assert.equal(JSON.parse(row.message_json).source_timestamp,row.source_timestamp);
  assert.equal(JSON.parse(row.message_json).source_timestamp_origin,'discord_snowflake');
  queue = createOutbox({state,send:async message => {sent.push(message);return 'accepted';}});
  queue.recover();
  await queue.drain();
  assert.equal(queue.enqueue({...item,source_timestamp:row.source_timestamp},context),key);
  await queue.drain();
  assert.equal(sent.length,1);
  assert.equal(helpers.sourceTimeLabel(sent[0]),helpers.sourceTimeLabel(item));
  assert.equal(state.prepare('SELECT status FROM sender_outbox WHERE task_key=?').get(key).status,'accepted');
});

test('unusable timestamps are isolated during archive reads while later valid messages remain plannable',async () => {
  const rows = [{...grouped('invalid'),captured_at:null},grouped()];
  class FixtureDatabase {
    exec() {}
    prepare() {return {all:() => rows};}
    close() {}
  }
  const read = vm.runInNewContext(source.slice(source.indexOf('async function pendingMessages()'),
    source.indexOf('function recentMessages('))+'\npendingMessages',{
    DatabaseSync:FixtureDatabase,setImmediate,
    state:{prepare:() => ({get:() => ({value:'2026-11-26T00:00:00Z'})})},
    sourceFiles:() => ['fixture'],sourceTime:helpers.sourceTime,attachmentFiles:() => [],
    timestampDiagnostics:{inspect:() => {}}
  });
  const planned = await read();
  assert.equal(planned.length,1);
  assert.equal(planned[0].source_message_id,grouped().source_message_id);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {DatabaseSync} = require('node:sqlite');
const {saveDiagnostic} = require('../scripts/collector_diagnostics.cjs');
const {timestampAnomaly,createTimestampDiagnostics} = require('../scripts/qq/core/timestamp_diagnostics.cjs');
const {resolveSourceTimestamp} = require('../scripts/qq/core/source_timestamp.cjs');
const {createOutbox} = require('../scripts/qq/core/outbox.cjs');

const message = (id = '1575371377479782461') => ({channel_id:'1265882617530814535',
  source_message_id:id,source_timestamp:null,captured_at:'2026-11-26T04:43:26.306Z',content_sha256:'fixture'});

test('missing, invalid and mismatched DOM times have different diagnostics and safe resolution metadata',() => {
  const missing = timestampAnomaly(message());
  assert.equal(missing.code,'DC_TIMESTAMP_MISSING');
  assert.equal(missing.detail.severity,'info');
  assert.equal(missing.detail.resolution,'discord_snowflake');
  assert.equal(missing.detail.resolved_timestamp,'2026-11-26T04:43:25.376Z');
  assert.equal(missing.detail.action,'forward_individually_with_inferred_time');
  const invalid = timestampAnomaly({...message(),source_timestamp:'private-token https://private.invalid'});
  assert.equal(invalid.code,'DC_TIMESTAMP_INVALID');
  assert.equal(invalid.detail.severity,'warning');
  assert(!JSON.stringify(invalid).includes('private'));
  const mismatch = timestampAnomaly({...message(),source_timestamp:'2026-11-26T04:45:25.376Z'});
  assert.equal(mismatch.code,'DC_TIMESTAMP_MISMATCH');
  assert.equal(mismatch.detail.skew_ms,120000);
  assert.equal(mismatch.detail.action,'forward_individually_with_source_time');
  assert.equal(timestampAnomaly({...message(),source_timestamp:'2026-11-26T04:43:25.376Z'}),null);
  assert.equal(timestampAnomaly({...message(),source_timestamp:'2026-11-26T04:44:25.376Z'}),null);
  assert.equal(timestampAnomaly({...message(),channel_id:'telegram:-1001:all'}),null);
});

test('one second fallback is a warning and an unresolvable time remains an isolated error',() => {
  const fallback = timestampAnomaly(message('999999999999999999999'));
  assert.equal(fallback.detail.resolution,'captured_plus_1s');
  assert.equal(fallback.detail.severity,'warning');
  assert.equal(fallback.detail.resolved_timestamp,'2026-11-26T04:43:27.306Z');
  const unusable = timestampAnomaly({...message('999999999999999999999'),captured_at:'private value'});
  assert.equal(unusable.detail.resolution,'unavailable');
  assert.equal(unusable.detail.severity,'error');
  assert.equal(unusable.detail.action,'skip_unusable_timestamp');
  assert(!JSON.stringify(unusable).includes('private'));
});

test('diagnostics persist once per source across ticks, edits, targets and sender restarts without private content',t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse-timestamp-diag-'));
  t.after(() => fs.rmSync(folder,{recursive:true,force:true}));
  const file = path.join(folder,'diagnostics.sqlite');
  let writes = 0;
  const save = event => {writes++;return saveDiagnostic(event,file);};
  const item = {...message(),body_raw:'private text',author_display:'private author',
    attachments_json:'private URL',payload_json:'private credential'};
  let detector = createTimestampDiagnostics({save});
  detector.inspect(item);
  detector.inspect({...item,content_sha256:'edited'});
  assert.equal(writes,1);
  assert.equal(detector.status().detected.DC_TIMESTAMP_MISSING,1);
  detector = createTimestampDiagnostics({save});
  detector.inspect({...item,captured_at:'2026-11-26T05:00:00Z'});
  detector.inspect({...item,source_timestamp:'not a time'});
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    const rows = db.prepare('SELECT * FROM collector_diagnostic_events').all();
    assert.equal(rows.length,2);
    assert(!JSON.stringify(rows).includes('private'));
    assert.deepEqual(rows.map(row => row.code).sort(),['DC_TIMESTAMP_INVALID','DC_TIMESTAMP_MISSING']);
  } finally {db.close();}
});

test('diagnostic storage failures do not block forwarding and retry later instead of losing the event',async t => {
  const state = new DatabaseSync(':memory:');
  t.after(() => state.close());
  let clock = Date.parse('2026-11-26T04:43:28Z'),available = false;
  const saved = [],warnings = [],sent = [];
  const detector = createTimestampDiagnostics({now:() => clock,warn:text => warnings.push(text),
    save:event => {if (!available) throw Error('private storage failure');saved.push(event);}});
  const queue = createOutbox({state,send:async item => {sent.push(item.source_message_id);return 'accepted';}});
  detector.inspect(message());
  detector.inspect(message());
  assert.equal(detector.status().pending_records,1);
  assert.equal(warnings.length,1);
  assert(!warnings.join('').includes('private'));
  queue.enqueue(message(),{group_openid:'FIXTURE'});
  await queue.drain();
  assert.deepEqual(sent,[message().source_message_id]);
  available = true;clock += 30000;
  detector.inspect(message());
  assert.equal(saved.length,1);
  assert.equal(detector.status().pending_records,0);
  assert.equal(detector.status().last_error,null);
});

test('archive inspection observes an unusable row and keeps later messages separate in the outbox',async t => {
  const state = new DatabaseSync(':memory:');
  t.after(() => state.close());
  const rows = [{...message('999999999999999999999'),captured_at:null},message(),
    message('1575373315126595588')];
  class Archive {
    exec() {}
    prepare() {return {all:() => rows};}
    close() {}
  }
  const events = [],sent = [];
  const detector = createTimestampDiagnostics({save:event => events.push(event)});
  const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
  const read = vm.runInNewContext(source.slice(source.indexOf('async function pendingMessages()'),
    source.indexOf('function recentMessages('))+'\npendingMessages',{
    DatabaseSync:Archive,setImmediate,state:{prepare:() => ({get:() => ({value:'2026-11-26T00:00:00Z'})})},
    sourceFiles:() => ['fixture'],sourceTime:item => resolveSourceTimestamp(item)?.time ?? NaN,
    attachmentFiles:() => [],timestampDiagnostics:detector
  });
  const pending = await read();
  assert.equal(events.length,3);
  assert.equal(events[0].detail.severity,'error');
  const queue = createOutbox({state,send:async item => {sent.push(item.source_message_id);return 'accepted';}});
  for (const item of pending) queue.enqueue(item,{group_openid:'FIXTURE'});
  await queue.drain();
  assert.deepEqual(sent,rows.slice(1).map(item => item.source_message_id));
});

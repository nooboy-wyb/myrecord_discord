const assert=require('node:assert/strict');
const {captureDiagnostic}=require('../scripts/collector_capture_trace.cjs');
const sourceAt=Date.parse('2026-11-04T05:11:49.167Z');
const message={channel_id:'1265882617530814535',source_message_id:'1567405990654251101',
  body_raw:'private content',attachments:[{source_url:'https://private.example/image'}],
  capture_trace:{scan_id:`${sourceAt+1000}-1`,scan_started_at:sourceAt+1000,
    observed_at:sourceAt+1100,queued_at:sourceAt+1200,body:'do not log'}};
const event=captureDiagnostic(message,sourceAt+1400,sourceAt+1450,'test');
assert.equal(event.detail.source_to_observed_ms,1100);
assert.equal(event.detail.observed_to_queue_ms,100);
assert.equal(event.detail.queue_to_server_ms,200);
assert.equal(event.detail.server_save_ms,50);
assert.equal(event.detail.source_to_persisted_ms,1450);
assert(!JSON.stringify(event).includes('private'));
assert(!JSON.stringify(event).includes('do not log'));
assert.equal(captureDiagnostic({...message,capture_trace:null},1,2,'test'),null);
assert.equal(captureDiagnostic({...message,capture_trace:{...message.capture_trace,queued_at:'bad'}},1,2,'test'),null);
console.log('Capture latency breakdown validates timings and excludes content.');

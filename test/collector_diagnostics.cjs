const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {saveDiagnostic,recoveryAlertAlreadyHandled} = require('../scripts/collector_diagnostics.cjs');

const folder = fs.mkdtempSync(path.join(os.tmpdir(),'collector-diagnostics-'));
const file = path.join(folder,'events.sqlite');
try {
  const event = {event_id:randomUUID(),at:Date.now(),code:'RECOVERY_STARTED',
    channel_id:'1265882617530814535',tab_id:7,incident_at:Date.now(),attempt:1,
    detail:{trigger_code:'SCAN_HEARTBEAT_STALE'}};
  assert.equal(saveDiagnostic(event,file).saved,true);
  assert.equal(saveDiagnostic(event,file).saved,false,'retried upload must not duplicate a log row');
  assert.throws(() => saveDiagnostic({...event,event_id:randomUUID(),code:'bad code'},file));
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    const rows = db.prepare('SELECT * FROM collector_diagnostic_events').all();
    assert.equal(rows.length,1);
    assert.equal(rows[0].channel_id,event.channel_id);
    assert.equal(JSON.parse(rows[0].detail_json).trigger_code,'SCAN_HEARTBEAT_STALE');
  } finally { db.close(); }
  const alert = {channelId:event.channel_id,requestedAt:event.incident_at,status:'timeout'};
  assert.equal(recoveryAlertAlreadyHandled(alert,file),false);
  saveDiagnostic({event_id:randomUUID(),at:Date.now(),code:'RECOVERY_SCAN_RESTORED',
    channel_id:event.channel_id,incident_at:event.incident_at},file);
  assert.equal(recoveryAlertAlreadyHandled(alert,file),true,
    'a restored scan makes a delayed timeout obsolete');
  assert.equal(recoveryAlertAlreadyHandled({...alert,status:'recovered'},file),false);
  saveDiagnostic({event_id:randomUUID(),at:Date.now(),code:'ALERT_ACCEPTED',
    channel_id:event.channel_id,incident_at:event.incident_at,detail:{status:'recovered'}},file);
  assert.equal(recoveryAlertAlreadyHandled({...alert,status:'recovered'},file),true,
    'restart must not resend an accepted success alert');
  assert.equal(recoveryAlertAlreadyHandled(alert,file),true,
    'restart must not send a failure after an accepted success');
  console.log('Collector diagnostics persist locally and deduplicate retried uploads.');
} finally { fs.rmSync(folder,{recursive:true,force:true}); }

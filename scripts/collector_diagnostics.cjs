const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const defaultFile = path.resolve(__dirname,'../data/collector-diagnostics.sqlite');

function saveDiagnostic(event, file = defaultFile) {
  if (!event || typeof event !== 'object' ||
      !/^[a-f0-9-]{36}$/.test(String(event.event_id || '')) ||
      !/^[A-Z][A-Z0-9_]{2,63}$/.test(String(event.code || '')) ||
      !Number.isSafeInteger(event.at) || event.at <= 0 ||
      (event.channel_id != null && !/^\d{15,22}$/.test(String(event.channel_id))) ||
      (event.tab_id != null && !Number.isInteger(event.tab_id)) ||
      (event.attempt != null && (!Number.isInteger(event.attempt) || event.attempt < 0))) {
    throw Error('invalid diagnostic event');
  }
  const error = String(event.error || '').slice(0,1000);
  const detail = JSON.stringify(event.detail && typeof event.detail === 'object' ? event.detail : {});
  if (detail.length > 4000) throw Error('diagnostic detail too large');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS collector_diagnostic_events (
      event_id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
      code TEXT NOT NULL, channel_id TEXT, tab_id INTEGER, incident_at INTEGER,
      attempt INTEGER, source_message_id TEXT, requested_at INTEGER, loaded_at INTEGER,
      last_scan_at INTEGER, last_good_at INTEGER, next_attempt_at INTEGER,
      error TEXT, detail_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_collector_diag_channel_time
        ON collector_diagnostic_events(channel_id, occurred_at);
      CREATE INDEX IF NOT EXISTS ix_collector_diag_incident
        ON collector_diagnostic_events(channel_id, incident_at);`);
    const result = db.prepare(`INSERT OR IGNORE INTO collector_diagnostic_events
      (event_id,occurred_at,received_at,code,channel_id,tab_id,incident_at,attempt,
       source_message_id,requested_at,loaded_at,last_scan_at,last_good_at,next_attempt_at,error,detail_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.event_id,new Date(event.at).toISOString(),new Date().toISOString(),event.code,
      event.channel_id == null ? null : String(event.channel_id),event.tab_id ?? null,
      event.incident_at ?? null,event.attempt ?? null,
      event.source_message_id == null ? null : String(event.source_message_id),
      event.requested_at ?? null,event.loaded_at ?? null,event.last_scan_at ?? null,
      event.last_good_at ?? null,event.next_attempt_at ?? null,error || null,detail);
    return {saved:result.changes === 1};
  } finally { db.close(); }
}

function recoveryAlertAlreadyHandled(event, file = defaultFile) {
  if (!fs.existsSync(file)) return false;
  const db = new DatabaseSync(file, {readOnly:true});
  try {
    const rows = db.prepare(`SELECT code,detail_json FROM collector_diagnostic_events
      WHERE channel_id=? AND incident_at=? AND code IN ('ALERT_ACCEPTED','RECOVERY_SCAN_RESTORED')`)
      .all(event.channelId,event.requestedAt);
    return rows.some(row => row.code === 'RECOVERY_SCAN_RESTORED'
      && ['timeout','failed'].includes(event.status)
      || row.code === 'ALERT_ACCEPTED' && (() => {
        const priorStatus = JSON.parse(row.detail_json).status;
        return priorStatus === event.status || priorStatus === 'recovered'
          && ['timeout','failed'].includes(event.status);
      })());
  } finally { db.close(); }
}

module.exports = {saveDiagnostic,recoveryAlertAlreadyHandled,defaultFile};

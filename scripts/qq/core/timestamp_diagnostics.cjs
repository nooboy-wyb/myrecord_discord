const crypto = require('node:crypto');
const {resolveSourceTimestamp} = require('./source_timestamp.cjs');

function timestampAnomaly(message) {
  if (!/^\d{15,22}$/.test(message.channel_id || '') || !/^\d+$/.test(message.source_message_id || '')) return null;
  const value = message.source_timestamp;
  const present = value != null && !(typeof value === 'string' && !value.trim());
  const explicit = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  const idTime = resolveSourceTimestamp({source_message_id:message.source_message_id});
  let issue;
  if (!present) issue = 'MISSING';
  else if (!Number.isFinite(explicit)) issue = 'INVALID';
  else if (idTime && Math.abs(explicit - idTime.time) > 60_000) issue = 'MISMATCH';
  else return null;
  const resolved = resolveSourceTimestamp(message);
  const captured = Date.parse(message.captured_at || '');
  const detail = {severity:!resolved ? 'error' : issue === 'MISSING' && idTime ? 'info' : 'warning',
    timestamp_present:present,resolution:resolved?.origin || 'unavailable',
    resolved_timestamp:resolved ? new Date(resolved.time).toISOString() : null,
    snowflake_timestamp:idTime?.timestamp || null,
    captured_at:Number.isFinite(captured) ? new Date(captured).toISOString() : null,
    action:!resolved ? 'skip_unusable_timestamp' : issue === 'MISMATCH'
      ? 'forward_individually_with_source_time' : 'forward_individually_with_inferred_time'};
  if (issue === 'MISMATCH') detail.skew_ms = explicit - idTime.time;
  return {code:`DC_TIMESTAMP_${issue}`,channel_id:message.channel_id,
    source_message_id:message.source_message_id,detail};
}

function createTimestampDiagnostics({save,now = Date.now,warn = console.warn}) {
  const seen = new Set(),retryAfter = new Map(),counts = {};
  let lastDetectedAt = null,lastError = null;
  function inspect(message) {
    const anomaly = timestampAnomaly(message);
    if (!anomaly) return;
    const identity = JSON.stringify([anomaly.code,anomaly.channel_id,anomaly.source_message_id,anomaly.detail.resolution]);
    if (seen.has(identity) || (retryAfter.get(identity) || 0) > now()) return;
    const hex = crypto.createHash('sha256').update(identity).digest('hex');
    const eventId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
    try {
      save({...anomaly,event_id:eventId,at:now()});
      seen.add(identity);
      retryAfter.delete(identity);
      counts[anomaly.code] = (counts[anomaly.code] || 0) + 1;
      lastDetectedAt = new Date(now()).toISOString();
      lastError = null;
    } catch {
      retryAfter.set(identity,now()+30000);
      lastError = 'Timestamp diagnostic storage unavailable; retrying without pausing forwarding';
      warn(lastError);
    }
  }
  function status() {
    return {scope:'distinct_archive_messages_seen_this_process',detected:{...counts},
      pending_records:retryAfter.size,last_detected_at:lastDetectedAt,last_error:lastError};
  }
  return {inspect,status};
}

module.exports = {timestampAnomaly,createTimestampDiagnostics};

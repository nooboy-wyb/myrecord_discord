// Diagnostics contain identifiers and timings only; message bodies and URLs stay out.
function captureDiagnostic(message, receivedAt, persistedAt, eventId) {
  const trace = message.capture_trace;
  if (!trace || typeof trace.scan_id !== 'string'
      || !/^\d{13}-\d{1,10}$/.test(trace.scan_id)
      || ![trace.scan_started_at,trace.observed_at,trace.queued_at,receivedAt,persistedAt]
        .every(value => Number.isSafeInteger(value) && value > 0)) return null;
  const sourceAt = Number((BigInt(message.source_message_id) >> 22n) + 1420070400000n);
  return {event_id:eventId,at:persistedAt,code:'CAPTURE_PERSISTED',
    channel_id:message.channel_id,source_message_id:message.source_message_id,
    detail:{scan_id:trace.scan_id,scan_started_at:trace.scan_started_at,
      observed_at:trace.observed_at,queued_at:trace.queued_at,
      received_at:receivedAt,persisted_at:persistedAt,
      source_to_observed_ms:trace.observed_at - sourceAt,
      observed_to_queue_ms:trace.queued_at - trace.observed_at,
      queue_to_server_ms:receivedAt - trace.queued_at,
      server_save_ms:persistedAt - receivedAt,
      source_to_persisted_ms:persistedAt - sourceAt}};
}
module.exports = {captureDiagnostic};

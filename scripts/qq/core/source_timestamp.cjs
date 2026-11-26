function timestampValue(value) {
  return typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
}

function resolveSourceTimestamp(message) {
  const explicit = timestampValue(message.source_timestamp);
  if (Number.isFinite(explicit)) {
    return {timestamp:message.source_timestamp,time:explicit,origin:message.source_timestamp_origin || 'source'};
  }
  if (/^\d{15,20}$/.test(message.source_message_id || '')) {
    const snowflake = BigInt(message.source_message_id);
    if (snowflake <= 18446744073709551615n) {
      const time = Number((snowflake >> 22n) + 1420070400000n);
      return {timestamp:new Date(time).toISOString(),time,origin:'discord_snowflake'};
    }
  }
  const time = timestampValue(message.captured_at) + 1000;
  if (!Number.isFinite(time) || Math.abs(time) > 8640000000000000) return null;
  return {timestamp:new Date(time).toISOString(),time,origin:'captured_plus_1s'};
}

function normalizeSourceTimestamp(message) {
  const resolved = resolveSourceTimestamp(message);
  if (!resolved) throw Object.assign(Error('Source timestamp, Discord snowflake and capture time are unavailable'),
    {code:'SOURCE_TIMESTAMP_UNAVAILABLE'});
  if (resolved.origin === 'source') return message;
  return {...message,source_timestamp:resolved.timestamp,source_timestamp_origin:resolved.origin};
}

module.exports = {resolveSourceTimestamp,normalizeSourceTimestamp};

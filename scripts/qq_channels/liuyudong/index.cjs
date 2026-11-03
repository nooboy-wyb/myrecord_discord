const fs = require('node:fs');
const channelId = '1222944235691708477';
const settleMs = 90_000;

function images(message) {
  return JSON.parse(message.attachments_json).filter(item => item?.source_url);
}

function readyForLive(message, sourceTime, now = Date.now()) {
  if (now - sourceTime(message) < settleMs) return false;
  const originals = images(message);
  const body = String(message.body_raw || '');
  const required = /(?:图[二2]|第[二2]张)/u.test(body) ? 2
    : /(?:图[一1]|第[一1]张)/u.test(body) ? 1 : 0;
  if (originals.length < required) return false;
  return originals.every(item => message.attachments.some(file =>
    file.source_url === item.source_url && file.status === 'saved' && file.local_path
    && fs.existsSync(file.local_path) && /\.(png|jpe?g)$/i.test(file.local_path)
    && fs.statSync(file.local_path).size <= 5_000_000));
}

function displayBody(message, images) {
  const body = String(message.body_raw || '');
  if (/^no text$/i.test(body.trim())) {
    return images.length ? '' : '（原图未采到，待核对）';
  }
  return body;
}

function acceptsPrimary(control, message, sourceTime) {
  const enabledAt = Date.parse(control.primary_channel_enabled_at?.[channelId] || '');
  return !Number.isFinite(enabledAt) || sourceTime(message) >= enabledAt;
}

module.exports = {channelId, displayBody, acceptsPrimary, images, readyForLive};

const topicLabels = new Map([
  ['telegram:-1004472038576:13613', 'Yekoi盘中状态更新'],
]);

const forwardingDisabled = new Set([
  'telegram:-1003432435785:all',
]);

function labelFor(channelId, fallback) {
  return topicLabels.get(String(channelId)) || fallback;
}

function forwardingEnabled(channelId) {
  return !forwardingDisabled.has(String(channelId));
}

module.exports = {forwardingEnabled, labelFor, topicLabels};

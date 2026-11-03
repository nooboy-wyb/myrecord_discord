// QQ presentation only. Discord capture and archived channel names stay unchanged.
const markers = new Map([
  ['1222944235691708477', '🟢'], // 柳玉东
  ['1224358019056271442', '🔵'], // 利润医生
]);

function decorateChannelLabel(channelId, label) {
  const marker = markers.get(String(channelId));
  return marker ? `${marker}${label}` : label;
}

module.exports = {decorateChannelLabel};

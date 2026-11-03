// QQ presentation only. Discord capture and archived channel names stay unchanged.
const markers = new Map([
  ['1222944235691708477', '🟢'], // 柳玉东
  ['1224358019056271442', '🔵'], // 利润医生
  ['1254782508793593947', '🟢'], // 颜驰
  ['1296438667438719028', '🟢'], // 颜驰 饭碗警报
  ['1439232860014907412', '🟢'], // 颜驰 视频解说
  ['1405206823727796408', '🔵'], // 风寻
]);

function decorateChannelLabel(channelId, label) {
  const marker = markers.get(String(channelId));
  return marker ? `${marker}${label}` : label;
}

module.exports = {decorateChannelLabel};

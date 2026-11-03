const channels = document.getElementById('channels');
const token = document.getElementById('token');
const status = document.getElementById('status');
chrome.storage.local.get(['allowedChannels', 'channelLabels', 'token'], data => {
  channels.value = (data.allowedChannels || []).map(id =>
    data.channelLabels?.[id] ? `${data.channelLabels[id]} | ${id}` : id).join('\n');
  token.value = data.token || '';
});
document.getElementById('save').onclick = async () => {
  const entries = channels.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const parsed = entries.map(line => {
    const separator = line.indexOf('|');
    const label = separator < 0 ? '' : line.slice(0, separator).trim();
    const value = separator < 0 ? line : line.slice(separator + 1).trim();
    const id = value.match(/(?:discord\.com\/channels\/(?:\d+|@me)\/)?(\d+)\/?$/)?.[1];
    return {id, label};
  });
  if (parsed.some(x => !x.id || x.label.length > 40)) { status.textContent = '频道格式不正确或名称超过 40 字'; return; }
  const labels = Object.fromEntries(parsed.filter(x => x.label).map(x => [x.id, x.label]));
  await chrome.storage.local.set({allowedChannels: [...new Set(parsed.map(x => x.id))], channelLabels: labels, token: token.value.trim()});
  status.textContent = '已保存。请刷新 Discord 频道页面。';
};

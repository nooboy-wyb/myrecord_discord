const crypto = require('node:crypto');

// Signed download addresses are transport details, not new Discord content.
// Restrict this rule to Discord originals; other hosts and query options matter.
function attachmentIdentityUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname)
      || !url.pathname.startsWith('/attachments/')) return value;
    url.hostname = 'cdn.discordapp.com';
    for (const key of ['ex','is','hm']) url.searchParams.delete(key);
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  } catch { return value; }
}

function discordContentIdentity(message) {
  // Telegram owns its content identity. Incomplete administrative/test records
  // without a Discord payload retain their existing identity too.
  if (String(message.source_message_id || '').startsWith('telegram:')) return message.content_sha256;
  const attachments = typeof message.attachments_json === 'string'
    ? JSON.parse(message.attachments_json) : message.attachments;
  if (typeof message.body_raw !== 'string' || !Array.isArray(attachments)) return message.content_sha256;
  const normalized = attachments.map(item => item && typeof item === 'object'
    ? Object.fromEntries(Object.entries({...item,source_url:attachmentIdentityUrl(item.source_url)})
      .sort(([a],[b]) => a.localeCompare(b))) : item);
  return crypto.createHash('sha256').update(JSON.stringify([message.body_raw,normalized])).digest('hex');
}

function mergeDiscordSnapshot(previous, current) {
  const files = [...(previous.attachments || []),...(current.attachments || [])];
  const attachments = (current.attachments || []).map(item => {
    const saved = files.find(file => attachmentIdentityUrl(file.source_url) === attachmentIdentityUrl(item.source_url)
      && file.status === 'saved' && file.local_path);
    return saved ? {...saved,source_url:item.source_url} : item;
  });
  // Keep the original task/part keys so acknowledged text and images cannot
  // become eligible again when the usable download address is refreshed.
  return {...current,content_sha256:previous.content_sha256,attachments};
}

module.exports = {attachmentIdentityUrl,discordContentIdentity,mergeDiscordSnapshot};

const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {archivedMessage} = require('../../telegram/send_qq_history.cjs');
const yekoi = require('../../qq_channels/yekoi/index.cjs');

function readSources(root) {
  const file = path.join(root,'telegram','sources.json');
  if (!fs.existsSync(file)) return [];
  const config = JSON.parse(fs.readFileSync(file,'utf8'));
  if (!Array.isArray(config.sources)) throw Error('Invalid Telegram sources configuration');
  const sources = config.sources.filter(source => source.enabled === true);
  const keys = new Set();
  for (const source of sources) {
    const key = `${source.peer_id}:${source.topic_id || 'all'}`;
    if (!/^-\d+$/.test(source.peer_id || '') || !source.target
      || (source.topic_id != null && (!Number.isSafeInteger(source.topic_id) || source.topic_id < 1 || !source.topic_title))
      || !/([zZ]|[+-]\d{2}:\d{2})$/.test(source.enabled_at || '') || !Number.isFinite(Date.parse(source.enabled_at))
      || keys.has(key)) throw Error('Invalid or duplicate Telegram source');
    keys.add(key);
  }
  if (sources.some(source => source.topic_id != null && keys.has(`${source.peer_id}:all`))) {
    throw Error('Telegram whole-peer and topic subscriptions overlap');
  }
  return sources;
}

function telegramTarget(routes,primary,source) {
  const targets = routes.filter(route => route.name === source.target);
  if (targets.length !== 1) return null;
  const target = targets[0];
  return /^[A-Za-z0-9]+$/.test(target.group_openid || '') && target.group_openid !== primary.group_openid
    && Array.isArray(target.channel_ids)
    && (!target.channel_ids.length || target.allow_mixed_sources === true
      && target.channel_ids.every(id => typeof id === 'string' && /^\d{15,22}$/.test(id))
      && new Set(target.channel_ids).size === target.channel_ids.length)
    && Number.isFinite(Date.parse(target.enabled_at || '')) ? target : null;
}

function planTelegram(root,enqueue,terminal = () => false) {
  const sources = readSources(root);
  if (!sources.length) return {enabled:0,queued:0,blocked:[]};
  const routes = JSON.parse(fs.readFileSync(path.join(root,'qq-additional-routes.json'),'utf8')).routes;
  const primary = JSON.parse(fs.readFileSync(path.join(root,'qq-group-openid.json'),'utf8'));
  const file = path.join(root,'telegram','archive.sqlite');
  if (!fs.existsSync(file)) return {enabled:sources.length,queued:0,blocked:[{error:'Telegram archive not created'}]};
  const archive = new DatabaseSync(file,{readOnly:true});
  archive.exec('PRAGMA busy_timeout=5000');
  const status = {enabled:sources.length,queued:0,blocked:[]};
  try {
    for (const source of sources) {
      const channelId = `telegram:${source.peer_id}:${source.topic_id || 'all'}`;
      if (!yekoi.forwardingEnabled(channelId)) continue;
      const target = telegramTarget(routes,primary,source);
      if (!target) {
        status.blocked.push({peer_id:source.peer_id,error:'Telegram target is invalid, ambiguous or mixed sources are not enabled'});
        continue;
      }
      const rows = archive.prepare(`SELECT * FROM telegram_messages m WHERE peer_id=? AND julianday(source_timestamp)>=julianday(?)
        AND id=(SELECT MAX(id) FROM telegram_messages other WHERE other.peer_id=m.peer_id AND other.message_id=m.message_id)
        ORDER BY source_timestamp,id`).all(source.peer_id,source.enabled_at);
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload_json);
          if (source.topic_id != null && payload.topic_id !== String(source.topic_id)) continue;
          const context = {group_openid:target.group_openid,telegram:true};
          if (terminal({channel_id:`telegram:${source.peer_id}:${source.topic_id || 'all'}`,
            source_message_id:`telegram:${source.peer_id}:${row.message_id}`,content_sha256:row.content_sha256},context)) continue;
          const message = archivedMessage(archive,{peer_id:source.peer_id,topic_id:source.topic_id || null,
            channel_name:row.channel_name,topic_title:source.topic_id == null ? null : source.topic_title},
          {...payload,row_id:row.id,content_sha256:row.content_sha256,verification_errors:[]});
          enqueue(message,context);
          status.queued++;
        } catch (error) {
          status.blocked.push({peer_id:source.peer_id,message_id:row.message_id,error:error.message});
        }
      }
    }
  } finally { archive.close(); }
  return status;
}

function telegramAllowed(root,message,context) {
  if (!yekoi.forwardingEnabled(message.channel_id)) return false;
  const routes = JSON.parse(fs.readFileSync(path.join(root,'qq-additional-routes.json'),'utf8')).routes;
  const primary = JSON.parse(fs.readFileSync(path.join(root,'qq-group-openid.json'),'utf8'));
  return readSources(root).some(source => message.channel_id === `telegram:${source.peer_id}:${source.topic_id || 'all'}`
    && Date.parse(message.source_timestamp) >= Date.parse(source.enabled_at)
    && telegramTarget(routes,primary,source)?.group_openid === context.group_openid);
}
module.exports = {planTelegram,telegramAllowed,readSources};

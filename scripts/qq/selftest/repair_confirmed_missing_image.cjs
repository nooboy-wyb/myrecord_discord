const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const forwarder = require('../core/forwarder.cjs');

const sourceId = process.argv[2];
const groupNumber = process.argv[3];
if (!/^\d{15,22}$/.test(sourceId || '') || !/^\d+$/.test(groupNumber || '')
  || !process.argv.includes('--confirmed-missing')) {
  throw Error('Usage: node repair_confirmed_missing_image.cjs <Discord ID> <QQ group number> --confirmed-missing');
}
if (!process.env.QQ_BOT_APP_SECRET) throw Error('QQ_BOT_APP_SECRET is required');

const root = path.resolve(__dirname, '../../..', 'data');
const route = JSON.parse(fs.readFileSync(path.join(root, 'qq-additional-routes.json'), 'utf8')).routes
  .find(item => item.qq_group_number === groupNumber);
if (!route?.group_openid || route.channel_ids.length !== 1) throw Error('Expected one bound single-channel route');
const groupOpenid = route.group_openid;
const channelId = route.channel_ids[0];
const state = new DatabaseSync(path.join(root, 'qq-forward.sqlite'));

async function main() {
  try {
    let selected;
    for (const day of fs.readdirSync(root).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort()) {
      const file = path.join(root, day, 'messages.sqlite');
      if (!fs.existsSync(file)) continue;
      const db = new DatabaseSync(file, {readOnly:true});
      try {
        for (const message of db.prepare(`SELECT id,channel_id,channel_name,author_display,source_message_id,
          source_timestamp,content_sha256,body_raw,attachments_json,captured_at
          FROM discord_web_messages WHERE channel_id=? AND source_message_id=? ORDER BY captured_at DESC,id DESC`)
          .all(channelId,sourceId)) {
          message.attachments = db.prepare(`SELECT source_url,local_path,status,error
            FROM discord_web_attachment_files WHERE message_id=?`).all(message.id);
          const images = JSON.parse(message.attachments_json).filter(item => item?.source_url);
          if (images.length !== 1 || message.attachments.length !== 1) continue;
          const saved = message.attachments[0];
          if (saved.source_url !== images[0].source_url || saved.status !== 'saved'
            || !saved.local_path || !fs.existsSync(saved.local_path)) continue;
          selected = message;
          break;
        }
      } finally { db.close(); }
      if (selected) break;
    }
    if (!selected) throw Error('One saved original image was not found');
    const originalKey = crypto.createHash('sha256').update(JSON.stringify([
      groupOpenid,channelId,sourceId,selected.content_sha256
    ])).digest('hex');
    const attempts = state.prepare(`SELECT task_key,part_index,part_type,status,origin
      FROM forward_attempts WHERE group_openid=? AND source_message_id=?`).all(groupOpenid,sourceId);
    if (attempts.length !== 2
      || !attempts.some(row => row.task_key === originalKey && row.part_index === 0
        && row.part_type === 'text' && row.status === 'accepted' && row.origin === 'live')
      || !attempts.some(row => row.task_key === originalKey && row.part_index === 1
        && row.part_type === 'image' && row.status === 'unknown' && row.origin === 'live')) {
      throw Error('Expected exactly one accepted text and one unknown image, with no prior repair');
    }
    if (process.argv.includes('--dry-run')) {
      console.log(`Discord ${sourceId}: one saved image, accepted text, unknown image, no prior repair; ready for group ${groupNumber}.`);
      return;
    }
    selected.content_sha256 = crypto.createHash('sha256')
      .update(`${selected.content_sha256}:image-confirmed-missing`).digest('hex');
    const outcome = await forwarder.processMessage(selected,{
      group_openid:groupOpenid,imageRepair:true,imageOnlyRepair:true
    });
    if (outcome !== 'accepted') throw Error(`Image repair status: ${outcome}`);
    const key = `live_watermark:${groupOpenid}:${channelId}`;
    const stored = state.prepare('SELECT value FROM forward_meta WHERE key=?').get(key);
    const watermark = stored ? JSON.parse(stored.value) : null;
    if (forwarder.isAfterLiveWatermark(selected,watermark)) {
      const value = JSON.stringify({source_message_id:sourceId,source_timestamp:selected.source_timestamp});
      state.prepare(`INSERT INTO forward_meta(key,value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key,value);
    }
    console.log(`Discord ${sourceId}: missing image repair accepted by QQ API; verify delivery in group ${groupNumber}.`);
  } finally { state.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

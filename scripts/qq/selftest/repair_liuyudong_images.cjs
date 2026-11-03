const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const liuyudong = require('../../qq_channels/liuyudong/index.cjs');
const forwarder = require('../core/forwarder.cjs');

const sourceId = process.argv[2];
const secondConfirmedMissing = process.argv.includes('--second-confirmed-missing');
const wholeConfirmedMissing = process.argv.includes('--whole-confirmed-missing');
if (secondConfirmedMissing && wholeConfirmedMissing) throw Error('Choose one repair mode');
if (!/^\d+$/.test(sourceId || '')) throw Error('Usage: node repair_liuyudong_images.cjs <Discord message ID>');
if (!process.env.QQ_BOT_APP_SECRET) throw Error('QQ_BOT_APP_SECRET is required');
const dataDir = path.resolve(__dirname, '..', '..', '..', 'data');
const groupOpenid = JSON.parse(fs.readFileSync(path.join(dataDir, 'qq-group-openid.json'), 'utf8')).group_openid;
const state = new DatabaseSync(path.join(dataDir, 'qq-forward.sqlite'));
let selected;
try {
  for (const day of fs.readdirSync(dataDir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort()) {
    const file = path.join(dataDir, day, 'messages.sqlite');
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, {readOnly:true});
    try {
      const versions = db.prepare(`SELECT id,channel_id,channel_name,author_display,source_message_id,
        source_timestamp,content_sha256,body_raw,attachments_json,captured_at
        FROM discord_web_messages WHERE channel_id=? AND source_message_id=? ORDER BY captured_at,id`)
        .all(liuyudong.channelId, sourceId);
      for (const message of versions) {
        message.attachments = db.prepare('SELECT source_url,local_path,status,error FROM discord_web_attachment_files WHERE message_id=?').all(message.id);
        if (!liuyudong.readyForLive(message, value => Date.parse(value.source_timestamp))) continue;
        selected = message;
        break;
      }
    } finally { db.close(); }
    if (selected) break;
  }
  if (!selected) throw Error('No complete saved version found');
  const key = crypto.createHash('sha256').update(JSON.stringify([
    groupOpenid, selected.channel_id, selected.source_message_id, selected.content_sha256
  ])).digest('hex');
  if (wholeConfirmedMissing) {
    const attempts = state.prepare(`SELECT task_key,part_index,status FROM forward_attempts
      WHERE group_openid=? AND source_message_id=?`).all(groupOpenid,sourceId);
    if (attempts.length !== 1 || attempts[0].task_key !== key ||
        attempts[0].part_index !== 0 || attempts[0].status !== 'unknown') {
      throw Error('Expected exactly one unknown first-part attempt and no accepted parts');
    }
    selected.content_sha256 = crypto.createHash('sha256')
      .update(`${selected.content_sha256}:whole-confirmed-missing`).digest('hex');
    console.log(`用户确认整条未收到；补发 Discord ${sourceId} 的正文及 ${liuyudong.images(selected).length} 张原图。`);
  } else if (secondConfirmedMissing) {
    const first = state.prepare('SELECT status FROM forward_attempts WHERE task_key=? AND part_index=0').get(key);
    const second = state.prepare('SELECT status FROM forward_attempts WHERE task_key=? AND part_index=1').get(key);
    if (first?.status !== 'accepted' || second?.status !== 'unknown') {
      throw Error('Expected accepted first image and unknown second image before confirmed-missing repair');
    }
    const secondImage = liuyudong.images(selected)[1];
    const secondFile = selected.attachments.find(file => file.source_url === secondImage.source_url);
    if (!secondFile || secondFile.status !== 'saved') throw Error('Second original image is unavailable');
    selected.attachments_json = JSON.stringify([secondImage]);
    selected.attachments = [secondFile];
    selected.content_sha256 = crypto.createHash('sha256')
      .update(`${selected.content_sha256}:second-confirmed-missing`).digest('hex');
    console.log(`用户确认第二张未收到；仅补发 Discord ${sourceId} 的图 2/2。`);
  } else {
    const otherImages = state.prepare(`SELECT task_key,status FROM forward_attempts
      WHERE group_openid=? AND source_message_id=? AND part_type='image' AND task_key<>?`)
      .all(groupOpenid,sourceId,key);
    if (otherImages.length) throw Error('Other image attempts exist for this message; inspect before repairing');
    const priorText = state.prepare(`SELECT 1 FROM forward_attempts WHERE group_openid=? AND source_message_id=?
      AND part_type='text' AND status='accepted' LIMIT 1`).get(groupOpenid,sourceId);
    if (!priorText) throw Error('Original text was not accepted; refusing image-only repair');
    console.log(`补图来源：Discord ${sourceId}，本地记录 ${selected.id}，两张原图已保存。`);
  }
  forwarder.processMessage(selected,{group_openid:groupOpenid,imageRepair:!wholeConfirmedMissing,
    confirmedRetry:wholeConfirmedMissing,
    imageRepairPart:secondConfirmedMissing ? '2/2' : undefined}).then(outcome => {
    if (outcome !== 'accepted') throw Error(`Image repair status: ${outcome}`);
    console.log(wholeConfirmedMissing ? '整条补发已获 QQ 接口接受；请核对手机端实际收到。'
      : secondConfirmedMissing ? '第二张补图已获 QQ 接口接受；请核对手机端实际收到。'
      : '两张补图已获 QQ 接口接受；请核对手机端实际收到。');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { state.close(); }

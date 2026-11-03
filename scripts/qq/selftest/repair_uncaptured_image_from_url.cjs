const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const forwarder = require('../core/forwarder.cjs');

const [sourceId, groupNumber, suppliedUrl] = process.argv.slice(2);
const dryRun = process.argv.includes('--dry-run');
if (!/^\d{15,22}$/.test(sourceId || '') || !/^\d+$/.test(groupNumber || '') || !suppliedUrl)
  throw Error('Usage: node repair_uncaptured_image_from_url.cjs <Discord ID> <QQ group number> <image URL> [--dry-run]');
if (!dryRun && !process.env.QQ_BOT_APP_SECRET) throw Error('QQ_BOT_APP_SECRET is required');

const root = path.resolve(__dirname,'../../..','data');
const route = JSON.parse(fs.readFileSync(path.join(root,'qq-additional-routes.json'),'utf8')).routes
  .find(item => item.qq_group_number === groupNumber);
if (!route?.group_openid || route.channel_ids.length !== 1) throw Error('Expected one bound single-channel route');
const channelId = route.channel_ids[0];
const url = new URL(suppliedUrl);
if (url.protocol !== 'https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname)
  || !url.pathname.startsWith(`/attachments/${channelId}/`)
  || !/\.(?:png|jpe?g)$/i.test(url.pathname)) throw Error('Image URL is not a matching Discord attachment');
url.hostname = 'cdn.discordapp.com';
for (const key of [...url.searchParams.keys()]) if (!['ex','is','hm'].includes(key)) url.searchParams.delete(key);
url.search = url.searchParams.toString();
url.hash = '';
const sourceUrl = url.href;

const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'})
  .format(new Date(Number((BigInt(sourceId) >> 22n) + 1420070400000n)));
const folder = path.join(root,day);
const db = new DatabaseSync(path.join(folder,'messages.sqlite'));
const state = new DatabaseSync(path.join(root,'qq-forward.sqlite'),{readOnly:true});

async function main() {
  try {
    const rows = db.prepare(`SELECT * FROM discord_web_messages
      WHERE channel_id=? AND source_message_id=? ORDER BY captured_at DESC`).all(channelId,sourceId);
    if (rows.length !== 1 || JSON.parse(rows[0].attachments_json).length !== 0)
      throw Error('Expected exactly one text-only archived message');
    const original = rows[0];
    const attempts = state.prepare(`SELECT part_type,status,origin FROM forward_attempts
      WHERE group_openid=? AND channel_id=? AND source_message_id=?`).all(route.group_openid,channelId,sourceId);
    if (attempts.length !== 1 || attempts[0].part_type !== 'text'
      || attempts[0].status !== 'accepted' || attempts[0].origin !== 'live')
      throw Error('Expected exactly one accepted live text part and no previous image repair');

    const response = await fetch(sourceUrl,{signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error(`Original image HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const extension = path.extname(url.pathname).toLowerCase();
    const png = extension === '.png' && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
    const jpeg = ['.jpg','.jpeg'].includes(extension) && bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex'));
    if ((!png && !jpeg) || bytes.length < 100 || bytes.length > 5_000_000)
      throw Error('Original image format or size is not suitable for QQ direct upload');
    if (dryRun) {
      console.log(`Discord ${sourceId}: text accepted, original ${extension} available (${bytes.length} bytes), no previous repair; ready for group ${groupNumber}.`);
      return;
    }

    const attachment = {kind:'image',source_url:sourceUrl};
    const attachmentsJson = JSON.stringify([attachment]);
    const digest = crypto.createHash('sha256').update(JSON.stringify([original.body_raw,[attachment]])).digest('hex');
    const imageDir = path.join(folder,'attachments');
    fs.mkdirSync(imageDir,{recursive:true});
    const fileDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    const localPath = path.join(imageDir,fileDigest + extension);
    if (!fs.existsSync(localPath)) fs.writeFileSync(localPath,bytes);
    const payload = {...JSON.parse(original.payload_json),attachments:[attachment],body_kind:'text_and_image'};
    db.exec('BEGIN IMMEDIATE');
    let newId;
    try {
      const inserted = db.prepare(`INSERT INTO discord_web_messages
        (channel_id,source_message_id,guild_id,channel_name,message_url,author_display,
         displayed_time,source_timestamp,captured_at,body_raw,attachments_json,payload_json,
         content_sha256,body_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        original.channel_id,sourceId,original.guild_id,original.channel_name,original.message_url,
        original.author_display,original.displayed_time,original.source_timestamp,new Date().toISOString(),
        original.body_raw,attachmentsJson,JSON.stringify(payload),digest,'text_and_image');
      newId = Number(inserted.lastInsertRowid);
      db.prepare(`INSERT INTO discord_web_attachment_files
        (message_id,source_url,local_path,sha256,status,error,updated_at) VALUES (?,?,?,?,?,?,?)`).run(
        newId,sourceUrl,localPath,fileDigest,'saved',null,new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }

    const message = {...original,id:newId,attachments_json:attachmentsJson,content_sha256:digest,
      attachments:[{source_url:sourceUrl,local_path:localPath,status:'saved',error:null}]};
    const outcome = await forwarder.processMessage(message,{group_openid:route.group_openid,
      imageRepair:true,imageOnlyRepair:true});
    if (outcome !== 'accepted') throw Error(`Image repair status: ${outcome}`);
    console.log(`Discord ${sourceId}: original image archived and image-only repair accepted by QQ API for group ${groupNumber}.`);
  } finally { state.close(); db.close(); }
}
main().catch(error => {console.error(error.message);process.exitCode=1;});

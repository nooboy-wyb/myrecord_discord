const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {acquireLock} = require('../qq/core/process_lock.cjs');

const data = path.resolve(process.env.MUSE_DATA_DIR || path.resolve(__dirname, '..', '..', 'data'));

async function main() {
  const [name, peerId, topicId, messageId, mode] = process.argv.slice(2);
  if (!name || !/^-\d+$/.test(peerId || '') || !/^\d+$/.test(topicId || '')
    || !/^\d+$/.test(messageId || '') || !['--preview', '--send'].includes(mode)) {
    throw Error('Usage: node send_qq_sample.cjs NAME PEER_ID TOPIC_ID MESSAGE_ID --preview|--send');
  }
  const routes = JSON.parse(fs.readFileSync(path.join(data, 'qq-additional-routes.json'), 'utf8')).routes;
  const matches = routes.filter(route => route.name === name);
  if (matches.length !== 1) throw Error('Expected one named QQ target');
  const route = matches[0];
  const primary = JSON.parse(fs.readFileSync(path.join(data, 'qq-group-openid.json'), 'utf8'));
  if (!/^[A-Za-z0-9]+$/.test(route.group_openid || '') || route.group_openid === primary.group_openid
    || !Number.isFinite(Date.parse(route.enabled_at || ''))
    || !Array.isArray(route.channel_ids) || route.channel_ids.length) {
    throw Error('Target must be bound and have no Discord channel routes');
  }
  const auditPath = path.join(data, 'telegram', 'audits', `history${peerId}-${topicId}-latest-success.json`);
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  if (audit.status !== 'passed' || !audit.scan_complete_to_boundary || audit.peer_id !== peerId
    || String(audit.topic_id) !== topicId || audit.errors.length) throw Error('Successful topic audit required');
  const verified = audit.messages.filter(message => message.message_id === messageId);
  if (verified.length !== 1 || verified[0].verification_errors.length) throw Error('Message missing from successful audit');
  const archive = new DatabaseSync(path.join(data, 'telegram', 'archive.sqlite'), {readOnly:true});
  let row;
  try {
    row = archive.prepare('SELECT * FROM telegram_messages WHERE id=?').get(verified[0].row_id);
    if (!row || row.peer_id !== peerId || row.message_id !== messageId
      || row.content_sha256 !== verified[0].content_sha256 || row.body_raw !== verified[0].body_raw
      || row.source_timestamp !== verified[0].source_timestamp) throw Error('Archive differs from audited source');
    const payload = JSON.parse(row.payload_json);
    if (String(payload.topic_id) !== topicId || payload.body_raw !== row.body_raw
      || payload.attachments.length || verified[0].attachments.length
      || archive.prepare('SELECT 1 FROM telegram_attachments WHERE message_row_id=?').get(row.id)) {
      throw Error('This sample supports audited text without attachments only');
    }
  } finally { archive.close(); }
  const message = {
    channel_id:`telegram:${peerId}:${topicId}`,
    source_message_id:`telegram:${peerId}:${messageId}`,
    channel_name:`${row.channel_name}｜${audit.topic_title}`,
    source_timestamp:row.source_timestamp, content_sha256:row.content_sha256,
    body_raw:row.body_raw, attachments_json:'[]', attachments:[]
  };
  const forwarder = require('../qq/core/forwarder.cjs');
  const content = `${forwarder.messageHeading(message, {history:true})}\n${row.body_raw}`;
  if ([...content].length > 1400 || !row.body_raw.trim()) throw Error('Sample must fit in one text message');
  if (mode === '--preview') {
    console.log(JSON.stringify({mode, target:name, qq_group_number:route.qq_group_number,
      group_openid:route.group_openid, audit_run_id:audit.run_id, content}));
    return;
  }
  if (!process.env.QQ_BOT_APP_SECRET) throw Error('Load encrypted bot credentials before sending');
  const release = acquireLock(path.join(data,'qq-sender.lock'));
  const state = new DatabaseSync(path.join(data, 'qq-forward.sqlite'));
  try {
    const previous = state.prepare(`SELECT status,platform_message_id FROM forward_attempts
      WHERE group_openid=? AND source_message_id=?`).all(route.group_openid, message.source_message_id);
    if (previous.length) throw Error(`Sample already attempted; inspect saved result: ${JSON.stringify(previous)}`);
    const latest = state.prepare('SELECT MAX(attempted_at) AS at FROM forward_attempts WHERE group_openid=?')
      .get(route.group_openid);
    const wait = Math.max(0, Date.parse(latest.at || '') + 2000 - Date.now());
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    const outcome = await forwarder.processMessage(message, {group_openid:route.group_openid, history:true});
    const attempts = state.prepare(`SELECT status,platform_message_id,attempted_at,error FROM forward_attempts
      WHERE group_openid=? AND source_message_id=?`).all(route.group_openid, message.source_message_id);
    console.log(JSON.stringify({target:name, peer_id:peerId, topic_id:topicId, message_id:messageId,
      audit_run_id:audit.run_id, outcome, attempts}));
    if (outcome !== 'accepted' || attempts.length !== 1 || attempts[0].status !== 'accepted'
      || !attempts[0].platform_message_id) throw Error('Sample was not confirmed accepted; do not retry automatically');
  } finally {
    state.close();
    release();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

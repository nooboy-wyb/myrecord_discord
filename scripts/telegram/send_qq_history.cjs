const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {acquireLock} = require('../qq/core/process_lock.cjs');

const data = path.resolve(process.env.MUSE_DATA_DIR || path.resolve(__dirname, '..', '..', 'data'));

function archivedMessage(archive, audit, expected) {
  const row = archive.prepare('SELECT * FROM telegram_messages WHERE id=?').get(expected.row_id);
  if (!row || expected.verification_errors.length || row.peer_id !== audit.peer_id
    || row.message_id !== expected.message_id || row.channel_name !== audit.channel_name
    || ['body_raw', 'source_timestamp', 'content_sha256', 'edit_timestamp', 'grouped_id']
      .some(field => row[field] !== expected[field])) throw Error('Archive differs from verified audit');
  const payload = JSON.parse(row.payload_json);
  if ((audit.topic_id != null && payload.topic_id !== String(audit.topic_id))
    || (Object.hasOwn(expected,'topic_id') && payload.topic_id !== expected.topic_id)
    || payload.body_raw !== row.body_raw || payload.source_timestamp !== row.source_timestamp
    || JSON.stringify(payload.attachments) !== JSON.stringify(expected.attachments)) {
    throw Error('Archive payload differs from verified audit');
  }
  const saved = archive.prepare('SELECT * FROM telegram_attachments WHERE message_row_id=? ORDER BY id').all(row.id);
  if (saved.length !== expected.attachments.length) throw Error('Attachment count differs from audit');
  const attachments = expected.attachments.map(item => {
    const file = saved.find(entry => entry.media_id === item.media_id);
    if (item.kind !== 'image' || !file || file.kind !== 'image' || file.status !== 'saved'
      || !file.local_path || !/\.(png|jpe?g)$/i.test(file.local_path)) throw Error('Unsupported or missing image');
    const bytes = fs.readFileSync(file.local_path);
    if (bytes.length > 5_000_000 || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw Error('Image size or SHA-256 validation failed');
    }
    return {...file, source_url:`telegram://${row.peer_id}/${row.message_id}/${item.media_id}`};
  });
  if (!row.body_raw.trim() && !attachments.length) throw Error('Empty source message');
  return {
    channel_id:`telegram:${row.peer_id}:${audit.topic_id || 'all'}`,
    source_message_id:`telegram:${row.peer_id}:${row.message_id}`,
    channel_name:`${row.channel_name}${audit.topic_title ? `｜${audit.topic_title}` : ''}`,
    source_timestamp:row.source_timestamp, content_sha256:row.content_sha256, body_raw:row.body_raw,
    attachments_json:JSON.stringify(attachments.map(item => ({source_url:item.source_url}))), attachments
  };
}

function previousStatus(attempts, key, parts) {
  if (!attempts.length) return 'pending';
  if (attempts.length === parts.length && parts.every((part, index) => attempts.some(attempt =>
    attempt.task_key === key && attempt.part_index === index && attempt.part_type === part.type
    && attempt.status === 'accepted' && attempt.platform_message_id))) return 'already_accepted';
  throw Error('Existing incomplete, changed, or uncertain attempt; inspect before retrying');
}

function saveReport(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

async function main() {
  const [name, manifestName, mode, ...selectors] = process.argv.slice(2);
  if (!name || path.basename(manifestName || '') !== manifestName || !manifestName.endsWith('.json')
    || !['--preview', '--send'].includes(mode) || !selectors.length
    || new Set(selectors).size !== selectors.length
    || selectors.some(selector => !/^-\d+:(all|[1-9]\d*)$/.test(selector))) {
    throw Error('Usage: node send_qq_history.cjs TARGET MANIFEST.json --preview|--send PEER:all|TOPIC ...');
  }
  const directory = path.join(data, 'telegram', 'audits');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, manifestName), 'utf8'));
  if (!manifest.repeat_passed) throw Error('Repeated archive verification required');
  const routes = JSON.parse(fs.readFileSync(path.join(data, 'qq-additional-routes.json'), 'utf8')).routes;
  const targets = routes.filter(route => route.name === name);
  const primary = JSON.parse(fs.readFileSync(path.join(data, 'qq-group-openid.json'), 'utf8'));
  if (targets.length !== 1) throw Error('Expected exactly one named target');
  const target = targets[0];
  if (!/^[A-Za-z0-9]+$/.test(target.group_openid || '') || target.group_openid === primary.group_openid
    || !Number.isFinite(Date.parse(target.enabled_at || '')) || !Array.isArray(target.channel_ids)
    || target.channel_ids.length) throw Error('Expected a bound Telegram-only target');
  const forwarder = require('../qq/core/forwarder.cjs');
  const archive = new DatabaseSync(path.join(data, 'telegram', 'archive.sqlite'), {readOnly:true});
  const state = new DatabaseSync(path.join(data, 'qq-forward.sqlite'));
  state.exec('PRAGMA busy_timeout=15000');
  let release;
  const lockPath = path.join(data, 'qq-sender.lock');
  try {
    if (mode === '--send') {
      if (!process.env.QQ_BOT_APP_SECRET) throw Error('Load encrypted QQ credentials before sending');
      release = acquireLock(lockPath);
    }
    const plan = [];
    for (const selector of selectors) {
      const sources = manifest.sources.filter(source => `${source.peer_id}:${source.topic_id || 'all'}` === selector);
      if (sources.length !== 1) throw Error('Selected source missing from manifest');
      const source = sources[0];
      if (source.status !== 'passed' || source.repeat?.status !== 'passed' || !source.repeat.same_as_previous_scan) {
        throw Error('Selected source audit did not pass');
      }
      const audit = JSON.parse(fs.readFileSync(path.join(directory, path.basename(source.repeat.audit_file)), 'utf8'));
      if (audit.status !== 'passed' || !audit.scan_complete_to_boundary || audit.errors.length
        || audit.peer_id !== source.peer_id || audit.topic_id !== source.topic_id
        || audit.until !== manifest.until || audit.since !== source.since
        || audit.read !== source.read || audit.verified !== audit.read || audit.messages.length !== audit.read
        || JSON.stringify(audit.messages.map(item => item.message_id)) !== JSON.stringify(source.message_ids)) {
        throw Error('Source audit does not match selected manifest');
      }
      for (const expected of audit.messages) {
        const message = archivedMessage(archive, audit, expected);
        const heading = forwarder.messageHeading(message, {history:true});
        const parts = forwarder.buildParts(message.channel_id, heading, message.body_raw, JSON.parse(message.attachments_json));
        const key = crypto.createHash('sha256').update(JSON.stringify([
          target.group_openid, message.channel_id, message.source_message_id, message.content_sha256
        ])).digest('hex');
        const attempts = state.prepare('SELECT * FROM forward_attempts WHERE group_openid=? AND source_message_id=?')
          .all(target.group_openid, message.source_message_id);
        plan.push({message, heading, parts, audit_run_id:audit.run_id,
          status:previousStatus(attempts, key, parts), attempts});
      }
    }
    plan.sort((first, second) => Date.parse(first.message.source_timestamp) - Date.parse(second.message.source_timestamp)
      || first.message.source_message_id.localeCompare(second.message.source_message_id));
    const report = {target:name, qq_group_number:target.qq_group_number, group_openid:target.group_openid,
      manifest:manifestName, selectors, started_at:new Date().toISOString(), status:mode === '--preview' ? 'preview' : 'running',
      messages:plan.map(item => ({source_message_id:item.message.source_message_id,
        channel_id:item.message.channel_id, content_sha256:item.message.content_sha256,
        heading:item.heading, parts:item.parts.length, image_parts:item.parts.filter(part => part.type === 'image').length,
        audit_run_id:item.audit_run_id, status:item.status, attempts:item.attempts}))};
    if (mode === '--preview') { console.log(JSON.stringify(report)); return; }
    const reportFile = path.join(directory, `qq-history-${Date.now()}-${crypto.randomUUID().slice(0,8)}.json`);
    saveReport(reportFile, report);
    try {
      for (const [index, item] of plan.entries()) {
        if (item.status === 'already_accepted') continue;
        const latest = state.prepare('SELECT MAX(attempted_at) AS at FROM forward_attempts WHERE group_openid=?').get(target.group_openid);
        const wait = Math.max(0, Date.parse(latest.at || '') + 2000 - Date.now());
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        const outcome = await forwarder.processMessage(item.message, {group_openid:target.group_openid, history:true});
        const attempts = state.prepare(`SELECT task_key,part_index,part_type,status,attempted_at,platform_message_id,error
          FROM forward_attempts WHERE group_openid=? AND source_message_id=? ORDER BY part_index`)
          .all(target.group_openid, item.message.source_message_id);
        report.messages[index].status = outcome;
        report.messages[index].attempts = attempts;
        saveReport(reportFile, report);
        console.log(JSON.stringify({source_message_id:item.message.source_message_id, outcome, parts:attempts.length}));
        if (outcome !== 'accepted' || attempts.length !== item.parts.length
          || attempts.some(attempt => attempt.status !== 'accepted' || !attempt.platform_message_id)) {
          throw Error('Send not fully confirmed; batch stopped without automatic retry');
        }
      }
      report.status = 'accepted';
    } catch (failure) {
      report.status = 'stopped';
      report.error = failure.message;
      throw failure;
    } finally {
      report.finished_at = new Date().toISOString();
      saveReport(reportFile, report);
      console.log(JSON.stringify({status:report.status, report_file:reportFile}));
    }
  } finally {
    archive.close();
    state.close();
    if (release) release();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {archivedMessage, previousStatus};

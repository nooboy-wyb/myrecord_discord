const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {validatePacket} = require('./monitor_handoff.cjs');

const kinds = ['opened','recovered','limited','test'];
function validateNotice(notice) {
  if (!notice || !/^telegram-[0-9a-f-]{36}$/.test(notice.id || '') || !kinds.includes(notice.kind)
      || typeof notice.content !== 'string' || notice.content.length > 1000 || !notice.content.startsWith('【TG '))
    throw Error('Invalid Telegram monitor notice');
  return notice;
}
async function sendNotice({project,root,file}) {
  try {
    const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',path.join(project,'scripts','send_monitor_notice.ps1'),'-RequestFile',file,
      '-DataDirectory',root,'-NodePath',process.execPath],{windowsHide:true,timeout:20000,maxBuffer:8192});
    return {accepted:stdout.split(/\r?\n/).some(line => line.trim() === '{"accepted":true}')};
  } catch (error) {
    const code = `${error.stdout || ''} ${error.stderr || ''}`.match(/HTTP \d{3}, code [\w-]+/)?.[0];
    return {accepted:false,error:code || (error.killed ? 'NOTICE_TRANSPORT_TIMEOUT' : 'NOTICE_TRANSPORT_FAILED')};
  }
}
const read = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function write(file,value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(value,null,2),'utf8');
  fs.renameSync(temporary,file);
}
async function notifyTelegram({project,root,report,now,append = () => {},send = sendNotice}) {
  const role = report.roles.telegram;
  if (role.paused || role.inspection_error) return {skipped:'paused_or_inspection_failed'};
  if (!fs.existsSync(path.join(root,'qq-bot-credential.xml')) || !fs.existsSync(path.join(root,'qq-alert-recipient.json')))
    return {skipped:'qq_private_alert_unconfigured'};
  const folder = path.join(root,'monitor');
  const file = path.join(folder,'telegram-notices.json');
  const state = fs.existsSync(file) ? read(file) : {entries:{}};
  const candidates = [];
  const packetFile = path.join(folder,'handoff','telegram.json');
  if (fs.existsSync(packetFile)) {
    const packet = validatePacket(read(packetFile));
    let kind;
    if (packet.status === 'OPEN' && (now-Date.parse(packet.first_seen_at) >= 60000
        || ['RESTART_LIMITED','MANUAL_REQUIRED'].includes(packet.state)))
      kind = ['RESTART_LIMITED','MANUAL_REQUIRED','START_FAILED'].includes(packet.state) ? 'limited' : 'opened';
    if (packet.status === 'RESOLVED' && state.entries[packet.id]?.opened?.accepted) kind = 'recovered';
    if (packet.status === 'RESOLVED' && state.entries[packet.id]?.limited?.accepted) kind = 'recovered';
    if (kind) candidates.push({id:packet.id,kind,content:kind === 'recovered'
      ? '【TG 采集恢复】采集进程和扫描进度已恢复正常，将按原入库断点继续补采。'
      : `【TG 采集告警】${packet.issues.map(issue => issue.code).join('、') || packet.state}。`
        +(kind === 'limited' ? '自动恢复受限或需要人工处理，请检查远端巡检日志。' : '巡检已发现异常，将按超时与重启策略处理；入库断点保留。')});
  }
  const recoveryFile = path.join(root,'telegram','connection-recovery.json');
  if (fs.existsSync(recoveryFile)) {
    const recovery = read(recoveryFile);
    if (recovery.state === 'retrying' || (recovery.state === 'recovered'
        && (now-Date.parse(recovery.recovered_at) < 600000 || state.entries[recovery.id]?.opened?.accepted))) {
      const kind = recovery.state === 'recovered' ? 'recovered' : 'opened';
      candidates.push({id:recovery.id,kind,content:kind === 'recovered'
        ? '【TG 连接恢复】此前连接中断或请求超时，现已重建连接并完成来源扫描；按原断点补采。'
        : '【TG 连接告警】连接中断或请求超时，正在重建 Telegram 连接；入库断点保留。'});
    }
  }
  for (const notice of candidates) {
    validateNotice(notice);
    const episode = state.entries[notice.id] ||= {};
    const previous = episode[notice.kind];
    if (previous?.accepted || previous?.attempts >= 3 || (previous && now-previous.last_attempt < 300000)) continue;
    // Persist the attempt before I/O; a failed or killed sender cannot create a retry storm.
    episode[notice.kind] = {attempts:(previous?.attempts || 0)+1,last_attempt:now,accepted:false};
    state.entries = Object.fromEntries(Object.entries(state.entries).slice(-100));
    write(file,state);
    const requestFile = path.join(folder,'telegram-notice-request.json');
    write(requestFile,notice);
    let accepted = false;
    let error;
    try {
      const result = await send({project,root,file:requestFile,notice});
      accepted = result === true || result?.accepted === true;
      error = accepted ? undefined : result?.error || 'NOTICE_NOT_ACCEPTED';
    } catch { error = 'NOTICE_TRANSPORT_FAILED'; }
    episode[notice.kind].accepted = accepted;
    episode[notice.kind].error = error;
    write(file,state);
    append({event:accepted ? 'private_notice_accepted' : 'private_notice_failed',role:'telegram',id:notice.id,kind:notice.kind,error});
    return {accepted,id:notice.id,kind:notice.kind,error};
  }
  return {skipped:'no_new_notice'};
}
if (require.main === module) {
  const file = process.argv[2];
  const timer = setTimeout(() => process.exit(75),14000);
  (async () => {
    const notice = validateNotice(read(file));
    const accepted = await require('./qq/core/alerts.cjs').notify(`monitor:${notice.id}:${notice.kind}`,notice.content);
    console.log(JSON.stringify({accepted}));
    if (!accepted) process.exitCode = 1;
  })().catch(() => {console.error('Telegram private alert failed; inspect QQ credentials and private messaging permission');process.exitCode=1;})
    .finally(() => clearTimeout(timer));
}
module.exports = {notifyTelegram,sendNotice,validateNotice};

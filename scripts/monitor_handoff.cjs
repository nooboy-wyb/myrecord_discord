const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');

const roles = ['discord','telegram','qq'];
const states = ['HEALTHY','DEGRADED','SUSPECT','STOPPED','STARTING','START_FAILED','COOLDOWN','RESTART_LIMITED',
  'CONFLICT','MANUAL_REQUIRED','PAUSED','INSPECTION_FAILED'];
const codes = ['OTHER','LAUNCHER_WITHOUT_PROCESS','PROCESS_INSPECTION_UNAVAILABLE','PROCESS_ABSENT','MULTIPLE_PROCESSES',
  'HEALTH_UNAVAILABLE','HEALTH_ROLE_MISMATCH','PORT_OWNER_MISMATCH','PAGE_REPORT_STALE','PAGE_SCAN_ERROR',
  'SQLITE_WRITE_FAILED','CAPTURE_REJECTED','SCAN_STATUS_STALE','SCAN_ERROR','SOURCE_SCAN_ERROR','SOURCE_PROGRESS_STALE',
  'GATEWAY_OFFLINE','GATEWAY_ACK_STALE','PLANNER_STALE','PLANNER_ERROR','PLANNER_BLOCKED','QUEUE_INSPECTION_FAILED',
  'SEND_UNKNOWN','QUEUE_BACKLOG','QUEUE_ERROR','EXIT_RESULT_UNREADABLE','START_FAILED'];
const categories = ['AUTHORIZATION','PERMISSION','SEND_UNKNOWN','RATE_LIMIT','ATTACHMENT','STORAGE_OR_DATA','NETWORK','BUSINESS'];
const actions = ['observe','manual_review','recover_via_fsm'];
const timestamp = value => {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function buildHandoff(previous,role,observation,incidents,at) {
  if (!roles.includes(role) || !states.includes(observation.state) || !timestamp(at)) throw Error('Invalid handoff observation');
  const continuing = previous && previous.status !== 'RESOLVED';
  if (['HEALTHY','PAUSED'].includes(observation.state) && !previous) return null;
  const status = observation.state === 'HEALTHY' ? 'RESOLVED' : observation.state === 'PAUSED' ? 'SUSPENDED' : 'OPEN';
  if (status === 'SUSPENDED' && !continuing) return previous;
  const grouped = new Map();
  for (const incident of Object.values(incidents).filter(item => item.role === role)) {
    const code = codes.includes(incident.code) ? incident.code : 'OTHER';
    const category = categories.includes(incident.category) ? incident.category : 'BUSINESS';
    const key = `${code}:${category}`;
    const before = grouped.get(key);
    const first = timestamp(incident.first_seen_at) || at;
    grouped.set(key,{code,category,count:(before?.count || 0)+1,
      first_seen_at:before && before.first_seen_at < first ? before.first_seen_at : first});
  }
  const issues = status === 'RESOLVED' ? [] : [...grouped.values()].sort((left,right) =>
    `${left.code}:${left.category}`.localeCompare(`${right.code}:${right.category}`));
  const allowed = ['observe','manual_review'];
  if (!observation.running && !observation.starting && !observation.recovery_blocked
      && ['STOPPED','SUSPECT','COOLDOWN'].includes(observation.state)) allowed.push('recover_via_fsm');
  const packet = {
    schema_version:1,id:continuing || status === 'RESOLVED' ? previous.id : `${role}-${randomUUID()}`,
    role,status,state:observation.state,
    first_seen_at:continuing || status === 'RESOLVED' ? previous.first_seen_at : timestamp(observation.first_failure_at) || at,
    observed_at:at,resolved_at:status === 'RESOLVED' ? previous.resolved_at || at : null,
    issues,signals:{process_running:!!observation.running,instance_count:count(observation.instance_count),
      health_present:!!observation.health_present,unknown_parts:count(observation.queue?.unknown_parts)},
    recovery:{attempts_in_window:count(observation.restarts?.length),
      last_attempt_at:observation.last_start_at == null ? null : timestamp(observation.last_start_at),
      last_exit_code:Number.isSafeInteger(observation.last_launch?.exit?.exit_code) ? observation.last_launch.exit.exit_code : null},
    allowed_actions:allowed,unknown_send_policy:'quarantine_no_retry'
  };
  const signature = {status:packet.status,state:packet.state,issues:issues.map(({code,category,count:total}) => ({code,category,count:total})),
    signals:packet.signals,recovery:packet.recovery,allowed_actions:allowed};
  packet.fingerprint = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
  packet.revision = continuing || status === 'RESOLVED'
    ? count(previous.revision)+(previous.fingerprint === packet.fingerprint ? 0 : 1) : 1;
  return packet;
}
function writeHandoffs(folder,report,incidents,append) {
  const directory = path.join(folder,'handoff');
  fs.mkdirSync(directory,{recursive:true});
  const result = {};
  for (const role of roles) {
    const file = path.join(directory,`${role}.json`);
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : null;
    if (previous) validatePacket(previous);
    const packet = buildHandoff(previous,role,report.roles[role],incidents,report.at);
    if (!packet) continue;
    validatePacket(packet);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(packet,null,2),'utf8');
    fs.renameSync(temporary,file);
    result[role] = {id:packet.id,revision:packet.revision,status:packet.status};
    if (previous?.id !== packet.id || previous?.revision !== packet.revision)
      append({event:'handoff_updated',role,...result[role]});
  }
  return result;
}
function validatePacket(packet) {
  const exactKeys = (value,keys) => value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const validTime = value => value === null || (typeof value === 'string' && timestamp(value) === value);
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  if (!exactKeys(packet,['schema_version','id','role','status','state','first_seen_at','observed_at','resolved_at','issues',
    'signals','recovery','allowed_actions','unknown_send_policy','fingerprint','revision'])
    || packet.schema_version !== 1 || !roles.includes(packet.role)
    || !new RegExp(`^${packet.role}-[0-9a-f-]{36}$`).test(packet.id)
    || !['OPEN','SUSPENDED','RESOLVED'].includes(packet.status) || !states.includes(packet.state)
    || !packet.first_seen_at || !validTime(packet.first_seen_at) || !packet.observed_at || !validTime(packet.observed_at)
    || !validTime(packet.resolved_at) || !/^[0-9a-f]{64}$/.test(packet.fingerprint)
    || !Number.isSafeInteger(packet.revision) || packet.revision < 1
    || packet.unknown_send_policy !== 'quarantine_no_retry'
    || !Array.isArray(packet.allowed_actions) || !packet.allowed_actions.length
    || packet.allowed_actions.some(action => !actions.includes(action))
    || !Array.isArray(packet.issues) || packet.issues.length > codes.length*categories.length
    || packet.issues.some(issue => !exactKeys(issue,['code','category','count','first_seen_at'])
      || !codes.includes(issue.code) || !categories.includes(issue.category) || !validCount(issue.count)
      || !issue.first_seen_at || !validTime(issue.first_seen_at))
    || !exactKeys(packet.signals,['process_running','instance_count','health_present','unknown_parts'])
    || typeof packet.signals.process_running !== 'boolean' || typeof packet.signals.health_present !== 'boolean'
    || !validCount(packet.signals.instance_count) || !validCount(packet.signals.unknown_parts)
    || !exactKeys(packet.recovery,['attempts_in_window','last_attempt_at','last_exit_code'])
    || !validCount(packet.recovery.attempts_in_window) || !validTime(packet.recovery.last_attempt_at)
    || (packet.recovery.last_exit_code !== null && !Number.isSafeInteger(packet.recovery.last_exit_code)))
    throw Error('Invalid sanitized handoff packet');
  return packet;
}
module.exports = {roles,codes,actions,buildHandoff,writeHandoffs,validatePacket};

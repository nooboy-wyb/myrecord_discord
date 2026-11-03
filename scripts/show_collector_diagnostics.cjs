const fs = require('node:fs');
const {DatabaseSync} = require('node:sqlite');
const {defaultFile} = require('./collector_diagnostics.cjs');

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const channel = option('--channel');
const incident = option('--incident');
const limit = Math.max(1,Math.min(500,Number(option('--limit') || 50)));
if (!fs.existsSync(defaultFile)) {
  console.log(`尚无持久诊断日志：${defaultFile}`);
  process.exit(0);
}
const db = new DatabaseSync(defaultFile,{readOnly:true});
try {
  const clauses = [];
  const params = [];
  if (channel) { clauses.push('channel_id=?'); params.push(channel); }
  if (incident) { clauses.push('incident_at=?'); params.push(Number(incident)); }
  const sql = `SELECT * FROM collector_diagnostic_events ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
    ORDER BY occurred_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params,limit).reverse();
  const time = value => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '-';
  for (const row of rows) {
    const detail = JSON.parse(row.detail_json);
    console.log(`${time(row.occurred_at)} ${row.code} 频道=${row.channel_id || '-'} 页=${row.tab_id ?? '-'}
  事件=${row.incident_at || '-'} 第${row.attempt ?? '-'}次 请求=${time(row.requested_at)} 加载=${time(row.loaded_at)} 下次=${time(row.next_attempt_at)}
  原因码=${detail.trigger_code || '-'} 错误=${row.error || '-'} 详情=${row.detail_json}`);
  }
  if (!rows.length) console.log('没有匹配的诊断事件。');
} finally { db.close(); }

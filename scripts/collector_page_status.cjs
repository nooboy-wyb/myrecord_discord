const crypto = require('node:crypto');

const validId = value => /^\d{15,22}$/.test(String(value));
function ids(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !validId(item)))
    throw Error('invalid channel page status');
  return [...new Set(value.map(String))];
}

function createPageStatusReporter({labels,log = console,saveDiagnostic}) {
  let lastSignature = '';
  let lastReportAt = 0;
  const expected = Object.keys(labels);
  function report(body) {
    const enabled = new Set(ids(body?.enabled));
    const open = new Set(ids(body?.open));
    const scanning = new Set(ids(body?.scanning));
    if ([...open].some(id => !enabled.has(id)) || [...scanning].some(id => !open.has(id)))
      throw Error('inconsistent channel page status');
    lastReportAt = Date.now();
    const issues = expected.map(id => {
      if (!enabled.has(id)) return {id,status:'扩展未启用采集'};
      if (!open.has(id)) return {id,status:'Discord 页面未打开'};
      if (!scanning.has(id)) return {id,status:'页面已打开，但扫描无响应'};
      return null;
    }).filter(Boolean);
    const signature = JSON.stringify(issues);
    if (signature === lastSignature) return {changed:false,issues};
    lastSignature = signature;
    log.log(`Discord 页面检查：${expected.length - issues.length}/${expected.length} 个频道页面已打开且扫描有响应。`);
    for (const issue of issues) log.warn(`频道 ${labels[issue.id]}：${issue.status}。`);
    saveDiagnostic({event_id:crypto.randomUUID(),at:lastReportAt,code:'CHANNEL_PAGE_STATUS',
      detail:{enabled:[...enabled],open:[...open],scanning:[...scanning],issues}});
    return {changed:true,issues};
  }
  function warnIfNoReport() {
    if (!lastReportAt) log.warn('Discord 页面检查：尚未收到扩展的页面清单；请检查 Edge、采集扩展和频道标签页。');
  }
  return {report,warnIfNoReport};
}

module.exports = {createPageStatusReporter};

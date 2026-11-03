const assert = require('node:assert/strict');
const {createPageStatusReporter} = require('../scripts/collector_page_status.cjs');

const logs = [];
const diagnostics = [];
const first = '1254782508793593947';
const second = '1265882617530814535';
const reporter = createPageStatusReporter({labels:{[first]:'颜驰',[second]:'交流频道'},
  log:{log:value=>logs.push(value),warn:value=>logs.push(value)},
  saveDiagnostic:event=>diagnostics.push(event)});

reporter.warnIfNoReport();
assert(logs.some(line=>line.includes('尚未收到扩展')));
const missing = reporter.report({enabled:[first,second],open:[first],scanning:[first]});
assert.equal(missing.issues.length,1);
assert(logs.some(line=>line.includes('交流频道：Discord 页面未打开')));
assert.equal(diagnostics.length,1);
reporter.report({enabled:[first,second],open:[first],scanning:[first]});
assert.equal(diagnostics.length,1,'unchanged reports must not repeat the reminder');
const stalled = reporter.report({enabled:[first,second],open:[first,second],scanning:[first]});
assert.equal(stalled.issues[0].status,'页面已打开，但扫描无响应');
assert(logs.some(line=>line.includes('交流频道：页面已打开，但扫描无响应')));
const healthy = reporter.report({enabled:[first,second],open:[first,second],scanning:[first,second]});
assert.equal(healthy.issues.length,0);
assert.equal(diagnostics.length,3);
const removed = reporter.report({enabled:[first],open:[first],scanning:[first]});
assert.equal(removed.issues.length,0,'a channel removed from extension settings is not monitored');
assert(logs.some(line=>line.includes('1/1 个频道页面已打开且扫描有响应')));
assert(!logs.some(line=>line.includes('扩展未启用采集')));
assert.equal(diagnostics.length,4,'removing an enabled channel changes the status summary');
assert.throws(()=>reporter.report({enabled:[first],open:[first,second],scanning:[]}),
  /inconsistent/);
console.log('Startup page reminder distinguishes missing tabs from stalled scans and logs only changes.');

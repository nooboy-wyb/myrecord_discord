const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
const start = source.indexOf('  for (const item of interrupted) {');
const end = source.indexOf('  setInterval(tick, 5000);',start);
assert(start >= 0 && end > start);
const accepted = new Set();
let notifications = 0;
const state = {prepare:sql => sql.startsWith('SELECT')
  ? {get:key => accepted.has(key) ? {found:1} : undefined}
  : {run:key => accepted.add(key)}};
const item = {source_message_id:'1567130453964619881',source_timestamp:'2026-11-03T10:56:56Z',
  channel_id:'1265882617530814535',part_index:1,group_openid:'group3'};
const run = vm.runInNewContext(`async function check(){${source.slice(start,end)}
  await Promise.resolve();}\ncheck`,{
  interrupted:[item],state,alerts:{notify:async()=>{notifications++;return true;}},
  channelLabels:()=>({[item.channel_id]:'交流频道'}),sourceTimeLabel:()=> '【时间】',
  console:{warn:()=>{},error:()=>{}},Date
});
(async()=>{
  await run();
  assert.equal(notifications,1);
  assert.equal(accepted.size,1);
  await run();
  assert.equal(notifications,1,'the same unresolved part must not send a second startup alert');
  console.log('Accepted startup unknown alerts persist across starts.');
})().catch(error=>{console.error(error);process.exitCode=1;});

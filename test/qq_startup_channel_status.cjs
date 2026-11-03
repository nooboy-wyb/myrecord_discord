const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
const start = source.indexOf('function setOnline(value) {');
const end = source.indexOf('\nmodule.exports',start);
assert(start >= 0 && end > start);
const logs = [];
const setOnline = vm.runInNewContext(`let online=false;\n${source.slice(start,end)}\nsetOnline`,{
  additionalTargets:()=>[
    {qq_group_number:'1130863739',channel_ids:['1265882617530814535']},
    {qq_group_number:'1132949059',channel_ids:['1405206823727796408']}],
  primaryControl:()=>({primary_enabled:true,paused_channels:{}}),
  channelLabels:()=>({'1265882617530814535':'交流频道','1405206823727796408':'风寻',
    '1224358019056271442':'利润医生'}),
  additionalChannelIds:new Set(['1265882617530814535','1405206823727796408']),
  console:{log:value=>logs.push(value)}
});
setOnline(true);
assert(logs.some(line=>line.includes('交流频道：已启动自动转发（群 3）')));
assert(logs.some(line=>line.includes('风寻：已启动自动转发（群 2）')));
assert(logs.every(line=>!line.includes('1130863739')&&!line.includes('1132949059')));
assert(logs.some(line=>line.includes('利润医生：已启动自动转发（群 1）')));
assert(logs.every(line=>line.includes('Discord 页面待扫描确认')));
setOnline(true);
assert.equal(logs.length,3,'repeated READY should not duplicate the summary');
setOnline(false);
setOnline(true);
assert.equal(logs.length,6,'a reconnect should print the summary again');
console.log('QQ startup status distinguishes routing from page capture.');

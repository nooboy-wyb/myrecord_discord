const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'),'utf8');
const start = source.indexOf('function liveMessageEligible(');
const end = source.indexOf('\nfunction speakerName(',start);
assert(start >= 0 && end > start);

const message = {channel_id:'exchange',source_message_id:'1234567890123456789',
  source_timestamp:'2026-11-03T10:56:56Z',content_sha256:'digest'};
const retryKey = crypto.createHash('sha256').update(JSON.stringify([
  'group3',message.channel_id,message.source_message_id,message.content_sha256
])).digest('hex');
const retryable = new Set();
const eligible = vm.runInNewContext(`${source.slice(start,end)}\nliveMessageEligible`,{
  crypto,Date,liuyudong:{channelId:'liu'},
  state:{prepare:()=>({get:key=>retryable.has(key) ? {found:1} : undefined})},
  liveWatermark:()=>({source_message_id:'1234567890123456799',
    source_timestamp:'2026-11-03T11:00:00Z'}),
  sourceTime:item=>Date.parse(item.source_timestamp),
  isAfterLiveWatermark:()=>false
});
assert.equal(eligible('group3',message,0),false);
retryable.add(retryKey);
assert.equal(eligible('group3',message,0),true,
  'an earlier image upload must remain retryable after later messages advance the watermark');
assert.equal(eligible('another-group',message,0),false);
console.log('Safe QQ retries remain eligible after newer messages advance the watermark.');

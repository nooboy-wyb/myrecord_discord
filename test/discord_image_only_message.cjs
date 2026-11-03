const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../edge-discord-collector/content.js'),'utf8');
const containerStart = source.indexOf('  function messageContainer(');
const extractorStart = source.indexOf('  function originalAttachmentUrl(',containerStart);
const extractorEnd = source.indexOf('  async function scan(',extractorStart);
assert(containerStart >= 0 && extractorStart > containerStart && extractorEnd > extractorStart);
const document = {body:{},title:'交流频道',querySelectorAll:()=>[]};
const extract = vm.runInNewContext(`${source.slice(containerStart,extractorStart)}\n${source.slice(extractorStart,extractorEnd)}\nextract`,
  {document,URL,Date,text:()=>''});
const channelId = '1265882617530814535';
const messageId = '1567019164546244639';
const attachment = {
  href:`https://media.discordapp.net/attachments/${channelId}/1567019164344914130/chart.png?ex=abc&is=def&hm=ghi&width=512`
};
const node = {
  id:`chat-messages-${channelId}-${messageId}`,dataset:{},matches:()=>false,
  querySelector:selector => selector === 'time[datetime]'
    ? {getAttribute:()=> '2026-11-03T03:34:42.636Z',textContent:'11:34'} : null,
  querySelectorAll:selector => selector === 'a[href]' ? [attachment] : []
};
const message = extract(node,{guild_id:'1',channel_id:channelId},'交流频道');
assert.equal(message.source_message_id,messageId);
assert.equal(message.body_raw,'');
assert.equal(message.body_kind,'single_image');
assert.equal(message.attachments.length,1);
assert.match(message.attachments[0].source_url,/^https:\/\/cdn\.discordapp\.com\/attachments\//);
console.log('Image-only Discord messages with channel and message IDs are captured.');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../edge-discord-collector/content.js'),'utf8');
const containerStart = source.indexOf('  function messageContainer(');
const extractorStart = source.indexOf('  function originalAttachmentUrl(',containerStart);
const extractorEnd = source.indexOf('  function messageNodes(',extractorStart);
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
const previousContent = {id:'message-content-1567019159626186805',innerText:'fc btc 15min'};
const withPreviousContent = {...node,querySelector:selector => selector === '[id^="message-content-"]'
  ? previousContent : node.querySelector(selector)};
const recovered = extract(withPreviousContent,{guild_id:'1',channel_id:channelId},'交流频道');
assert.equal(recovered.source_message_id,messageId);
assert.equal(recovered.body_raw,'','the previous message text must not be copied onto the image');
assert.equal(recovered.body_kind,'single_image');
assert.equal(recovered.source_timestamp,
  new Date(Number((BigInt(messageId) >> 22n) + 1420070400000n)).toISOString());
const previousNode = {id:`chat-messages-${channelId}-1567019159626186805`};
previousContent.closest = () => previousNode;
previousContent.parentElement = null;
const quotedDocument = {
  body:{},querySelectorAll:selector => selector === '[id^="chat-messages-"]'
    ? [previousNode,withPreviousContent] : selector === '[id^="message-content-"]'
      ? [previousContent] : selector === 'li[class*="messageListItem"], [data-message-id]'
        ? [withPreviousContent] : []
};
const chooserStart = extractorEnd;
const chooserEnd = source.indexOf('  async function scan(',chooserStart);
assert(chooserStart > extractorStart && chooserEnd > chooserStart);
const choose = vm.runInNewContext(`${source.slice(containerStart,extractorStart)}\n${source.slice(chooserStart,chooserEnd)}\nmessageNodes`,
  {document:quotedDocument});
const {nodes} = choose();
assert(nodes.has(withPreviousContent),'a message with quoted text must still be scanned');
assert(nodes.has(previousNode),'the original text message remains scannable');
console.log('Image-only Discord messages with channel and message IDs are captured.');

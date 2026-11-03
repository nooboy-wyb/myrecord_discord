const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../scripts/qq/core/forwarder.cjs'), 'utf8');
const start = source.indexOf('async function processMessage(');
const end = source.indexOf('\nconst manualRecovery', start);
assert(start >= 0 && end > start);

const attempts = new Map();
const imageStates = [];
const requests = [];
const warnings = [];
let uploadCount = 0;
let failImageMessage = false;
let unknownAlerts = 0;
const localPath = path.join('test', 'chart.png');
const message = {
  channel_id:'exchange',source_message_id:'1234567890123456789',content_sha256:'digest',
  source_timestamp:'2026-11-03T10:56:56Z',body_raw:'chart',
  attachments_json:JSON.stringify([{source_url:'https://cdn.discordapp.com/attachments/chart.png'}]),
  attachments:[{source_url:'https://cdn.discordapp.com/attachments/chart.png',
    local_path:localPath,status:'saved'}]
};
const processMessage = vm.runInNewContext(`${source.slice(start,end)}\nprocessMessage`,{
  target:{group_openid:'primary'},liuyudong:{channelId:'liu'},
  fengxun:{channelId:'feng',afterSend:()=>{}},
  yanchi:{channelIds:[],fanwanChannelId:'fan',afterSend:()=>{}},
  crypto,path,Date,Buffer,groupCooldownUntil:new Map(),rateLimitCooldownMs:120000,
  fs:{existsSync:()=>true,readFileSync:()=>Buffer.from('png bytes')},
  state:{prepare:()=>({get:(key,index)=>attempts.get(`${key}:${index}`)})},
  record:(key,index,type,_message,status)=>{
    if (type === 'image') imageStates.push(status);
    attempts.set(`${key}:${index}`,
      {status,attempted_at:new Date(Date.now()-121000).toISOString(),type});
  },
  messageHeading:()=> 'heading',
  buildParts:()=>[{type:'text',content:'heading\nchart'},
    {type:'image',sourceUrl:message.attachments[0].source_url,content:' '}],
  post:async (endpoint,payload)=>{
    requests.push(endpoint);
    if (endpoint === 'files' && ++uploadCount === 1) {
      const error = Error('fetch failed');
      error.cause = {code:'ECONNRESET'};
      throw error;
    }
    if (endpoint === 'messages' && payload.msg_type === 7 && failImageMessage)
      throw Error('fetch failed after message request started');
    return endpoint === 'files' ? {file_info:'uploaded'} : {id:'qq-message-id'};
  },
  pauseGroup:()=>{throw Error('a failed upload must not pause the group');},
  alerts:{notify:()=>{unknownAlerts++;return Promise.resolve(true);}},
  console:{log:()=>{},warn:value=>warnings.push(value),error:()=>{}},
  sourceTimeLabel:()=> '',saveDiagnostic:()=>{}
});

(async()=>{
  assert.equal(await processMessage(message,{group_openid:'group3'}),'deferred');
  assert.deepEqual(requests,['messages','files']);
  assert.equal(unknownAlerts,0);
  assert(warnings.some(line=>line.includes('上传失败') && line.includes('ECONNRESET')));
  assert.deepEqual(imageStates,['preparing','failed_preflight']);
  assert([...attempts.values()].some(item=>item.type==='image' && item.status==='failed_preflight'));
  assert.equal(await processMessage(message,{group_openid:'group3'}),'accepted');
  assert.deepEqual(requests,['messages','files','files','messages']);
  assert.deepEqual(imageStates,['preparing','failed_preflight','preparing','unknown','accepted']);
  assert.equal([...attempts.values()].filter(item=>item.type==='text').length,1);
  failImageMessage = true;
  const uncertain = {...message,source_message_id:'1234567890123456790',content_sha256:'other'};
  assert.equal(await processMessage(uncertain,{group_openid:'group3'}),'unknown');
  assert.equal(unknownAlerts,1);
  const requestsAfterUnknown = requests.length;
  assert.equal(await processMessage(uncertain,{group_openid:'group3'}),'unknown');
  assert.equal(requests.length,requestsAfterUnknown,'an uncertain group message must not be sent again');
  console.log('An image upload failure retries safely without resending accepted text.');
})().catch(error=>{console.error(error);process.exitCode=1;});

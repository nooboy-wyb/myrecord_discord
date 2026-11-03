const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../edge-discord-collector/content.js'),'utf8');
const start = source.indexOf('  function inheritedAuthor(');
const end = source.indexOf('\n  function extract(',start);
assert(start >= 0 && end > start);
const containerStart = source.indexOf('  function messageContainer(');
const containerEnd = source.indexOf('\n  function originalAttachmentUrl(',containerStart);
assert(containerStart >= 0 && containerEnd > containerStart);
const container = (author,time) => ({author,querySelector:()=>({getAttribute:()=>time})});
const header = container('周Sir（不会主动私信）','2026-11-01T07:24:53.887Z');
const continuation = container('','2026-11-01T07:30:20.991Z');
const next = container('','2026-11-01T07:30:53.557Z');
const contents = [header,continuation,next].map((owner,index)=>({
  id:`message-content-${index+1}`,closest:()=>owner,parentElement:owner
}));
const document = {body:{},querySelectorAll:()=>contents};
for (const [index,owner] of [header,continuation,next].entries()) {
  owner.querySelectorAll = () => [contents[index]];
  owner.matches = () => true;
  owner.parentElement = document.body;
}
const text = owner => owner.author;
const inherit = vm.runInNewContext(`${source.slice(containerStart,containerEnd)}\n${source.slice(start,end)}\ninheritedAuthor`,{document,text,Date});
const currentNode = content => ({matches:()=>false,querySelector:()=>content});
assert.equal(inherit(currentNode(contents[1]),'2026-11-01T07:30:20.991Z'),header.author);
assert.equal(inherit(currentNode(contents[2]),'2026-11-01T07:30:53.557Z'),header.author);
assert.equal(inherit(currentNode(contents[2]),'2026-11-01T07:50:53.557Z'),'');
const chooseContainer = vm.runInNewContext(`${source.slice(containerStart,containerEnd)}\nmessageContainer`,{document});
const outer = {querySelectorAll:()=>[contents[1]],querySelector:()=>({}),matches:()=>true,
  parentElement:document.body};
const inner = {querySelectorAll:()=>[contents[1]],querySelector:()=>null,matches:()=>false,
  parentElement:outer};
const nestedContent = {...contents[1],closest:()=>inner,parentElement:inner};
inner.querySelectorAll = () => [nestedContent];
outer.querySelectorAll = () => [nestedContent];
assert.equal(chooseContainer(nestedContent),outer,
  'image siblings outside the inner message node must stay in the selected message container');
console.log('Discord grouped messages inherit the visible header author within ten minutes.');

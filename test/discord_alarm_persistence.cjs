const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const alarms = new Map();
let creates = 0;
const chrome = {
  alarms:{get:async name=>alarms.get(name),create:async(name,options)=>{creates++;alarms.set(name,options);},
    onAlarm:{addListener(){}}},
  storage:{local:{get:async()=>({}),set:async()=>{}}},
  tabs:{onUpdated:{addListener(){}}},
  runtime:{onMessage:{addListener(){}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}
};
const source = fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8');
const run = () => vm.runInNewContext(source,{chrome,console,setInterval(){},Date,URL,URLSearchParams,BigInt,Buffer});
(async()=>{
  run();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(creates,3);
  run();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(creates,3,'service-worker restart must preserve scheduled alarms');
  console.log('Discord patrol alarms survive worker restart without rescheduling.');
})().catch(error=>{console.error(error);process.exitCode=1;});

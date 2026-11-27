const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../edge-discord-collector/background.js'),'utf8');
const setup = source.slice(0,source.indexOf('addRequestedChannelsOnce().catch'));
const oldRa = '1381634972372308060', newRa = '1381635122989891594';

test('RA replacement migrates an installed extension once and preserves other settings',async () => {
  const data = {allowedChannels:[oldRa,'custom'],channelLabels:{[oldRa]:'RA',custom:'custom'},
    addedRaChannelV1:true,token:'fixture',queue:[{key:'pending'}]};
  let writes = 0;
  const context = vm.createContext({chrome:{storage:{local:{
    async get(keys) { return Object.fromEntries(keys.filter(key => key in data).map(key => [key,structuredClone(data[key])])); },
    async set(values) { writes++;Object.assign(data,structuredClone(values)); }
  }}}});
  const migrate = vm.runInContext(setup+'\naddRequestedChannelsOnce',context);
  await migrate();
  assert.ok(data.allowedChannels.includes(newRa));
  assert.ok(!data.allowedChannels.includes(oldRa));
  assert.ok(data.allowedChannels.includes('custom'));
  assert.equal(data.channelLabels[newRa],'RA');
  assert.equal(data.channelLabels[oldRa],undefined);
  assert.equal(data.channelLabels.custom,'custom');
  assert.equal(data.addedRaChannelV2,true);
  assert.equal(data.token,'fixture');
  assert.deepEqual(data.queue,[{key:'pending'}]);
  // A later manual removal must survive the next service-worker startup.
  data.allowedChannels = data.allowedChannels.filter(id => id !== newRa);
  await migrate();
  assert.equal(writes,1);
  assert.ok(!data.allowedChannels.includes(newRa));
});

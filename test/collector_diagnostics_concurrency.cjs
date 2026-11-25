const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {once} = require('node:events');
const {Worker} = require('node:worker_threads');
const {test} = require('node:test');
const {saveDiagnostic} = require('../scripts/collector_diagnostics.cjs');

test('DC and QQ diagnostics wait for a concurrent writer instead of losing events',async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'muse-diagnostics-'));
  const file = path.join(folder,'events.sqlite');
  t.after(() => fs.rmSync(folder,{recursive:true,force:true}));
  const event = {event_id:randomUUID(),at:Date.now(),code:'RECOVERY_STARTED'};
  saveDiagnostic(event,file);
  const worker = new Worker(`
    const {parentPort,workerData} = require('node:worker_threads');
    const {DatabaseSync} = require('node:sqlite');
    const database = new DatabaseSync(workerData);
    database.exec('BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    setTimeout(() => {database.exec('COMMIT');database.close();},250);
  `,{eval:true,workerData:file});
  t.after(() => worker.terminate());
  const exited = once(worker,'exit');
  await once(worker,'message');
  assert.equal(saveDiagnostic({...event,event_id:randomUUID()},file).saved,true);
  assert.deepEqual(await exited,[0]);
});

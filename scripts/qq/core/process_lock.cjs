const fs = require('node:fs');
const crypto = require('node:crypto');

function acquireLock(file) {
  const owner = {pid:process.pid,nonce:crypto.randomUUID()};
  let reclaim;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const descriptor = fs.openSync(file,'wx');
        try { fs.writeFileSync(descriptor,JSON.stringify(owner)); }
        finally { fs.closeSync(descriptor); }
        return () => {
          try {
            if (JSON.parse(fs.readFileSync(file,'utf8')).nonce === owner.nonce) fs.unlinkSync(file);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (reclaim === undefined) reclaim = fs.openSync(`${file}.reclaim`,'wx');
        if (!fs.existsSync(file)) continue;
        const current = JSON.parse(fs.readFileSync(file,'utf8'));
        if (!Number.isSafeInteger(current.pid) || current.pid < 1) throw Error('Invalid sender lock; inspect it manually');
        try { process.kill(current.pid,0); }
        catch (failure) {
          if (failure.code !== 'ESRCH') throw failure;
          fs.unlinkSync(file);
          continue;
        }
        throw Error('QQ sender is already running');
      }
    }
    throw Error('Cannot acquire QQ sender lock');
  } finally {
    if (reclaim !== undefined) { fs.closeSync(reclaim); fs.unlinkSync(`${file}.reclaim`); }
  }
}
module.exports = {acquireLock};

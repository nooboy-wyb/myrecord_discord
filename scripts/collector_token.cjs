const fs = require('node:fs');
const crypto = require('node:crypto');

function collectorToken(file) {
  if (!fs.existsSync(file)) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary,crypto.randomBytes(32).toString('base64url'),{flag:'wx'});
      try { fs.linkSync(temporary,file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { fs.rmSync(temporary,{force:true}); }
  }
  const token = fs.readFileSync(file,'utf8').trim();
  if (!token) throw Error('Collector token file is empty');
  return token;
}
module.exports = {collectorToken};

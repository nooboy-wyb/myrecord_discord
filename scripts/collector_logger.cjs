const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const logDir = process.env.MUSE_COLLECTOR_LOG_DIR || path.resolve(__dirname, '../data/logs');
fs.mkdirSync(logDir, {recursive:true});
const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', second:'2-digit'
});
function append(level, message) {
  try {
    const stamp = formatter.format(new Date());
    const file = path.join(logDir, `collector-${stamp.slice(0, 10)}.log`);
    for (const line of String(message).split(/\r?\n/)) {
      if (line) fs.appendFileSync(file, `[${stamp} +08:00] ${level} ${line}\n`, 'utf8');
    }
  } catch (error) {
    process.stderr.write(`Collector log write failed: ${error.message}\n`);
  }
}
for (const level of ['log','info','warn','error','debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    append(level.toUpperCase(), util.format(...args));
    original(...args);
  };
}
process.on('warning', warning => append('WARNING', warning.stack || warning.message));
process.on('uncaughtExceptionMonitor', error => append('FATAL', error.stack || error.message));
process.on('exit', code => append('EXIT', `Node process exited with code ${code}`));

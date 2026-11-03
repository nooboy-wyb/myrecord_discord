const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'data', 'qq-forward-controls.json');
const mode = process.argv[2];
if (!['pause','resume','status'].includes(mode)) {
  console.error('Usage: node scripts/qq_primary_forwarding.cjs pause|resume|status');
  process.exit(1);
}
const control = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {primary_enabled:true};
if (mode === 'pause') {
  control.primary_enabled = false;
  control.paused_at = new Date().toISOString();
} else if (mode === 'resume') {
  control.primary_enabled = true;
  control.primary_live_after = new Date().toISOString();
  control.resumed_at = control.primary_live_after;
}
if (mode !== 'status') fs.writeFileSync(file, JSON.stringify(control, null, 2));
console.log(JSON.stringify({primary_enabled:control.primary_enabled !== false,
  paused_at:control.paused_at || null,resumed_at:control.resumed_at || null,
  primary_live_after:control.primary_live_after || null}));

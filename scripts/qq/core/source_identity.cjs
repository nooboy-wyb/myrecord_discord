const {DatabaseSync} = require('node:sqlite');

function createSourceIdentityGuard({sourceFiles}) {
  function channels() {
    const identities = new Map();
    for (const file of sourceFiles()) {
      const db = new DatabaseSync(file,{readOnly:true});
      try {
        db.exec('PRAGMA busy_timeout=1000');
        for (const row of db.prepare('SELECT DISTINCT source_message_id,channel_id FROM discord_web_messages').iterate()) {
          if (!identities.has(row.source_message_id)) identities.set(row.source_message_id,new Set());
          identities.get(row.source_message_id).add(row.channel_id);
        }
      } finally { db.close(); }
    }
    return identities;
  }
  async function check(message) {
    if (message.source_message_id.startsWith('telegram:')) return message.channel_id.startsWith('telegram:');
    if (!/^\d+$/.test(message.source_message_id) || !/^\d+$/.test(message.channel_id)) return false;
    let found = false;
    for (const file of sourceFiles()) {
      const db = new DatabaseSync(file,{readOnly:true});
      try {
        db.exec('PRAGMA busy_timeout=1000');
        for (const row of db.prepare('SELECT DISTINCT channel_id FROM discord_web_messages WHERE source_message_id=?')
          .iterate(message.source_message_id)) {
          if (row.channel_id !== message.channel_id) return false;
          found = true;
        }
      } finally { db.close(); }
      await new Promise(resolve => setImmediate(resolve));
    }
    return found;
  }
  return {channels,check};
}
module.exports = {createSourceIdentityGuard};

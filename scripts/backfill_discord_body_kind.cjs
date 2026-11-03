const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const root = path.resolve(__dirname,'..','data');
for (const entry of fs.readdirSync(root,{withFileTypes:true})) {
  if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
  const file = path.join(root,entry.name,'messages.sqlite');
  if (!fs.existsSync(file)) continue;
  const db = new DatabaseSync(file);
  try {
    if (!db.prepare('PRAGMA table_info(discord_web_messages)').all().some(column => column.name === 'body_kind')) {
      db.exec('ALTER TABLE discord_web_messages ADD COLUMN body_kind TEXT');
    }
    const changed = db.prepare(`UPDATE discord_web_messages SET body_kind = CASE
      WHEN lower(trim(body_raw))='no text' AND json_array_length(attachments_json)=1 THEN 'single_image'
      WHEN lower(trim(body_raw))='no text' AND json_array_length(attachments_json)>1 THEN 'images_only'
      WHEN lower(trim(body_raw))='no text' THEN 'missing_image'
      WHEN json_array_length(attachments_json)>0 THEN 'text_and_image' ELSE 'text_only' END
      WHERE body_kind IS NULL`).run();
    console.log(`${entry.name}: ${changed.changes} classified`);
  } finally { db.close(); }
}

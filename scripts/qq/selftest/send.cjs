const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const dataDir = path.resolve(__dirname, '..', '..', '..', 'data');
const targetPath = path.join(dataDir, 'qq-group-openid.json');
const {app_id: appId, group_openid: primaryGroupOpenId} = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
const additionalMode = process.argv.includes('--additional');
const groupOpenId = additionalMode
  ? JSON.parse(fs.readFileSync(path.join(dataDir, 'qq-additional-routes.json'), 'utf8'))
    .routes.find(route => route.qq_group_number === '1132949059')?.group_openid
  : primaryGroupOpenId;
const secret = process.env.QQ_BOT_APP_SECRET?.trim();
const imageMode = process.argv.includes('--image');
const sourceIdIndex = process.argv.indexOf('--source-id');
const sourceId = sourceIdIndex < 0 ? '' : process.argv[sourceIdIndex + 1];
if (sourceId && !/^\d+$/.test(sourceId)) throw Error('Invalid source message ID');
if (!/^\d+$/.test(appId) || !/^[A-Za-z0-9]+$/.test(groupOpenId) || !secret) {
  console.error('Missing target AppID, group OpenID, or local AppSecret.');
  process.exit(1);
}

async function main() {
  const tokenResponse = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({appId, clientSecret: secret}),
    signal: AbortSignal.timeout(15000),
  });
  const tokenBody = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw Error(`QQ token request failed: HTTP ${tokenResponse.status}, code ${tokenBody.code ?? 'unknown'}`);
  }
  let payload;
  if (imageMode) {
    const folder = dataDir;
    const dates = fs.readdirSync(folder, {withFileTypes: true})
      .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map(entry => entry.name).sort().reverse();
    let file;
    if (sourceId) {
      for (const date of dates) {
        const dbPath = path.join(folder,date,'messages.sqlite');
        if (!fs.existsSync(dbPath)) continue;
        const db = new DatabaseSync(dbPath,{readOnly:true});
        try {
          const rows = db.prepare('SELECT id FROM discord_web_messages WHERE source_message_id=? ORDER BY captured_at DESC').all(sourceId);
          for (const row of rows) {
            const saved = db.prepare("SELECT local_path FROM discord_web_attachment_files WHERE message_id=? AND status='saved' ORDER BY id LIMIT 1").get(row.id);
            if (saved?.local_path && fs.existsSync(saved.local_path)) { file = saved.local_path; break; }
          }
        } finally { db.close(); }
        if (file) break;
      }
    } else {
      file = dates.flatMap(date => {
        const dir = path.join(folder, date, 'attachments');
        return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /\.(png|jpe?g)$/i.test(name)).map(name => path.join(dir, name)) : [];
      })[0];
    }
    if (!file) throw Error('No saved PNG/JPEG Discord attachment found for test.');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 5_000_000) throw Error('Selected image exceeds direct upload limit.');
    const uploadResponse = await fetch(`https://api.bot.qq.com/v2/groups/${encodeURIComponent(groupOpenId)}/files`, {
      method: 'POST',
      headers: {authorization: `QQBot ${tokenBody.access_token}`, 'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify({file_type: 1, file_name: path.basename(file), file_data: bytes.toString('base64'), srv_send_msg: false}),
      signal: AbortSignal.timeout(30000),
    });
    const uploadBody = await uploadResponse.json();
    if (!uploadResponse.ok || uploadBody.err_code || !uploadBody.file_info) {
      throw Error(`QQ image upload failed: HTTP ${uploadResponse.status}, code ${uploadBody.err_code ?? uploadBody.code ?? 'unknown'}, trace ${uploadBody.trace_id ?? 'none'}`);
    }
    payload = {msg_type: 7, content: sourceId ? `柳玉东图文合并测试（Discord ${sourceId}）` : '原图发送测试', media: {file_info: uploadBody.file_info}};
    console.log(`已上传测试原图：${path.basename(file)}。准备发送。`);
  } else {
    const content = `Discord 转发连通性测试 ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}。请确认此消息已在测试群显示。`;
    payload = {msg_type: 0, content};
  }
  const response = await fetch(`https://api.bot.qq.com/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `QQBot ${tokenBody.access_token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || body.err_code || !body.id) {
    throw Error(`QQ send failed: HTTP ${response.status}, code ${body.err_code ?? body.code ?? 'unknown'}, message ${body.message ?? 'unknown'}, trace ${body.trace_id ?? 'none'}`);
  }
  console.log(`QQ 接口接受了${imageMode ? '原图' : '文字'}测试消息，消息 ID：${body.id}。请在群里核对实际收到。`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

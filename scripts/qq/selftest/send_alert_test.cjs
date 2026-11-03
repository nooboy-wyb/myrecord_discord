const fs = require('node:fs');
const path = require('node:path');
const target = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'data', 'qq-group-openid.json'), 'utf8'));
process.env.QQ_BOT_APP_ID = String(target.app_id);
require('../core/alerts.cjs').sendTest()
  .then(result => console.log(`QQ 已接受主动私聊告警测试，消息 ID：${result.id}。请在手机上核对实际收到。`))
  .catch(error => { console.error(`QQ 主动私聊告警测试失败：${error.message}`); process.exitCode = 1; });

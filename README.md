# 市场区间预警

> Discord 频道已有独立的 [Edge 网页采集与本机原图归档](docs/discord-ocr-architecture.md)；旧截图 OCR 流程仍可用于历史样本。市场预警 Worker 与 Discord 归档目前互不连接。

Cloudflare Worker 每分钟并行检查黄金 XAU/USD、BTC/USD 和美股 SNDK。触及设定的下限或上限时，通过 AstrBot HTTP API 分别向微信、QQ 推送。每个方向触发一次，回到区间后重新布防；某个渠道投递失败会重试该渠道。

## 数据源和时效

- 黄金、BTC： [Gold API 实时报价](https://gold-api.com/docs)，无需密钥。报价时间超过 2 分钟会跳过预警。
- SNDK：[Alpaca 股票成交价](https://docs.alpaca.markets/us/reference/stocklatesttrades-1)，需要免费账号 API Key。免费 `iex` 行情只覆盖 IEX 交易所，并非全美股综合行情；超过 15 分钟的成交价会跳过预警。收盘期间通常不会发预警。
- 每分钟轮询一次，因此触发时间还取决于行情源更新时间、网络和定时任务执行时间。它不是逐笔交易推送。

## 部署

需要 Cloudflare 账号，以及一个已接入微信和 QQ、可通过 **HTTPS** 从公网访问的 AstrBot v4.18.0 或更新版本。AstrBot 可以部署在自己的服务器；市场监控本身无需自建服务器。AstrBot 的主动消息接口和 UMO 用法见[官方文档](https://docs.astrbot.app/dev/openapi.html)。

1. 安装 Node.js 和 npm，在本目录运行 `npm install`。
2. 登录 Cloudflare：`npx wrangler login`。
3. 创建 KV：`npx wrangler kv namespace create ALERTS_KV`，把返回的 `id` 写入 `wrangler.jsonc`，替换 `REPLACE_WITH_KV_NAMESPACE_ID`。
4. 设置密钥（每条命令执行后按提示输入值）：

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put ALPACA_KEY_ID
   npx wrangler secret put ALPACA_SECRET_KEY
   npx wrangler secret put ASTRBOT_URL
   npx wrangler secret put ASTRBOT_API_KEY
   npx wrangler secret put UMO_WECHAT
   npx wrangler secret put UMO_QQ
   ```

   `ADMIN_TOKEN` 请用至少 24 位随机字符串。`ASTRBOT_URL` 示例：`https://bot.example.com`。在 AstrBot WebUI 的 **设置 → OpenAPI** 创建可调用 `/api/v1/im/message` 的 API Key。分别在微信和 QQ 中给机器人发送 `/sid`，记录返回的 UMO，填入对应密钥。

5. 部署：`npx wrangler deploy`。打开返回的 Worker URL，输入 `ADMIN_TOKEN`，按需修改上下限并保存。初始区间为黄金 3800–4200、BTC 80000–100000、SNDK 180–220 USD。若当前价已在区间外，首次检查就会预警。
6. 点击“立即检查”验证行情和消息。`npx wrangler tail` 可看定时任务结果。`npm test` 可运行本地测试。

Cloudflare 免费套餐目前支持 Cron Trigger 和 KV；具体配额以[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)及[KV 限制](https://developers.cloudflare.com/kv/platform/limits/)为准。KV 是最终一致存储，极少数重叠执行或写入延迟时可能重复通知；它不适合下单级可靠性要求。

## 安全和运维

- Worker 的管理 API 使用 `ADMIN_TOKEN`。浏览器只在当前标签页的 `sessionStorage` 保存它；不要把密钥写进仓库。
- AstrBot 必须使用 HTTPS；只授予所需 API scope，并限制来源访问（例如 Cloudflare Access 或反向代理规则）。
- 价格源失败或报价过期时跳过预警，下一轮继续检查。消息接口失败时，下轮重试对应渠道。
- 修改区间边界会重新布防，新边界外的现价在下一轮可能立即触发。

# QQ 收发脚本

- `core/forwarder.cjs`：通用 Discord → QQ 路由、消息组装、发送与状态记录。
- `core/manual_recovery.cjs`：网页手动历史补发的预览、提交、状态与取消；自动转发不依赖其按钮状态。
- `core/gateway.cjs`：QQ Gateway 连接及群消息事件接收。
- `core/alerts.cjs`：私聊绑定及 QQ 发送失败告警。
- `selftest/send.cjs`：向主群或附加群发送一次文字／原图测试。
- `selftest/send_qq_test.ps1`：加载本地凭证并运行发送测试。
- `selftest/get_qq_group_openid.ps1`：监听群消息以取得群 OpenID。
- `selftest/get_qq_additional_group_openid.ps1`：查看或等待附加群绑定。
- `selftest/repair_confirmed_missing_image.ps1`：仅在用户确认群内缺图后，对指定 Discord 消息和单频道附加群执行一次定向补图；要求原文字已接受、图片结果未知且无既有补发记录。先用 `-DryRun` 预检，补发另记为 `repair`，不覆盖原尝试。
- `selftest/repair_uncaptured_image_from_url.ps1`：仅在用户提供与原消息同频道的 Discord 附件地址并确认群内缺图后使用。要求归档只有一条纯文字版本且该文字仅成功发送一次；先用 `-DryRun` 验证原图、路由和发送记录，再归档原图并只补发图片，不重发文字。
- `selftest/check_history.cjs`：只读统计频道历史消息是否已入库。
- `selftest/send_history_minute.ps1`：按北京时间选定一分钟的风寻消息，仅向群二发送历史测试；须传入预期条数，已有发送记录时拒绝重发。

颜驰、风寻、柳玉东的频道规则分别在 `../qq_channels/yanchi/`、`../qq_channels/fengxun/`、`../qq_channels/liuyudong/`。柳玉东模块处理无文字双图的展示占位词和群 1 的独立启用时间；图片按原顺序由通用发送器逐张发送。QQ 标题彩色标记只在 `core/channel_title_style.cjs` 叠加：颜驰三个频道和柳玉东使用 🟢，风寻和利润医生使用 🔵；Discord 原始消息和归档频道名不变。原 `scripts/` 下的同名命令仍是兼容入口；现有启动命令无需更改。

启动后 QQ Gateway 登录成功时，窗口逐频道打印自动转发的启用状态和目标群；1132949059 仅显示“群 2”，1130863739 仅显示“群 3”，并注明 Discord 页面仍待扫描确认。当前进程首次收到某频道的扩展上传后，另打印采集链路已收到消息；扩展可能补传旧队列，因此页面在线状态仍以扩展巡检为准。安静频道没有上传记录不能据此判定断线；已启用转发也不代表 QQ 手机端收到了消息。这些提示同时写入持久化运行日志。启动时发现状态不明的转发仍会在本地打印，私聊告警接受后记录去重，后续重启不再为同一分段重复私聊。图片上传使用 `srv_send_msg:false`，上传阶段失败可稍后重试；正式发送群消息后结果不明仍需先核对群内显示，避免重复发送。

自动转发按目标群和频道记录已成功转发的最新 Discord 发布时间。页面刷新后读到更早的消息仍会入库，但不会倒退转发；已开始发送且停在图片上传前、上传失败或限频的分段可继续重试，即使后续消息已推进转发进度。网页延迟刷新时，晚于该频道转发进度的消息仍可按时间顺序补上。指定历史测试仍走独立补发命令。

`data/qq-channel-labels.json` 现在按文件修改时间热加载：新增频道只要改这个文件，转发服务下一次读到时就会用上新名称，不必重启；整份缺标签时浮窗显示“频道 <ID>”，不再报“转发读取状态失败”。

运行中的 QQ 发送若返回结果不明，柳玉东或附加群的该条消息会隔离，不自动重试同一 Discord 消息 ID；同群后续消息继续转发。重启后仍会跳过该条并告警。请先在 QQ 群核对该条是否实际到达，再决定是否人工补发；主群其他频道仍按原规则暂停转发。

QQ 私聊告警：启动服务后，控制台会显示一次性「绑定告警 代码」。用希望接收告警的 QQ 账号私聊机器人发送完整内容。机器人会用被动回复确认绑定，并把该账号的 `user_openid` 保存在 `data/qq-alert-recipient.json`。之后群发送失败或转发器异常暂停时，服务会向该账号尝试发送一条简短私聊；告警发送失败只记录在本地日志，不会循环重试。主动私聊仍受 QQ 平台权限和用户接收设置限制，且服务自身停止时无法发出告警。

启动时还会检查发送结果未知且没有后续成功补发的记录，并尝试私聊提醒。已经成功补发的柳玉东消息不会再次触发启动告警或被自动重发。

绑定后手动验证一次主动私聊：`powershell -ExecutionPolicy Bypass -File scripts/qq/selftest/send_alert_test.ps1`。

手动保持服务运行：在自己的独立 PowerShell 窗口先运行 `powershell -ExecutionPolicy Bypass -File "C:\Users\Administrator\Documents\ChatGPT\muse\scripts\stop_discord_collector.ps1"` 停止现有隐藏实例，再运行 `powershell -NoExit -ExecutionPolicy Bypass -File "C:\Users\Administrator\Documents\ChatGPT\muse\scripts\start_discord_qq.ps1"`。保留或最小化该窗口，关闭窗口即停止服务。启动时应看到 `Discord collector server ... listening` 和 `机器人已登录 QQ Gateway`；若出现 `EADDRINUSE`，说明 8765 仍被占用。仅打开 Discord 扩展并不会启动本地服务。

采集与 QQ 转发的控制台输出会同时写入 `data/logs/collector-YYYY-MM-DD.log`，按 Windows 本地日期分文件，每行附时间。正常退出与异常退出都记录 Node 退出码；日志从下次启动服务起生效。查看最近记录可运行 `Get-Content .\data\logs\collector-$(Get-Date -Format yyyy-MM-dd).log -Tail 50`。日志可能包含消息 ID、频道名称和发送错误，按项目数据保护。

网页手动恢复：Discord 当前频道浮窗中的“历史未转发补发”从同一个 `127.0.0.1:8765` 服务查询 SQLite 归档和 QQ 发送记录，只显示当前频道配置的目标群，默认最近 20 条。群 1 接收普通频道，群 2 接收颜驰、风寻的四个频道，群 3 只接收交流频道。用户勾选后提交到 `replay_requests`／`replay_items`，由常驻转发器逐条处理；`forward_attempts` 中已有任何发送尝试的消息不会重新排队，状态不明的消息须人工核对。

当前 Discord 频道浮窗有“暂停当前频道转发／恢复当前频道转发”按钮。暂停仅停止该频道的自动 QQ 转发，网页采集和本地入库继续；其他频道照常转发。恢复时，未发送且晚于该频道转发进度的积压消息按原时间顺序处理。开关状态保存在 `data/qq-forward-controls.json`，服务重启后仍有效；手动历史补发单独控制。

“取消历史补发”只作用于当前频道和目标群的手动请求。尚未处理的条目取消；正在执行的单条消息可能完成，其余条目停止。已接受的 QQ 消息不撤回，自动转发继续运行。

柳玉东频道有图时，第一张图片与正文放在同一条富媒体消息；第二张图片单独发一条。若 QQ 明确以格式错误拒绝图文合并，转发器回退为文字加图片两条。所有群图片消息均带 `content` 字段。正文提到图片但本地归档无附件的消息不会在手动恢复中标为可发送。

主群文字发送测试：`powershell -ExecutionPolicy Bypass -File scripts/send_qq_test.ps1`

附加群文字发送测试：`powershell -ExecutionPolicy Bypass -File scripts/send_qq_test.ps1 -Additional`

颜驰、风寻历史入库检查：`node scripts/qq/selftest/check_history.cjs`

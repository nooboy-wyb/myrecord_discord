# Telegram 超时恢复与私聊告警

2026-11-27 补齐。此前巡检只自动拉起确认退出的进程，进程存活但扫描卡住时只记录 `SCAN_STATUS_STALE`，没有触发重启或 QQ 私聊。

## 采集器

- 连接限时 25 秒，授权检查、来源解析、话题验证、每次消息读取限时 30 秒，单条入库及附件处理限时 90 秒；图片下载原有 60 秒上限保留。
- 连接错误或超时后先保存异常和恢复事件，再断开旧客户端、用原有加密会话新建客户端。连续失败按 10、20、40、60 秒退避，不重新登录。
- 只有完成来源扫描、消息与图片校验后才推进该来源断点。断线重试保留原断点，已入库内容由原唯一约束去重。
- 授权、权限、存储及校验问题不会冒充网络错误触发客户端重建。
- `data/telegram/connection-recovery.json` 保存连接故障 ID、次数、发生与恢复时间；成功重扫后标记 recovered，供独立巡检通知。

## 巡检兜底

每分钟的既有任务继续执行。仅 TG 增加存活但停滞的恢复：状态超过 5 分钟未更新、连续两次巡检确认、只有一条可识别的 Python 进程链，且不存在授权或权限阻断时，进入重启流程。

停止前重新读取扫描时间，核对完整入口、数据目录、PID 与进程创建时间。扫描恢复、进程成员变化或 PID 被重用时取消停止。只处理这条 TG 进程链，停止后确认进程消失再启动。

复用原有滚动一小时最多 3 次、两次恢复至少间隔 5 分钟的持久化预算；人工暂停、身份检查失败和多实例冲突禁止恢复。健康的大量补采只要仍更新扫描进度，就不会因耗时长而重启。

## QQ 私聊

巡检调用独立的 `send_monitor_notice.ps1`，在目标 Windows 用户下解密原 QQ 凭据，复用原私聊绑定和发送模块。此链路不依赖 TG 事件循环或 QQ 群发送队列，QQ 发送器无需重新启动。

- 通知 TG 故障、连接恢复、采集恢复及自动恢复受限。两次巡检之间已发生并恢复的连接异常，也发送一次恢复说明。
- 每个故障阶段的接受状态持久化在 `data/monitor/telegram-notices.json`，不因巡检或业务重启而重复发送。未获接受时至少间隔 5 分钟重试，最多 3 次；单轮只尝试一条私聊。
- QQ 接口接受与实际手机收到分开判断；发送失败记录 `private_notice_failed`，状态包含运输失败标识或 QQ 返回的 HTTP/错误码。私聊不包含消息正文、凭据或原始错误文本。
- 角色暂停、巡检身份检查失败时不发送恢复通知。未配置 QQ 私聊绑定时在巡检状态标记跳过。

## 验证

本地运行 Telegram Python 用例、巡检状态机/外层超时/诊断包/启动器及新增恢复用例。新增 Windows 临时进程验证覆盖扫描已恢复时取消停止、确认停滞时只结束目标 Python 链；模拟传输验证私聊去重、限次和恢复通知。远端部署前在维护目录用独立临时数据复核，不使用生产数据库注入故障。

```powershell
.\data\local-validation\python\Scripts\python.exe -m unittest discover -s test -p 'test_telegram*.py'
node --test test/telegram_recovery.cjs test/service_monitor.cjs test/monitor_diagnosis.cjs test/service_monitor_supervisor.cjs test/telegram_launcher.cjs
```

## 远端部署记录

2026-11-27 北京时间 14:06 部署到 `C:\Users\MECHREVO\Documents\muse`，通过既有状态机重新拉起 TG。新 Python 链 PID 11056 → 15032 为同一个采集实例；QQ PID 15096 保持运行。

- 本地 31 项 Python、46 项 Node 验证通过；远端隔离目录 13 项 Python、7 项新增恢复验证通过。远端 Python 临时目录显式设为维护目录，避免目标环境默认临时目录不可用。
- 14:07 自动定时巡检成功，TG 为 HEALTHY，三个来源全部 ok，扫描时间持续前进，停滞计数为 0。QQ 在线，TG 待发规划无异常、没有 TG 待发积压。
- 14:07 发送一条明确标注“TG 自恢复测试”的私聊，QQ 接口返回 accepted=true，用户随后确认已收到。
- 备份与部署哈希位于 `data/maintenance/tg-recovery-20261127/`，其中 `backup/` 保存原源码与状态，`deployed-manifest.json` 记录上线文件；未重置原恢复预算。

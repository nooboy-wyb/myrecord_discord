# Telegram 登录与入库验证

采集入口是项目根目录下的 `scripts/start_telegram.ps1`，验证账号授权、频道读取、SQLite 归档和图片落盘。采集不依赖 Telegram 网页或 Desktop，也不会自动发送 QQ；单条 QQ 样例使用独立命令。

## 首次配置与登录

在目标电脑、运行采集的同一 Windows 用户下执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action Setup
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action Configure
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action Login
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action Channels
```

Configure 在终端输入 API 信息，API hash 隐藏输入；不要将凭据写进命令参数。Login 默认生成 `data/telegram/login-qr.png`，用手机 Telegram 的“设置 → 设备 → 连接桌面设备”扫码。二维码会过期并刷新，登录结束后删除。若启用了两步验证，可在目标电脑的交互终端输入密码；也可使用 `-Action Login -LoginMethod phone`，在终端输入手机号、验证码与两步验证密码。

`api.dpapi` 和 `session.dpapi` 使用 Windows DPAPI CurrentUser 加密，运行时只在内存中解密，不生成明文 `.session` 文件。只能由同一电脑的同一 Windows 用户使用，复制文件到其他电脑不能直接登录。全部运行数据位于已忽略的 `data/telegram/`，不得提交到 Git。SSH 不会复用 Telegram 网页的登录会话。

启动脚本默认读取当前 Windows 用户的系统代理，并显式配置 Telegram 的 MTProto 连接。必要时传入 `-Proxy http://127.0.0.1:端口` 或设置 `TELEGRAM_PROXY`。HTTP_PROXY/HTTPS_PROXY 本身不等于 Telegram 代理配置。Python 环境独立安装在 `data/telegram/runtime/`；Setup 可通过 `-Python` 指定已安装的 Python 3.11 或更新版本。

## 按频道验证

从 Channels 输出选择带负号的 `peer_id`，仅对已明确选择的频道读取正文：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action Probe -Channel '-1001234567890' -Limit 5
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action Probe -Channel '-1001234567890' -Limit 5
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action Watch -Channel '-1001234567890' -Seconds 60
```

上面的频道 ID 是占位示例。Probe 归档最近五条；重复执行且消息没有变化时新增版本数应为零。Watch 首次以频道当前最新消息建立起点，此后每十秒读取更新；已归档消息与进度重启后保留。Probe 不修改 Watch 起点。每轮重新核对最近二十条，捕获此范围内的编辑，并重试失败图片；不是完整历史同步或无限期后台服务。`-Seconds 0` 可持续运行，关闭终端即停止。被删除的源消息、二十条之外的历史编辑，以及账号不能访问的内容不在本阶段恢复范围内。

## 时间窗口入库与审计

`History` 一次性扫描选定频道最近 24 小时。群内指定话题使用 Telegram 原生话题查询；`-Topic` 是话题顶层消息 ID，不是另一个频道 ID。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram.ps1 -Action History -Channel '-1001234567890' -Topic 123 -Hours 24
```

以上 ID 为占位示例。不传 `-Topic` 则读取该频道或群组本身。`-Hours` 支持 1..720；`-Until '2026-11-25T13:00:00+00:00'` 固定结束时刻，窗口包含开始时刻、不包含结束时刻。时间必须带时区。History 不受 `-Limit` 影响，会翻页至早于窗口的消息或 API 返回结束，且不修改 Watch 进度。

每条源消息写入后重新核对数据库正文、时间、编辑版本、话题 ID 和内容哈希；图片核对文件存在与 SHA-256。异常中止会保留已写入的数据，审计标记失败；图片缺失或正文未写入会以非零退出，不能当作验证通过。视频、文件仍只归档元数据。

`data/telegram/audits/` 保存每次运行的独立 JSON，包含窗口、话题、源消息清单、数据库行号、内容哈希、附件状态、读取/写入/验证数量、停止边界与错误。`*-latest.json` 是最近尝试，`*-latest-success.json` 是最近成功结果。重复使用同一 `-Until` 和 `-Hours`，会比较最近成功扫描，列出新增、内容变化、源端不再返回的消息；源端变化不会删除本地原文版本。中断后的 `running` 或 `failed` 审计不能作为覆盖完成证明，可用相同窗口重跑补齐。

这是可访问内容与本地存储的一致性核验；采集之前已删除或账号无权访问的消息无法由这套接口证明或恢复。History 为单次验证，不会自动启动定时任务或 QQ 转发。

## 数据与验收

- `data/telegram/archive.sqlite`：`telegram_messages` 保存原文和编辑版本；`telegram_attachments` 保存附件状态；`telegram_channel_state` 保存 Watch 进度。
- `data/telegram/attachments/YYYY-MM-DD/`：成功下载的图片按 SHA-256 命名，保留相册 `grouped_id` 与消息 ID，供后续组合转发。
- 消息按频道 ID、消息 ID、内容哈希去重；不同频道中相同消息编号彼此独立。重新采集不会覆盖已保存的原文版本。
- 本阶段只下载图片，单张最大 25 MB，下载超时为 60 秒；视频、文件仅归档类型和大小。图片失败不删除正文，错误只记录类型，不输出正文、验证码、API hash 或会话内容。
- `Status` 的 `authorized=true` 证明会话授权；`Probe` 的读取数和 SQLite 记录证明数据访问。附件须满足 `status='saved'`、文件存在且 SHA-256 一致，才能确认原图已落盘。
- 单条文字验证可运行 `node scripts/telegram/send_qq_sample.cjs TG1 -1004472038576 13613 77695 --preview`。目标必须已绑定、没有 Discord 频道配置，消息须匹配成功话题审计且无附件。确认预览后，在内存中加载现有加密 QQ 凭据并使用 `--send`，复用 QQ 发送器及发送记录；Telegram 消息和话题使用 `telegram:` 命名空间，任何既有发送尝试均拒绝重发。该命令不启动自动转发。

运行归档、加密和时间窗口审计测试：`python -m unittest discover -s test -p 'test_telegram_*.py'`。

## 已审核历史批量发送

`send_qq_history.cjs` 从指定的汇总审计选取来源；必须通过固定窗口重复核验。先使用 `--preview`，再在内存中加载现有加密 QQ 凭据，以相同参数使用 `--send`：

```powershell
node scripts/telegram/send_qq_history.cjs TG1 selected-check-20261125T145422.json --preview -1003432435785:all -1003452957222:all -1004472038576:13613
```

按源消息时间顺序发送，标题保留频道/话题及“历史补发”，第二行显示原消息北京时间。图片先核对 SHA-256，使用现有 QQ 原图上传及发送逻辑。文字、图片共用每群至少两秒间隔；此前全部接受的源消息跳过，存在不完整或不确定发送记录时拒绝整批重试。逐条结果与 QQ 平台消息 ID 写入 `qq-forward.sqlite`，独立批次审计保存在 `data/telegram/audits/qq-history-*.json`。此命令是一次性历史发送，不启动持续采集或自动转发。

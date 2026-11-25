# Telegram 登录与入库验证

本阶段只验证账号授权、频道读取、SQLite 归档和图片落盘，不发送 QQ。入口是项目根目录下的 `scripts/start_telegram.ps1`。采集不依赖 Telegram 网页或 Desktop。

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

## 数据与验收

- `data/telegram/archive.sqlite`：`telegram_messages` 保存原文和编辑版本；`telegram_attachments` 保存附件状态；`telegram_channel_state` 保存 Watch 进度。
- `data/telegram/attachments/YYYY-MM-DD/`：成功下载的图片按 SHA-256 命名，保留相册 `grouped_id` 与消息 ID，供后续组合转发。
- 消息按频道 ID、消息 ID、内容哈希去重；不同频道中相同消息编号彼此独立。重新采集不会覆盖已保存的原文版本。
- 本阶段只下载图片，单张最大 25 MB，下载超时为 60 秒；视频、文件仅归档类型和大小。图片失败不删除正文，错误只记录类型，不输出正文、验证码、API hash 或会话内容。
- `Status` 的 `authorized=true` 证明会话授权；`Probe` 的读取数和 SQLite 记录证明数据访问。附件须满足 `status='saved'`、文件存在且 SHA-256 一致，才能确认原图已落盘。
- QQ 尚未接入 Telegram；确认频道和入库正确后再增加来源适配，共用现有 bot 和按群发送限频。

运行归档与加密测试：`python -m unittest discover -s test -p test_telegram_archive.py`。

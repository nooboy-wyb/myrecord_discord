# DC / TG / QQ 有限状态巡检（本地验证版）

2026-11-26 在本地实现并测试。本次仅通过 SSH 读取远端异常，没有部署代码、安装任务、启动或停止远端进程。此前的 `collector-watchdog-plan.md` 是交接方案，本文记录本地实现。

## 读取到的远端异常

- TG 在北京时间 2026-11-26 04:09 左右因 Telethon 连接关闭警告触发 PowerShell 异常，最后成功扫描为 04:08:57。现有提交 `a4f6c4f` 已修正启动器：保留 stderr，以 Python 实际退出码判断失败。本次复跑本地验证，不重复修改该修复。随后只读检查中 TG 已运行；这不是本次巡检启动的。
- Python 虚拟环境存在启动器和实际 Python 的父子进程。两个相同命令行的 PID 可以属于同一个实例，不能当作重复采集杀掉。
- QQ 存在明确限流、原图 HTTP 404 和历史 `unknown` 发送记录；DC 日志存在较早的频道扫描无响应记录。这些是分类依据，旧日志本身不证明目前仍故障。
- QQ 健康接口 `running` 表示当前正在执行一轮工作，空闲时为 false；不能据此判断常驻进程退出。

## 状态机及动作

`scripts/service_monitor.cjs` 每次完成一个观察、判断、执行和落盘循环，三个角色各自维护状态、预算、首次异常时间、连续失败次数和最后成功时间。默认仅观察，显式 `--recover` 才允许启动。

| 状态 | 含义与动作 |
| --- | --- |
| HEALTHY | 进程和业务信号正常；不需要新消息或新增入库才能健康 |
| DEGRADED | 进程存在但业务异常、信号陈旧，或启动器存在而业务进程缺失；记录具体异常，不杀进程 |
| SUSPECT | 首次未发现进程；等待下一轮确认 |
| STOPPED | 已确认缺失；观察模式只记录，恢复模式检查预算后拉起对应角色 |
| STARTING | 已请求启动，给 120 秒宽限；不再次启动 |
| START_FAILED | 启动调用失败，记录原因并消耗一次预算 |
| COOLDOWN | 距上次恢复不足 5 分钟，等待 |
| RESTART_LIMITED | 每角色滚动一小时已启动 3 次，停止自动恢复直到预算窗口腾出 |
| CONFLICT | 进程缺失但端口或健康接口仍存在，记录身份冲突，不启动 |
| MANUAL_REQUIRED | 进程缺失且最近业务状态显示授权或权限异常，等待人工处理 |
| PAUSED | 存在人工暂停标记，不启动 |
| INSPECTION_FAILED | 进程/端口检查失败、鉴权文件不可读；不能确认缺失，不启动 |

```mermaid
stateDiagram-v2
    HEALTHY --> DEGRADED: 业务异常
    DEGRADED --> HEALTHY: 信号恢复
    HEALTHY --> SUSPECT: 首次进程缺失
    DEGRADED --> SUSPECT: 首次进程缺失
    SUSPECT --> STARTING: 连续确认缺失且允许恢复
    SUSPECT --> MANUAL_REQUIRED: 授权或权限失败
    STARTING --> HEALTHY: 进程与业务信号恢复
    STARTING --> COOLDOWN: 宽限结束仍缺失
    COOLDOWN --> STARTING: 冷却结束且预算允许
    COOLDOWN --> RESTART_LIMITED: 达到重启上限
```

进程按本项目完整入口匹配；TG 还核对 `monitor` 参数和数据目录，并合并 Python 父子链。DC/QQ 同时检查端口归属和鉴权健康接口。识别不到准确归属时只记录冲突；不终止任何进程。

网络、限流、授权、权限、SQLite/数据、图片和发送未知分开记录，包含错误发生时间与处理建议。已有进程的网络重连、限流退避与附件重试继续由业务代码处理。`unknown` 始终标记为隔离、禁止自动重发；巡检对业务数据库只读。

DC 健康接口新增当前页面清单和报告时间、最近入库/校验错误。即使页面清单内容没变，时间也随上报更新。TG 状态新增每轮开始/结束、当前阶段、每来源进度与脱敏错误说明；补采过程中每十秒有消息进展时刷新状态，长时间无进展只提示异常，不重启活进程。

QQ 心跳从当日和前一日各最多 128 KiB 日志尾部读取 ACK；不会把发出心跳或 HTTP 响应当作 ACK。规划结果超过 5 分钟未更新会记录异常。队列记录最老来源时间、最老状态更新时间及持续观测时间；来源已过 15 分钟且待发状态长时间未变化或持续积压才提示。原表没有入队创建时间，因此持续观测时间是巡检看到的积压时长下界，不能解释为精确入队时长。

## 输出和暂停

- `data/monitor/status.json`：统一快照，原子替换。
- `data/monitor/state.json`：状态和重启预算；禁止通过删除该文件绕过上限。
- `data/monitor/events-YYYY-MM-DD.jsonl`：按北京时间日期记录异常打开、变化、解除、状态迁移、启动和退出。
- 启动产生独立 stdout、stderr 和退出结果 JSON；记录 PID、角色、启动原因、退出时间及实际退出码。请求启动只表示已创建启动器，下一轮仍检查业务进程。
- 创建 `data/monitor/pause-all` 或 `pause-discord` / `pause-telegram` / `pause-qq` 可暂停对应恢复；需要人工停止业务时先创建标记。

巡检文件锁拒绝重叠运行；预算在执行启动前落盘，巡检崩溃也不会漏记一次恢复尝试。状态文件损坏时直接失败，不能按空预算继续恢复。令牌只在内存参与 HTTP 鉴权，输出会脱敏；不记录正文、密钥或会话。

## 本地验证

```powershell
$env:MUSE_TEST_PYTHON = (Resolve-Path .\data\local-validation\python\Scripts\python.exe).Path
node --test test/service_monitor.cjs test/collector_page_status.cjs test/telegram_launcher.cjs test/collector_storage_retry.cjs test/collector_processes.cjs
.\data\local-validation\python\Scripts\python.exe -m unittest discover -s test -p 'test_telegram_monitor.py'
```

测试使用临时目录、模拟健康接口和时钟；实际子进程验证也只启动临时项目中的模拟角色。覆盖逐角色退出只启动对应角色、连续缺失确认、冷却、上限、预算持久化、授权失败、暂停、并发锁、进程身份、Python 父子链、空扫描、长补采、业务异常、日志脱敏及 `unknown` 数据不变。2026-11-26 验证：相关 Node 测试 26 项、Telegram Python 测试 28 项通过，无跳过；PowerShell 脚本语法检查通过。

Windows 实测发现 Node `detached:true` 启动隐藏 PowerShell 时可能退出但不执行脚本，因此实际恢复用隐藏的 `Start-Process` 创建包装器。本地临时项目已验证警告保留和原生退出码 0 / 7 落盘，不以仅拿到 PID 作为恢复完成。

`check_services.ps1` 是手动巡检入口，默认只观察；`-Recover` 才启动恢复。`install_service_monitor.ps1` 为后续部署准备了一分钟周期的 Windows 任务定义，本次没有执行。未来安装必须以业务凭据所属 Windows 用户执行，默认项目数据目录，交互登录会话；本地测试不能证明远端任务调度、用户注销或机器重启后的行为。

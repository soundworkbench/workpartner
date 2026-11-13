# T-1182 镜像侧实施报告

## 第 1 轮（2026-11-13）

实现已落地，未执行 git 提交；受沙箱 socket 禁令影响，完整验收尚未完成，不能标记 `tools/check.sh` 全通过。

### 1. 改了哪些文件

- `image/bin/wp-feishu-bot.py`：新增 `info [--refresh]`、`restart` 和内部 `supervise` 入口，提供脱敏机器人信息、600 秒缓存、在线状态、FIFO 局部重启和日志事件守护；脚本权限 755。
- `image/bin/start.sh`：后台启动守护进程，不加入 `service_pids`，入口退出时通知守护并等待其回收消息桥，首次实际拉起桥仍输出 `[startup] bridge-started +…ms`。
- `image/tests/feishu-bot.test.py`：新增真实本地假飞书 HTTP 服务测试及无配置、损坏配置、在线状态、无守护重启等命令行测试。
- `image/tests/feishu-bot-offline.test.py`：新增仅测试端的 HTTP 响应替身，复用真实 HTTP 测试的断言，在禁 socket 沙箱中补充验证请求内容、字段、缓存、刷新、错误、头像限制和总时限。
- `image/tests/feishu-supervisor.test.py`：新增假 cc-connect 调用级测试，覆盖迟到配置、重启换 PID、事件过滤、清空旧状态、崩溃退避、60 秒上限、稳定 5 分钟重置和 TERM 回收。
- `image/tests/init-hooks.test.py`：让启动集成夹具执行真实守护进程，将旧的“桥退出导致容器退出”断言改为桥自动重启、入口保持运行，并新增入口 TERM 回收桥的测试。
- `docs/tasks/T-1100/T-1182-feishu-bot-image/plan.md`：记录实现步骤及关键选择。
- `docs/tasks/T-1100/T-1182-feishu-bot-image/report.md`：追加本轮实施与验证结果。

实现说明：

- 默认读取 `/data/.cc-connect/config.toml`，运行文件位于 `/data/.cc-connect/run/`；`WP_CC_CONNECT_DIR` 可重定向临时测试目录，`WP_FEISHU_API_BASE` 按约定覆盖飞书 API 地址。
- `bot-cache.json` 按 appId 索引，每项仅有 `name`、头像 data URL、`activate`、`at`，以 600 权限原子替换；失败结果不缓存，`--refresh` 忽略旧缓存。
- 每次 HTTP 请求最多 3 秒，所有项目共用 7.5 秒网络预算，为命令启动和最终 JSON 输出留出余量；计时器同时限制 DNS、读取和持续滴流。
- `bridge.pid` 保存实际桥 PID，`bridge-state.json` 只保存事件枚举和 ISO8601 时间；新启动先清空事件，原始 stdout/stderr 继续转发到容器日志。
- 采用 `restart.fifo` 通知守护：FIFO 权限 600，与镜像用户 uid 1001 一致；非阻塞写入，没有读端时返回 `no_supervisor`，不依赖直接向 PID 发信号。
- 守护每 3 秒检查未出现的配置，异常退出按 2、4、8、16、32、60 秒重试；重启请求打断退避，稳定运行至少 300 秒后的退出恢复 2 秒退避。
- 多 projects 会输出多个机器人，复用 appId 元数据缓存；本次所有条目的在线状态来自同一个 cc-connect 进程及其全局日志事件，不声称可识别多个机器人的独立连接状态。
- 独立审查发现 HTTP 协议异常可能导致 traceback，已补 BadStatusLine 失败复现并修正；API 协议异常返回 `feishu_unreachable`，头像协议异常仅令头像为 null。

### 2. 怎么验证的

| 命令 | 最终结果 |
| --- | --- |
| `python3 image/bin/wp-feishu-bot.py info` | 退出码 0；stdout 恰为 `{"ok":true,"bots":[]}` 一行。 |
| `python3 -I -B image/tests/feishu-bot.test.py CommandTest` | 3 项通过，覆盖无配置/不可读配置、全部 online 分支及损坏状态、无守护重启。 |
| `python3 -I -B image/tests/feishu-bot-offline.test.py` | 7 项通过，含正确字段、缓存命中不请求、600 秒过期、refresh、多 projects、鉴权失败/不可达/协议异常、损坏缓存、头像 64KB 边界/类型/协议错误、4 项目慢请求在 8 秒内结束。 |
| `python3 -I -B image/tests/feishu-supervisor.test.py` | 5 项通过，约 16 秒；真实子进程/FIFO/文件测试，60 秒上限和 300 秒稳定窗口使用测试端虚拟时钟，无生产测试开关。 |
| `python3 -I -B image/tests/init-hooks.test.py` | 20 项通过；确认桥崩溃不会退出入口，网页/relay 退出仍退出入口，TERM 回收桥。 |
| `python3 -I -B image/tests/bridge-defaults.test.py` | 12 项通过。 |
| `python3 -I -B image/tests/image-inputs.test.py` | 6 项通过。 |
| `python3 -I -B image/tests/model-defaults.test.py` | 7 项通过。 |
| `python3 -I -B image/tests/skills.test.py` | 9 项通过。 |
| `python3 -I -B image/tests/srv-link.test.py` | 5 项通过。 |
| `python3 -I -B image/tests/feishu-bot.test.py` | 3 项非网络测试通过；7 项真实 HTTP 测试在服务创建阶段均受 `PermissionError: [Errno 1] Operation not permitted` 阻断，未跳过或伪报通过。 |
| `bash tools/check.sh` | 两次执行，均完成前置 JavaScript/Python/Bash 语法检查，随后在已有 `tools/wp-seed.test.py::ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 创建本地 HTTP socket 时因同一 EPERM 退出 1，后续全仓测试未执行。 |
| `git diff --check`、`bash -n image/bin/start.sh` | 通过。 |
| `rg -n 'app_secret\|tenant_access_token\|print\(\|json.dump\|atomic_json\|log_chunk' image/bin/wp-feishu-bot.py` | 审查所有新增输出/落盘路径：密钥仅参与配置读取、内存 token 和认证请求，不写入结果、缓存或新增日志；测试同时断言 stdout/stderr/cache 不含夹具 secret/token。 |
| `command -v shellcheck` | 当前环境未安装，未自行安装，无法完成 shellcheck。 |

本轮可执行的上述测试共 74 项通过。真实 HTTP 测试仍需在允许本地监听的环境执行；响应替身只提供补充证据，不能代替真实传输验证。最终完整检查日志位于本会话 `/tmp/T-1182-check-final.log`，真实 HTTP 测试日志位于 `/tmp/T-1182-http.log`。

### 3. 需要协调者处理的事

1. 在允许本地 TCP socket 的环境重跑 `python3 -I -B image/tests/feishu-bot.test.py` 和 `bash tools/check.sh`，完成“全通过”验收；若可用，再运行 `shellcheck image/bin/start.sh`。当前沙箱连 TCP socket 创建、Unix socket bind/socketpair 都禁止，未尝试提权或绕过权限。
2. 与 T-1183 合并后，网关调用既定命令 `python3 /opt/workpartner/bin/wp-feishu-bot.py info` / `restart`；现有网关的 `runtime.restart(slug)` 仍由 T-1183 移除，本任务没有改动它。
3. 尚未构建实际镜像，也未以真实飞书机器人或容器 uid 1001 做端到端验证；本地集成测试验证了同用户文件权限、入口及进程生命周期。
4. 没有新增依赖，没有安装软件，没有越界修改；`gateway/`、`image/bin/feishu-onboard.py`、`image/rebrand/` 和 Dockerfile 均未改动。
5. 仓库现有 `.git/info/exclude` 排除了 `docs/tasks/`，因此报告和计划文件已写入磁盘，但不会出现在普通 `git status` 中；若协调者需要纳入后续提交，需自行显式加入。

## 第 2 轮（2026-11-13）

本轮完成两项必改和五项建议，未提交 git、未新增依赖。当前沙箱仍禁止创建 socket，真实 HTTP 和全仓验收需协调者在允许 socket 的环境完成。

### 1. 改了哪些文件

- `image/bin/wp-feishu-bot.py`：移除全局 umask；状态/PID 写入及 PID 删除失败只报警；主循环异常脱敏记录后退避继续；DNS 使用守护线程限时解析；分别转发和解析 stdout/stderr；默认固定桥可执行路径，并收紧 SDK 事件匹配。
- `image/tests/feishu-supervisor.test.py`：改用 `WP_CC_CONNECT_BIN` 指定假桥，新增 umask/私密权限、状态和 PID 路径被目录占用、意外循环异常恢复、默认绝对路径测试；扩展双通道转发和精确事件/普通消息过滤断言，共 10 项。
- `image/tests/feishu-bot.test.py`：保留全部真实 HTTP 测试，强化认证请求路径和 appId 校验，新增 DNS 卡死总预算测试及 DNS 守护线程实际请求 HTTP 的测试，共 12 项。
- `image/tests/feishu-bot-offline.test.py`：删除；其七组用例原本继承自 `feishu-bot.test.py::ApiTest`，字段、缓存/过期/刷新、多项目、错误/脱敏、损坏缓存、头像限制/协议错误和总时限断言均已保留在真实 HTTP 测试中。
- `image/tests/init-hooks.test.py`：通过 `WP_CC_CONNECT_BIN` 指向集成夹具中的假桥，继续验证真实守护进程与入口生命周期。
- `docs/tasks/T-1100/T-1182-feishu-bot-image/report.md`：追加第 2 轮修复与验证记录；`start.sh` 保留上一轮改动，本轮无需再改。

实现要点：

- 守护不改变调用方 umask；假桥实测继承启动时的 `022`。运行目录显式限制为 `0700`，缓存/状态/PID 仍由 `mkstemp` 创建为 `0600`，FIFO 和锁显式使用 `0600`。
- `bridge-state.json` 和 `bridge.pid` 写入失败不会触发桥清理或守护退出；PID 删除失败也只报警，避免启动、退出及重启路径再次被同一故障阻断。主循环对意外异常按 1、2、4…最多 60 秒退避，成功一轮后复位，等待期间响应 TERM。
- 每次 HTTP 请求的 3 秒预算同时涵盖 DNS 和传输；解析在 daemon 线程执行，join 仅等待剩余预算，退出不等待卡死的 DNS 线程。urllib 的代理和重定向也经过限时解析入口；计时器限制连接/读取及持续滴流。所有项目仍共用 7.5 秒预算，留出命令启动和输出时间。本段替代上一轮“计时器同时限制 DNS”的描述。
- stdout、stderr 使用独立管道和独立半行缓冲，分别原样转发到相同输出通道；两路均过滤用户列出的四种 SDK 原文片段，普通 `connected` / `reconnecting` 行不会改变状态。
- 默认执行 `/opt/workpartner/bin/cc-connect`，不再按 PATH 查找；测试可用 `WP_CC_CONNECT_BIN` 覆盖。

### 2. 怎么验证的

| 命令 | 结果 |
| --- | --- |
| `python3 -I -B image/tests/feishu-supervisor.test.py` | 10 项通过，约 24 秒；目录占用故障下验证桥存活、SIGKILL 后自动换 PID、`restart` 换 PID、恢复写入和 TERM 回收；另验证 umask、权限、双通道、事件过滤、异常兜底及原有退避规则。 |
| `python3 -I -B image/tests/init-hooks.test.py` | 20 项通过，约 10 秒；网页/relay 退出语义、桥独立重启和入口 TERM 回收保持有效。 |
| `python3 -I -B image/tests/feishu-bot.test.py CommandTest` | 4 项通过；包括四项目共享预算，实际进入三个卡死的解析线程，命令在 8 秒内返回全部 `feishu_unreachable`。 |
| `python3 -I -B image/tests/feishu-bot.test.py CommandTest.test_blocked_dns_obeys_total_deadline` | 单独通过，约 7.6 秒；解析替身每次休眠 60 秒且记录调用，确保测试确实走到 DNS，而非因沙箱 socket 拒绝提前返回。 |
| `python3 -I -B image/tests/feishu-bot.test.py` | 4 项非网络用例通过；8 项真实 HTTP 用例在创建服务 socket 时全部受 `PermissionError: [Errno 1] Operation not permitted` 阻断，未跳过。 |
| `bash tools/check.sh` | JavaScript/Python/Bash 语法检查通过，随后在已有 `tools/wp-seed.test.py::ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 的 socket 创建处受同一 EPERM 阻断，退出 1，不能标记全通过。 |
| `python3 image/bin/wp-feishu-bot.py info` | 无配置时 stdout 为 `{"ok":true,"bots":[]}` 一行，正常退出。 |
| `git diff --check`、`bash -n image/bin/start.sh`、改动 Python 文件的 AST/尾随空白检查 | 通过；另确认离线测试文件已删除。 |
| `rg -n 'app_secret\|tenant_access_token\|print\(\|json.dump\|atomic_json\|warn\(' image/bin/wp-feishu-bot.py` | 复核输出和落盘路径；新增警告只包含固定文件名/操作或异常类型，不打印异常原文、密钥、token；缓存仍仅存机器人元数据和时间。 |
| `command -v shellcheck` | 未安装，未自行安装。 |

本轮可执行用例共 34 项通过（单独重跑的 DNS 用例不重复计数）。日志位于 `/tmp/T-1182-round2-{supervisor,init,command,http,check}.log`。

### 3. 需要协调者处理的事

1. 在允许 socket 的环境运行 `python3 -I -B image/tests/feishu-bot.test.py`（应为 12 项，含 8 项真实 HTTP）和 `bash tools/check.sh`；如有 shellcheck，再运行 `shellcheck image/bin/start.sh`。
2. 没有新增依赖、安装软件、越界改动或 git 提交。`gateway/`、`image/bin/feishu-onboard.py`、`image/rebrand/` 和 Dockerfile 均未改动；没有新增离线 HTTP 替身文件。
3. 本轮未构建镜像或连接真实飞书；容器 uid 1001 与真实飞书端到端验收仍需部署环境执行。报告目录仍被既有 exclude 排除，报告已追加到磁盘。

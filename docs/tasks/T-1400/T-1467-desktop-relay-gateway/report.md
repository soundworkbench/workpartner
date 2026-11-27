# T-1467 网关与容器侧实现报告

已实现阶段 2 网关中继、内网 MCP 和 Claude Code 注册。未修改 `desktop/`、接口契约或 npm 依赖清单。`desktop.enabled` 默认仍为 `false`。

**验收状态：实现和测试已补齐，但完整环境验收尚未通过。** 当前执行沙箱禁止创建监听 socket（TCP 回环与 Unix socket 均返回 `EPERM`），因此不能把内存传输验证宣称为真实网络验收通过。

## 修改文件

| 文件 | 修改内容 |
| --- | --- |
| `gateway/desktop-relay.mjs`（新增） | v1 WS 握手、hello/state/RPC、25 秒 ping/60 秒存活期限、5 秒 hello 期限、设备注册与顶替、准入复核、并发限制、超时/取消、元数据审计、关闭清理。 |
| `gateway/desktop-tools.json`（新增） | 从契约第 5 节提取的四个工具描述与完整输入 Schema。 |
| `gateway/desktop-tools.mjs`（新增） | 参数校验、标准中文错误、MCP 结果包装、按设备平台执行的词法路径预检和敏感路径拦截。 |
| `gateway/desktop-mcp.mjs`（新增） | 无状态 MCP HTTP：容器身份、256 KiB 请求限制、initialize/通知/ping/tools、取消传递、固定安全响应头。 |
| `gateway/desktop-auth.mjs` | 导出复用当前用户列表及动态策略的准入检查，保留原令牌签发/验签/撤销语义。 |
| `gateway/gateway.mjs` | 提前初始化鉴权与中继；把 onRevoke 接入中继；在普通网页升级路由前识别桌面 WS；保留预览隔离和迁移顺序；公网 MCP 固定 404；启用桌面时支持有界优雅退出。 |
| `gateway/services.mjs` | 接入 organizationData/desktopRelay；Docker 也启动内部监听；桌面启用时补发、续写容器令牌（0600）；内部挂载 MCP。 |
| `gateway/organization/resolve.mjs` | 导出 PARTNER_INTERNAL_ORIGIN。 |
| `image/bin/wp-mcp-config.py` | names[] 多托管项、兼容旧 name、两类 headersHelper、独立冲突检测、清理和幂等；保留个人条目的原始字节及 CRLF；两个引擎均先校验再原子替换各文件。 |
| `image/bin/wp-desktop-mcp-headers.py`（新增） | 固定读取 `/data/.zp-market-token`；严格校验；失败静默非零退出；仅 stdout 输出 Header。 |
| `image/bin/wp-mcp-start.mjs` | 保留 Hub 探活；按桌面开关与合法内部地址注册桌面 MCP，不依赖令牌文件或桌面在线状态；桌面仅接 Claude Code。 |
| `image/bin/start.sh` | 在 MCP 配置及应用启动前完成发布文件链接与初始化 hooks。 |
| `image/home/CLAUDE.md` | 在受管理说明块内添加本机工具调用与离线处理的三行规范，以便现有容器同步。 |
| `gateway/tests/desktop-relay.test.mjs`（新增） | 16 项协议/安全/入口测试，内置模拟桌面客户端，不引用 desktop/。 |
| `tools/desktop-mcp-config.test.mjs`（新增） | 5 项多托管配置、启动组装、凭据 helper 与默认关闭测试。 |

## 第 8.1 节覆盖对应

以下均指测试代码覆盖；实际运行方式与环境限制见下一节。

| 验收条目 | 覆盖 |
| --- | --- |
| 有效/过期/伪造 wpd、zpd/无头/网页 Cookie 拒绝 | `handshake accepts only valid desktop bearer…`，另外拒绝 URL 查询传凭据。 |
| 426、400、4004、hello 超时 | `handshake…`、`hello deadline…`；检查版本响应头、UUID、无首帧、非法首帧、二进制帧。 |
| 同人路由、跨用户隔离 | `same-user RPC…`、`all three filesystem tools…`，同时从 MCP 容器令牌入口验证隔离。 |
| migration.forward | `migration.forward transparently upgrades…`，使用真实迁移模块、两端网关与 WS 帧转发。 |
| 心跳踢断与释放 inFlight | `heartbeat pings…`；验证 pong、有效业务帧续期、无响应踢断及在途请求失败。计时器采用可注入短周期，hello_ack 仍核对契约 25/60 秒值。 |
| 同 deviceId 顶替 4002、超过 5 台 429 | `same-device replacement…`；在新 hello 合法之前旧连接仍可用，并为尚未 hello 的不同设备保留名额防止并发握手越过上限。 |
| revoke-all 4001 | `revoke-all immediately closes…`，实际调用 desktop-auth HTTP 接口，核对多设备关闭、在途失败及其他用户不受影响。 |
| 4003、代次与过期复核 | `admission changes…`；覆盖移出 allow、关闭 enabled、删除用户，以及定时复核和调用前复核。 |
| 离线 <50ms、断线、超时取消 | `same-user RPC…`、`disconnect fails immediately…`，断言延迟、rpc_cancel(timeout/caller_aborted) 和错误码。 |
| 指定设备→首选→最近活跃 | `routing uses explicit ID…`；核对 state_update、返回设备名、在线总数与路由元数据。 |
| 4/8 并发与 1 MiB | `concurrency limits…`；验证其他用户的请求仍可执行，超限帧关闭并释放在途请求。 |
| 离线 MCP 生命周期与 Schema | `offline MCP handshake…`，包含 initialize、通知 202 空体、ping、tools/list、鉴权与 413。 |
| 公网 /desktop-mcp 404、默认关闭 | `real gateway mounts MCP only internally…`；导入真实 gateway.mjs 并捕获其 HTTP/upgrade handlers，核对公网 404、关闭时不启动内部监听且 WS 返回 404。 |
| 三个文件工具桌面执行 | `all three filesystem tools…`；核对 rpc_req 参数、15/20 秒期限与返回设备元数据。list_devices 直接读网关内存。 |
| 错误与审计红线、.env* | `path/parameter prechecks…`、`shutdown cancels…`；检查目录边界、Windows 路径、敏感路径、原始错误文本过滤、畸形错误码/过深 JSON 的安全失败，以及审计字段白名单。 |
| 关闭取消和 1001 | `shutdown cancels…`；核对 gateway_shutdown 取消、连接关闭和注册表清空。 |
| Hub/Desktop 共存、保留字节、旧记录迁移 | 配置测试 `multiple managed MCPs coexist…`；包含 CRLF、个人 MCP 原文、0600、幂等和禁用清理。 |
| 同名冲突、无令牌启动、headersHelper | 配置测试 `each name collision…`、`assembled startup…`、`desktop headersHelper…`；校验失败不修改两个引擎、不输出敏感原文。 |

## 实际验证结果

先执行了 `systemd-run --scope -q -p MemoryMax=4G -- true`，scope bus 不可用；按任务要求直接运行后续命令。

本地没有已安装的项目依赖，离线缓存未命中且 npm 网络解析失败。使用本机已有、与锁文件完全一致的 `ws 8.21.3`、`semver 7.8.5` 复制到被忽略的 `gateway/node_modules/`。未增加依赖或更改锁文件。

沙箱还会导致 Node 子进程标准输入管道操作返回 EPERM。因此在 `/tmp` 准备了两个**不属于交付代码**的验证适配器：

- `/tmp/wp-desktop-stdio-preload.mjs`：仅把 spawnSync 的输入/输出管道改为临时文件；不改变业务代码。
- `/tmp/wp-desktop-test-preload.mjs`：上述适配，加内存 Duplex socket 对及 HTTP transport；仍执行真实 HTTP/WS 协议解析、鉴权和迁移模块，但不创建内核网络监听。

| 命令/检查 | 结果 |
| --- | --- |
| `node --test gateway/tests/desktop-relay.test.mjs` | 受监听 EPERM 阻断；不能计为通过。 |
| `node --import /tmp/wp-desktop-test-preload.mjs --test --experimental-test-isolation=none gateway/tests/desktop-relay.test.mjs` | 内存传输下 16/16 通过；最后的参数/异常处理调整另有针对性复测通过。 |
| `node --test tools/desktop-mcp-config.test.mjs` | 原始子进程管道受限，未获得完整通过结果。 |
| 同上配置测试，使用 stdio preload 与 `--experimental-test-isolation=none` | 5/5 通过，包含实际 Python helper 和实际组装后的启动脚本。 |
| `node --test gateway/tests/desktop-auth.test.mjs`；另用 `--experimental-test-isolation=none` 查看逐项结果 | 16/16 通过。 |
| `tools/mcp-hub.test.mjs`，stdio preload、无进程隔离 | 5 项通过，6 项均被监听 EPERM 阻断；其中托管配置兼容性、幂等、冲突和原有 headersHelper 通过。 |
| `gateway/tests/*.test.mjs`，stdio preload、无进程隔离 | 326 项中 284 项通过，42 项失败均为 `listen EPERM: operation not permitted 127.0.0.1`；其中 15 项是新增网络测试，27 项是既有网络测试。未发现其他失败类型。 |
| `tools/organization-resolve.test.mjs`，单独运行、stdio preload | 14/14 通过。 |
| `tools/contracts.test.mjs`，单独运行 | 3/3 通过。两个文件必须分别运行，避免无进程隔离时既有测试修改共享默认值造成互相污染。 |
| `python3 -I -B image/tests/agents.test.py` | 25/25 通过，覆盖托管说明同步。 |
| `bash tools/check.sh` | JS/Python/shell 语法阶段通过；在已有 `tools/wp-seed.test.py` 创建本地 HTTPServer 时被 PermissionError/EPERM 阻断，完整基线未通过。 |
| `git diff --check` 与最终修改模块语法检查 | 通过。 |
| 修改代码定向防泄漏检查 | 15 个代码文件，凭据字面量、私网 IPv4、非示例邮件地址零命中；新加入的端点和身份均为中性测试占位。仓库没有找到独立的组织专用防泄漏扫描入口，不能把此结果扩称为该扫描已执行。 |

仍需在允许本地监听及标准子进程管道的 CI 环境执行任务要求的原始测试命令和完整 check.sh；真实桌面端联调仍按契约 8.3 进行。

## 契约边界与疑问

1. 未修改契约语义。重连退避、休眠唤醒与客户端降级展示属于桌面端；网关按契约返回握手状态、版本区间和 close code，供另一团队实现这些行为。
2. 契约未明确“网关以 desktop.enabled=false 启动后，运行中改为 true”是否必须热创建内部监听。当前沿用现有服务启动模式：首次开启需要重启网关；已启用的网关会实时拒绝被撤销准入的新握手，在工具调用前及每 60 秒复核在线连接。运行中关闭与移出名单无需重启。
3. 并发握手期间为不同 deviceId 临时保留五设备名额，hello 超时/失败即释放；同 deviceId 重连不占新名额。正式在线表仍只在合法 hello 后写入。
4. 第 4.3 节引用“第 10 节待拍板问题 3”是已定稿前的表述；按第 10 节已定事项仅接 Claude Code，无需改变契约内容。

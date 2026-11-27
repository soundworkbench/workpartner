# T-1467 桌面客户端阶段 2：网关与容器侧实现（gateway/、image/、tools/）

## 背景
桌面客户端阶段 2 要让网页对话里的 AI 通过用户电脑上的桌面客户端，只读访问用户授权的本机目录。接口契约已定稿，就在本分支的 `docs/desktop-relay.md`（781 行，第 10 节 5 个问题已定）。桌面端（`desktop/`）由另一个团队在别的 PR 实现，**本任务不改 `desktop/`**。

## 要做什么
严格按 `docs/desktop-relay.md` 实现网关与容器侧，契约和现有代码冲突时以契约为准，契约没写的按现有代码风格最小实现。重点：
1. **第 0 节代码差异表**：调整网关初始化顺序；在 HTTP `upgrade` 处理里拦截 `/_wp/desktop/ws`；3091 内部端口在 Docker 模式下也要启动；`.zp-market-token` 尚未生成时的兜底。
2. **第 2、3 节**：复用现有桌面凭据（`wpd.` 令牌）与 `desktop.enabled` / `desktop.allow` 准入；`WSS /_wp/desktop/ws` 握手、close code、hello / hello_ack / state_update / rpc_req / rpc_res / rpc_cancel、25 秒 ping / 60 秒无 pong 踢断、退避约定、多设备路由（指定 device_id → 首选 → 最近活跃）、单设备 4 / 单用户 8 并发、1 MiB 帧上限、每人最多 5 台设备、同 deviceId 顶替（4002）、`POST /_wp/api/desktop/revoke-all`（4001）、移出名单或关闭开关踢断（4003）、多网关迁移时 `migration.forward` 透明转发 WS 升级。`allowedRoots` 只存网关内存。退出登录默认只退出当前设备。
3. **第 4 节**：内网 MCP 服务 `POST :3091/desktop-mcp`（公网端口访问返回 404）；容器侧认证与凭据保护；`wp-mcp-config.py` 支持多个托管 MCP（`workpartner-hub` 与 `workpartner-desktop` 共存，用户手写的 MCP 字节原样保留、重名冲突保护、幂等）；新增 `wp-desktop-mcp-headers.py`（headersHelper，文件缺失或格式非法时静默非零退出、不回显内容）。容器侧先只接 Claude Code。
4. **第 5 节**：`desktop_list_devices` 由网关直接响应；其余 3 个工具转发到桌面端执行。网关侧不读本机文件，也不做第二次路径判断以外的事，按 5.5(1) 的责任划分来。
5. **第 6 节错误码、第 7 节审计**：错误码照表；审计只记元数据，第 7.2 节红线（令牌、文件内容、路径存在性、环境变量、堆栈）一律不进日志也不进错误消息。`.env*` 一律拦截（网关能判断的地方也拦）。
6. **第 9 节版本兼容**：协议版本 1，按 9.2 降级。

## 验收（第 8.1 节全部）
- `node --test gateway/tests/desktop-relay.test.mjs` 全过，覆盖 8.1 第一项列出的每一条（握手鉴权、426/400/4004、跨用户隔离、migration.forward、心跳踢断释放 inFlight、4002 顶替、超 5 台 429、revoke-all 4001、4003、离线 <50ms 返回 DEVICE_OFFLINE、执行中断线 DEVICE_DISCONNECTED、超时 rpc_cancel + TOOL_TIMEOUT、多设备路由、并发与帧上限、桌面离线时 MCP initialize / tools/list 正常、公网 /desktop-mcp 404）。测试里用内置的模拟桌面端客户端，不依赖 `desktop/`。
- `node --test tools/desktop-mcp-config.test.mjs`、既有 `tools/mcp-hub.test.mjs`、`gateway/tests/desktop-auth.test.mjs` 全过，覆盖 8.1 第二项每一条。
- `bash tools/check.sh` 全过；开源防泄漏扫描零命中（这是公开仓：不得出现公司域名、内网地址、人名、账号、凭据）。
- 既有 gateway 测试不回归。
- `desktop.enabled` 默认关闭；关闭时行为与现在完全一致（不起 WS 路由、不注册 workpartner-desktop MCP 或注册后返回明确的未开启错误，按契约）。

## 规矩
- 只改 `gateway/`、`image/`、`tools/` 及必要的 `docs/`（契约若发现错漏，单独列在汇报里，不要擅自改契约语义）。不改 `desktop/`。
- 不新增 npm 依赖（网关只允许 ws、semver）；确需新增在汇报里说明理由。
- 内存安全：跑测试用 `systemd-run --scope -q -p MemoryMax=4G -- <命令>`（不可用时直接跑）。
- 汇报：改了哪些文件、每条验收怎么覆盖、跑了哪些测试和结果、契约里发现的疑问。

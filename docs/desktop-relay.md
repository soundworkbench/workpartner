# 阶段 2 接口契约：网关中继、容器 MCP 接入与本机只读文件工具

> 状态：设计契约（供网关/容器侧与桌面端并行开发）  
> 协议版本：`v1`  
> 基准代码：`main`（提交 `ec660fb`）  
> 适用仓库：公开仓 `gateway/`、`image/`、`desktop/`

本契约定义工作伙伴桌面客户端阶段 2 的跨端接口与安全边界，使**网关/容器侧**（`gateway/`、`image/`）与**桌面端**（`desktop/`）能够基于同一份协议并行实现与独立测试（桌面端开发期使用按本契约实现的 Mock Gateway 自测，不阻塞于网关部署）。

---

## 0. 基准代码核实与前期规划差异说明

对照当前 `main`（`ec660fb`）源码重新核实，以下事实与前期设计草稿存在差异，**阶段 2 实现一律以当前代码和本契约为准**：

| 模块 / 文件 | 核实后的当前代码事实 | 对阶段 2 实现的影响 |
| --- | --- | --- |
| `gateway/desktop-auth.mjs`（261 行） | 阶段 1 已完成与 `features.myKey` 的解耦：仅 `GET /_wp/api/desktop/key`（`:218-240`）校验 `allowKey`（`:157-159`），其余 4 个接口仅校验 `desktop.enabled && desktop.allow`（`:80`）。模块已支持 `onRevoke` 回调（`:62, :251`），并已导出 `handle.verify`（`:256`）与 `handle.authenticate`（`:257`）。 | 网关中继可直接复用 `desktopAuth.verify` / `desktopAuth.authenticate`，无需再改 `desktop-auth.mjs` 的解耦逻辑；仅需在 `gateway/gateway.mjs:150-151` 传入 `onRevoke` 回调。 |
| `gateway/gateway.mjs`（446 行） | 1. `createGatewayServices` 与 `services.listen` 在 `:123-127` 调用，而 `desktopAuth` 在 `:150-151` 创建。<br/>2. `server.on("upgrade")`（`:420-444`）中 `:429` 的 `migration.forward` 目前仅识别 `wp_sid` 和 `zpd.`（`tokenUser`），不识别 `wpd.`。<br/>3. 飞书默认回调路径为 `/_wp/callback`（`gateway/organization/default.json:8`、`gateway.mjs:267, 331`）。 | 1. 需调整初始化顺序或提供回调绑定，使 `desktopRelay` 同时接入 `desktopAuth(onRevoke)`、`services(3091)` 与 `server.on('upgrade')`。<br/>2. `/_wp/desktop/ws` 升级需在 `:429` 之前拦截，先用 `desktopAuth.authenticate(req)` 验签 `wpd.`，再把解出的 `user` 传给 `migration.forward(req, socket, user, head)`。 |
| `gateway/services.mjs`（113 行） | 1. `:55` 仅在 `(features.marketSkills \|\| organization.dataTools) && !features.feishuAuthorization` 时写入 `.zp-market-token`，且函数参数（`:15`）未传入 `organizationData`。<br/>2. `:99` 仅在 `feishu \|\| extension?.internal \|\| organization.dataTools \|\| migration.kind === 'k8s'` 时启动 3091 内部监听。 | 1. 需把 `organizationData` 与 `desktopRelay` 传入 `createGatewayServices`，在启用 `desktop` 时兜底写入 `.zp-market-token`。<br/>2. 需将 `desktopRelay` 纳入 `:99` 的监听启动条件，确保 Docker 模式下 3091 端口同样启动并挂载 `/desktop-mcp`。 |
| `gateway/organization/resolve.mjs`（287 行） | `nextEnvironment()`（`:181-211`）仅导出 `PARTNER_GATEWAY_ORIGIN`（`:192`），尚未导出 `PARTNER_INTERNAL_ORIGIN`；`default.json:90` 已有 `runtime.internalOrigin`。 | 在 `resolve.mjs:192` 旁新增 `PARTNER_INTERNAL_ORIGIN: data.runtime.internalOrigin`。 |
| `image/bin/start.sh` & `wp-mcp-config.py` & `wp-mcp-start.mjs` | 1. `start.sh:68` 执行 `wp-mcp-start.mjs` **早于** `:70-72` 的 `wp_init_hooks`（其中 `wp_link_published_files` 才把持久化目录中的 `.zp-market-token` 软链到 `/data/.zp-market-token`）。<br/>2. `wp-mcp-config.py:14, 66-81` 仅支持单个托管 MCP（`_workpartnerMcp: { "name": ... }`）。 | 1. `wp-mcp-start.mjs` 注册 `workpartner-desktop` **不得**依赖 `/data/.zp-market-token` 在注册瞬间存在；同时建议在 `start.sh` 中确认软链在服务就绪前已完成。<br/>2. `wp-mcp-config.py` 必须升级为支持多托管 MCP（`names[]`），与现有 `workpartner-hub` 共存。 |
| `desktop/`（Electron 45 + TypeScript 5.9） | 1. 采用纯 `tsc` 构建（无 Vite），授权拦截与权限回调在 `desktop/src/main/session.ts`（采用 `net.request(..., { redirect: 'manual' })` 拦截 302，不监听本地回环端口）。<br/>2. `desktop/src/main/auth.ts` 已实现 `desktop-token.enc` 加密存储及 `.revoked` 撤销标记（`:58-67, :114`），但尚未对外提供令牌读取与变更通知。<br/>3. `desktop/package.json` 尚未声明 `ws` 运行时依赖。 | 1. `DesktopAuth` 需补齐令牌读取/事件回调与外部触发撤销标记方法，供中继客户端复用。<br/>2. 桌面主进程需引入 `ws`（或支持自定义 Upgrade 请求头与控制帧 `ping`/`pong` 的 WS 客户端；浏览器标准 `WebSocket` 不支持自定义 `Authorization` 请求头）。 |

---

## 1. 范围

### 1.1 阶段 2 做什么

1. **网关中继（`gateway/`）**
   - 公网口（默认 `3090`）新增 `WSS /_wp/desktop/ws` 长连接入口：鉴权、迁移转发、在线设备注册表、心跳保活、凭据吊销/移出名单即时踢断、多设备路由。
   - 内网口（默认 `3091`，不暴露公网）新增 `POST /desktop-mcp` Streamable HTTP MCP 服务端：支持 `initialize`、`notifications/*`、`ping`、`tools/list`、`tools/call`，按同人 `unionId` 强隔离路由到桌面设备。
   - 导出容器环境变量 `PARTNER_INTERNAL_ORIGIN`，在启用桌面功能时兜底发布 `/data/.zp-market-token` 并保证 3091 内部服务启动。
2. **容器 MCP 接入（`image/`）**
   - 扩展 `image/bin/wp-mcp-config.py` 支持多个托管 MCP 共存（保留现有 `workpartner-hub` 及用户自定义配置字节不变）。
   - 新增 `image/bin/wp-desktop-mcp-headers.py`，从 `/data/.zp-market-token` 动态读取 `zpd.` 令牌并输出 HTTP Header，不落盘到 `.claude.json`，不写入进程环境变量。
   - 扩展 `image/bin/wp-mcp-start.mjs` 注册 `workpartner-desktop`，并在 `image/home/CLAUDE.md` 追加简短调用与离线处理指引。
3. **桌面端本地助手与只读文件工具（`desktop/`）**
   - 持久化 `device_id`、`ws` 中继长连接客户端（心跳、退避重连、休眠唤醒重连、窗口活跃度上报、离线/降级状态展示）。
   - 目录白名单配置（**默认空列表**）及本地设置界面（增删授权目录、查看在线状态、编辑设备名/首选设备、暂停/恢复本地助手）。
   - 本机只读文件工具：`desktop_list_dir`、`desktop_read_file`、`desktop_search_files`（`desktop_list_devices` 由网关直接响应）。
   - 完整路径防逃逸（`realpath` 校验、符号链接限制、永久敏感黑名单）与本地 JSONL 审计日志。
   - 桌面端配套 Mock Gateway 测试套件，用于并行开发期完整自测。

### 1.2 阶段 2 明确不做什么（留到阶段 3 及以后）

- **不做写文件操作**：不暴露 `desktop_write_file`、`desktop_move_file`、`desktop_trash_file`、`desktop_open_item`。
- **不做执行命令或应用脚本**：不暴露通用 Shell 执行与 `desktop_run_app_script`。
- **不做大文件直传**：不暴露 `desktop_upload_to_workspace`。
- **不做窗口截屏与无障碍树**：不暴露 `desktop_list_windows`、`desktop_capture_screen` 及系统权限拖拽引导。
- **不做本地交互式权限确认弹窗**：阶段 2 均为白名单内只读工具，白名单放行后自动执行，确认弹窗留至阶段 3。
- **不做版本更新检查接口与审计日志 UI 浏览页**：留至阶段 4。

---

## 2. 认证与准入

### 2.1 复用现有桌面凭据与准入控制

- 桌面客户端继续通过现有 PKCE 流程（`GET /_wp/desktop/authorize` → `POST /_wp/api/desktop/token` → `POST /_wp/api/desktop/refresh`）获取与续期 `wpd.<base64url({u, g, iat, exp, did})>.<hmac>` 令牌。
- 准入完全复用 `organization.json` 的 `desktop` 配置（每次请求实时重读）：
  - 仅当 `desktop.enabled === true` 且当前用户命中 `desktop.allow`（支持 `slug`、`unionId` 或 `"*"`），且用户仍在 `users.json`、令牌未过期、代次号 `g` 与 `generations.json` 一致时准入。
- 三类令牌严格隔离，互不可替代：
  - `wp_sid`：浏览器/网页壳会话 Cookie，仅访问网页与 OAuth 入口。
  - `wpd.`：桌面端专用 Bearer 令牌，用于桌面 API 与 `WSS /_wp/desktop/ws`，不能访问网页代理或内网 MCP。
  - `zpd.`：容器专用 Bearer 令牌（`/data/.zp-market-token`），用于容器访问内网 `3091` 接口（含 `/desktop-mcp`），不能访问公网桌面 WS 或桌面 API。
- **传输约束**：`wpd.` 令牌只允许放在 WebSocket 握手请求头 `Authorization: Bearer wpd.<...>` 中，**严禁**放入 URL Query 参数。

### 2.2 持久化设备身份 `device_id`

现有 `wpd.` 令牌内的 `did` 字段实际记录的是用户可变的展示名 `device_name`（最长 200 字符），不保证唯一性。阶段 2 引入独立持久化 `device_id`：

- **格式**：RFC 4122 UUID v4 小写字符串（如 `f47ac10b-58cc-4372-a567-0e02b2c3d479`）。网关校验正则为 `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`。
- **存储位置**：桌面端首次启动本地助手时生成并原子写入 `app.getPath('userData')/device-id`（文件权限 `0600`）。清空或修改目录白名单不重置 `device_id`；退出登录不重置 `device_id`。
- **设备展示名 `device_name`**：默认取 `os.hostname()`，允许用户在设置窗自定义；去除控制字符并截断至 `1..128` 个 UTF-16 码元（空白则回退为 `WorkPartner Desktop`）。

### 2.3 凭据吊销、移出名单与退出登录时的踢断机制

| 触发事件 | 网关侧动作 | 桌面端动作 |
| --- | --- | --- |
| 网页端或其他设备调用 `POST /_wp/api/desktop/revoke-all` | `desktop-auth.mjs` 原子递增 `generations.json` 中的 `g`，调用 `await onRevoke(user.unionId)`。中继立即以 Close Code **`4001`**（reason: `token_revoked`）关闭该 `unionId` 全部在线 WS 连接，清空注册表，并立即以 `DEVICE_DISCONNECTED` 结束全部在途请求。 | 收到 `4001`（`token_revoked`）后立即停止重连，清除 `desktop-token.enc` 并写入当前会话的 `.revoked` 标记（复用 `desktop/src/main/auth.ts:58-67, :114`），托盘与设置页提示「桌面登录已失效，请退出后重新登录」。 |
| 管理员关闭 `desktop.enabled`、将用户移出 `desktop.allow` 或 `users.json` | 1. 新建 WS 握手时 `desktopAuth.authenticate(req)` 失败，直接拒绝升级（HTTP `401`）。<br/>2. 对**已在线连接**：网关在每次路由 `tools/call` 前以及每 60 秒定期复核当前连接对应的 `unionId` 准入状态与代次号 `g`；若代次号变更或令牌过期则以 **`4001`** 踢断，若不再满足 `desktop.enabled && allow` 或已离开 `users.json` 则以 **`4003`**（reason: `not_admitted`）踢断。 | 收到 `4003` 后停止自动重连，托盘显示「本机助手未开通」，保留网页壳正常使用。 |
| 桌面端点击托盘「退出登录」或网页 `/_wp/logout` 导致 `wp_sid` 移除 | 收到桌面端正常关闭帧（Close Code `1000`）后立即从注册表移除该 `deviceId`，以 `DEVICE_DISCONNECTED` 结束该设备上在途请求；不影响同一用户的其他在线设备。 | 先主动以 Close Code **`1000`**（reason: `user_logout`）关闭本机 WSS、取消本地在途任务，再执行 `auth.clear()` 清理本地加密令牌与 Cookie。 |
| 桌面端用户触发「退出所有桌面设备」 | 桌面端调用 `POST /_wp/api/desktop/revoke-all`（带 `Bearer wpd.`），网关走上述 `onRevoke` 踢断全部在线设备。 | 待接口返回（或失败兜底）后关闭本机连接并清理本地凭据。 |
| 桌面端用户「暂停本地助手」或「完全退出」 | 收到 Close Code `1000` 后立即摘除在线设备，无需等待心跳超时。 | 主动发 Close Code **`1000`**（reason: `helper_paused` / `app_quit`），不触发自动重连。 |

---

## 3. 桌面端到网关的长连接

### 3.1 连接地址与 HTTP Upgrade 握手

- **地址**：`wss://<publicHost>/_wp/desktop/ws`（由 `brand.defaultGatewayUrl` 的 `https://` 替换为 `wss://` 推导；仅本地单测/Mock 环境允许 `ws://127.0.0.1:<port>/_wp/desktop/ws`）。
- **握手请求头（全部为纯 ASCII，避免中文主机名引起 HTTP 头非法）**：

| Header | 必填 | 格式 / 说明 |
| --- | --- | --- |
| `Authorization` | 是 | `Bearer wpd.<payload>.<hmac>` |
| `X-WP-Protocol-Version` | 是 | 整数字符串，阶段 2 固定为 `"1"` |
| `X-WP-Device-Id` | 是 | 持久化 UUID v4，必须与首帧 `hello.deviceId` 一致 |
| `X-WP-Platform` | 否 | `darwin` / `win32` / `linux` |
| `X-WP-App-Version` | 否 | 语义化版本号，如 `0.3.0` |

> UTF-8 设备名称 `deviceName` 不放 HTTP 头，统一在建连首帧 `hello` JSON 中传递。

- **网关 Upgrade 处理顺序（`gateway/gateway.mjs`）**：
  1. 保留现有 `migration.forward(req, socket, null, head)` 与 `previewHost` 分流及防跨站 `previewHost` Origin 检查。
  2. 匹配 `url.pathname === '/_wp/desktop/ws'`；校验 `Host` 属于当前网关允许的主机名（与 HTTP 入口 `:325-328` 对齐）。
  3. 校验 `X-WP-Protocol-Version`（缺失时按 `"1"` 兼容处理）；若不合法或不在支持范围，返回 HTTP **`426 Upgrade Required`**（附 `X-WP-Min-Protocol-Version: 1`、`X-WP-Max-Protocol-Version: 1`）并关闭 socket。
  4. 校验 `X-WP-Device-Id` 格式；非法返回 HTTP **`400 Bad Request`**。
  5. 调用 `desktopAuth.authenticate(req)` 验签 `wpd.` 并检查准入；失败返回 HTTP **`401 Unauthorized`**。
  6. 调用 `migration.forward(req, socket, auth.user, head)`：若该用户归属对端网关，透明转发 WS Upgrade 到对端，确保助手与本人容器落在同一归属网关。
  7. 校验单用户在线设备数上限（新 `deviceId` 使在线数超过 **5 台** 时返回 HTTP **`429 Too Many Requests`**；同一 `deviceId` 重连属于顶替，不受上限阻拦）。
  8. 通过 `ws` 的 `WebSocketServer({ noServer: true, maxPayload: 1048576 })` 完成 `handleUpgrade`。
  9. 握手成功后启动 **5 秒 `hello` 超时定时器**；在收到合法 `hello` 并回复 `hello_ack` 后才正式写入在线设备注册表。

### 3.2 WebSocket Close Codes 约定

| Close Code | Reason 示例 | 发起方 | 客户端处理策略 |
| --- | --- | --- | --- |
| `1000` | `user_logout` / `helper_paused` / `app_quit` | 桌面端 | 正常关闭，不重连 |
| `1001` | `server_shutdown` | 网关 | 按退避策略重连 |
| `1009` | `message_too_big` | 网关/桌面 | 记错误日志，按退避重连（禁止重发超限帧） |
| `4001` | `token_revoked` | 网关 | **停止重连**，清除凭据并写 `.revoked`，提示重新登录 |
| `4001` | `token_expired` | 网关 | 尝试**最多 1 次** `POST /_wp/api/desktop/refresh`；成功则重连，失败则写 `.revoked` 并停止重连 |
| `4002` | `replaced_by_new_connection` | 网关 | 被同 `deviceId` 新连接顶替，**旧连接实例不得重连** |
| `4003` | `not_admitted` | 网关 | **停止重连**，状态切换为「本机助手未开通」 |
| `4004` | `hello_timeout` / `invalid_hello` / `unsupported_protocol` | 网关 | `unsupported_protocol` 停止重连并提示升级；其余按退避重连 |
| `4008` | `heartbeat_timeout` | 网关 | 按退避策略重连 |

### 3.3 消息格式（JSON 文本帧，UTF-8）

所有业务消息均为 JSON 对象，顶层必须含字符串字段 `type`。二进制帧一律拒绝（网关/客户端直接以 `4004` 关闭）。

#### (1) `hello`（桌面端 → 网关，建连后 5 秒内必发）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `"hello"` | 是 | 固定值 |
| `protocolVersion` | integer | 是 | 阶段 2 为 `1` |
| `deviceId` | string | 是 | UUID v4，必须与握手头 `X-WP-Device-Id` 完全一致 |
| `deviceName` | string | 是 | UTF-8 设备显示名，1..128 字符 |
| `platform` | string | 是 | `"darwin"` / `"win32"` / `"linux"` |
| `arch` | string | 是 | 如 `"arm64"` / `"x64"` |
| `appVersion` | string | 是 | 客户端版本号，如 `"0.3.0"` |
| `capabilities` | string[] | 是 | 已启用的能力集，阶段 2 固定为 `["fs.read"]` |
| `allowedRoots` | string[] | 是 | 规范化后的白名单目录路径数组（默认 `[]`，最多 32 项，每项 ≤ 1024 字符；网关仅存内存，不落盘、不写日志） |
| `preferred` | boolean | 否 | 是否被用户设为首选设备，默认 `false` |

示例：
```json
{
  "type": "hello",
  "protocolVersion": 1,
  "deviceId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "deviceName": "Work-Laptop",
  "platform": "darwin",
  "arch": "arm64",
  "appVersion": "0.3.0",
  "capabilities": ["fs.read"],
  "allowedRoots": ["/Users/demo/Documents"],
  "preferred": true
}
```

#### (2) `hello_ack`（网关 → 桌面端）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `"hello_ack"` | 是 | 固定值 |
| `protocolVersion` | integer | 是 | 协商生效的协议版本（阶段 2 为 `1`） |
| `minProtocolVersion` | integer | 是 | 网关支持的最低协议版本 |
| `maxProtocolVersion` | integer | 是 | 网关支持的最高协议版本 |
| `serverTime` | integer | 是 | 网关当前 Unix 毫秒时间戳 |
| `heartbeatSec` | integer | 是 | 网关下发 WS `ping` 的周期，固定 `25` |
| `heartbeatTimeoutSec` | integer | 是 | 心跳超时判定阈值，固定 `60` |
| `maxFrameBytes` | integer | 是 | 单帧最大字节数，阶段 2 为 `1048576`（1 MiB） |
| `maxConcurrency` | integer | 是 | 单设备最大并发请求数，阶段 2 为 `4` |

示例：
```json
{
  "type": "hello_ack",
  "protocolVersion": 1,
  "minProtocolVersion": 1,
  "maxProtocolVersion": 1,
  "serverTime": 1764160000000,
  "heartbeatSec": 25,
  "heartbeatTimeoutSec": 60,
  "maxFrameBytes": 1048576,
  "maxConcurrency": 4
}
```

#### (3) `state_update`（桌面端 → 网关，白名单/偏好/活跃度变化时发送）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `"state_update"` | 是 | 固定值 |
| `deviceName` | string | 否 | 更新设备显示名 |
| `allowedRoots` | string[] | 否 | 全量覆盖当前设备的白名单目录列表（最多 32 项） |
| `preferred` | boolean | 否 | 更新首选设备标记 |
| `active` | boolean | 否 | `true` 表示主窗口获焦或用户活跃，网关刷新 `lastActiveAt`（客户端限频：≥ 10 秒发一次） |

示例：
```json
{
  "type": "state_update",
  "allowedRoots": ["/Users/demo/Documents", "/Users/demo/Desktop"],
  "active": true
}
```

#### (4) `rpc_req`（网关 → 桌面端）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `"rpc_req"` | 是 | 固定值 |
| `reqId` | string | 是 | 网关生成的全局唯一请求 ID（如 `req_0193a8...`） |
| `method` | `"tools/call"` | 是 | 固定值 |
| `params` | object | 是 | `{ "name": "<tool_name>", "arguments": { ... } }`（已剥离 `device_id` 或透传均可，桌面端忽略 `device_id`） |
| `timeoutMs` | integer | 是 | 本次调用允许的最长执行时间（毫秒，阶段 2 为 `15000` 或 `20000`） |

示例：
```json
{
  "type": "rpc_req",
  "reqId": "req_7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "method": "tools/call",
  "params": {
    "name": "desktop_read_file",
    "arguments": {
      "path": "/Users/demo/Documents/notes.md",
      "start_line": 1,
      "end_line": 80
    }
  },
  "timeoutMs": 15000
}
```

#### (5) `rpc_res`（桌面端 → 网关）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `"rpc_res"` | 是 | 固定值 |
| `reqId` | string | 是 | 对应 `rpc_req.reqId` |
| `ok` | boolean | 是 | 执行是否成功 |
| `data` | object | 条件 | `ok === true` 时必填，内容符合第 5 节各工具出参 Schema |
| `error` | object | 条件 | `ok === false` 时必填：`{ "code": string, "message": string, "retryable": boolean }` |

成功示例：
```json
{
  "type": "rpc_res",
  "reqId": "req_7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "ok": true,
  "data": {
    "path": "/Users/demo/Documents/notes.md",
    "encoding": "utf-8",
    "total_size_bytes": 1240,
    "start_line": 1,
    "end_line": 42,
    "returned_bytes": 1240,
    "truncated": false,
    "content": "# 会议记录\n..."
  }
}
```

失败示例：
```json
{
  "type": "rpc_res",
  "reqId": "req_7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "ok": false,
  "error": {
    "code": "PATH_NOT_ALLOWED",
    "message": "目标路径不在已授权的目录白名单内，请在桌面端设置中添加对应目录后再试。",
    "retryable": false
  }
}
```

#### (6) `rpc_cancel`（网关 → 桌面端，尽力取消）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `"rpc_cancel"` | 是 | 固定值 |
| `reqId` | string | 是 | 需取消的请求 ID |
| `reason` | string | 是 | `"timeout"` / `"caller_aborted"` / `"gateway_shutdown"` |

示例：
```json
{
  "type": "rpc_cancel",
  "reqId": "req_7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "reason": "timeout"
}
```
桌面端收到 `rpc_cancel` 后应立即触发对应请求的 `AbortController.abort()`（若请求已结束则忽略），不再回发 `rpc_res`。

### 3.4 心跳、重连退避与多设备路由

1. **心跳与死链检测**
   - 网关每 **25 秒** 发送 WebSocket 协议层 `ping` 控制帧；桌面端（`ws` 库）自动回复 `pong`。
   - 网关连续 **60 秒** 未收到任何 `pong` 或有效业务帧，立即以 `4008`（或 `ws.terminate()`）断连、移出在线表、以 `DEVICE_DISCONNECTED` 结束全部在途请求。
   - 桌面端连续 **65 秒** 未收到来自网关的 `ping` 或任何业务消息，判定为静默半开连接，主动 `terminate()` 并进入重连。
2. **重连退避与唤醒**
   - 退避序列：`1s → 2s → 4s → 8s → 15s → 30s`（上限 30s），每次叠加 `±20%` 随机抖动。
   - 收到 `hello_ack` 且连接持续健康满 **10 秒** 后重置退避阶梯。
   - 监听 `powerMonitor` 的 `resume`、`unlock-screen` 与系统网络 `online` 事件：若当前处于等待重连状态，立即清零退避并尝试重连。
   - 握手收到 HTTP `401` 时最多尝试一次 `POST /_wp/api/desktop/refresh`；刷新失败则写入 `.revoked` 并停止重连。握手收到 `403` / `426` 时直接停止重连。
3. **多设备路由规则**
   - 网关注册表结构：`Map<unionId, Map<deviceId, DeviceSession>>`。
   - 同一 `deviceId` 重连：新连接通过 `hello` 校验后原子顶替旧连接，旧连接以 Close Code `4002` 关闭，旧连接在途请求以 `DEVICE_DISCONNECTED` 失败返回。
   - 调用 `desktop_list_dir` / `desktop_read_file` / `desktop_search_files` 时的设备选择顺序：
     1. 入参显式提供 `device_id`：精确匹配当前用户的在线设备；找不到返回 `DEVICE_NOT_FOUND`（错误详情附当前在线设备列表）。
     2. 未提供 `device_id` 且仅有 1 台在线：直接路由至该设备。
     3. 未提供 `device_id` 且 ≥ 2 台在线：优先在 `preferred === true` 的在线设备中选 `lastActiveAt` 最新的一台；若均未设 `preferred`，选全局 `lastActiveAt` 最新的一台。返回结果中显式附带实际路由的 `device_id`、`device_name` 与在线总数。
   - `lastActiveAt` 在收到 `hello`、`state_update(active: true)` 及成功收到 `rpc_res` 时刷新。

### 3.5 并发上限、超时与消息大小上限

| 限制项 | 阶段 2 契约值 | 强制执行端 | 超限行为 |
| --- | --- | --- | --- |
| 单设备最大在途并发（`inFlight`） | **4** | 网关 + 桌面端 | 网关返回 `CONCURRENCY_LIMIT_EXCEEDED`；桌面端兜底返回同错误码 |
| 单用户跨设备总并发 | **8** | 网关 | 返回 `CONCURRENCY_LIMIT_EXCEEDED` |
| 单用户最大同时在线设备数 | **5 台** | 网关 | 新 `deviceId` 握手返回 HTTP `429`（同 `deviceId` 顶替不受限） |
| `desktop_list_dir` 超时 | 网关 **15s** / 桌面内部 **10s** | 双方 | 网关发 `rpc_cancel(timeout)` 并返回 `TOOL_TIMEOUT` |
| `desktop_read_file` 超时 | 网关 **15s** / 桌面内部 **10s** | 双方 | 网关发 `rpc_cancel(timeout)` 并返回 `TOOL_TIMEOUT` |
| `desktop_search_files` 超时 | 网关 **20s** / 桌面内部 **10s** | 双方 | 桌面 10s 内返回部分结果 + `timed_out: true`；网关 20s 兜底发 `rpc_cancel` 返回 `TOOL_TIMEOUT` |
| 单帧 WS 消息上限 | **1 MiB（1,048,576 字节）** | 网关 + 桌面端 | 桌面端发 `rpc_res` 前自检字节数，超限改发 `PAYLOAD_TOO_LARGE` 错误帧；网关 `maxPayload = 1048576` 防恶意帧 |
| `/desktop-mcp` HTTP 请求体上限 | **256 KiB** | 网关 | 返回 HTTP `413` |

---

## 4. 容器到网关（内网 MCP 接入）

### 4.1 网关内网 MCP 服务端

- **地址**：`POST ${PARTNER_INTERNAL_ORIGIN}/desktop-mcp`（默认 `http://workpartner-gateway:3091/desktop-mcp`），仅挂载在 `gateway/services.mjs` 的 `runtime.internalPort`（`3091`）。
- **公网不可达**：公网端口（`3090`）不挂载 `/desktop-mcp`（访问返回 `404`）。
- **网络可达性**：
  - Kubernetes：`deploy/k8s/network-policies.yaml.tmpl:23-29` 已放行用户 Pod 出站访问网关 `internalPort`，无需修改网络策略。
  - Docker：`gateway/runtime/docker.mjs:91-95` 已将网关容器接入各用户独立网桥；需确保 `gateway/services.mjs:99` 在启用桌面功能时启动 3091 监听。
- **协议**：MCP Streamable HTTP（`protocolVersion: "2025-03-26"`），采用无状态单请求单响应 JSON（`Content-Type: application/json`）：
  - 非 `POST` 请求返回 `405 Method Not Allowed`。
  - 响应头固定带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。

| JSON-RPC 方法 | 是否要求桌面在线 | 网关行为 |
| --- | --- | --- |
| `initialize` | 否 | 直接返回 `{ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "workpartner-desktop", version: "1.0.0" } }` |
| `notifications/initialized` 及其他无 `id` 通知 | 否 | 返回 HTTP `202 Accepted`（空体） |
| `ping` | 否 | 返回 `{}` |
| `tools/list` | 否 | 直接返回第 5 节定义的 4 个阶段 2 工具完整 Schema 清单（确保容器启动或电脑休眠时 Claude Code 不卸载 MCP） |
| `tools/call` | 视工具而定 | 1. 核对 `desktop.enabled && admitted(callerUser)`，未准入直接返回 `DESKTOP_NOT_ADMITTED`（`isError: true`）。<br/>2. `desktop_list_devices`：网关直接读 `registry.get(callerUser.unionId)` 返回。<br/>3. 其余 3 个工具：执行参数校验 → 选定本人在线设备（离线 < 50ms 返回 `DEVICE_OFFLINE`）→ 可选浅层路径预检 → 并发检查 → 下发 `rpc_req` → 等待 `rpc_res` 并包装为 MCP `CallToolResult`。 |

- **MCP `CallToolResult` 统一包装规范**：
  - 成功时：`isError: false`，`content: [{ type: "text", text: "<可选设备路由提示行>\n" + JSON.stringify(data) }]`（其中 `data` 同时包含 `device_id` 与 `device_name`，单设备与多设备格式一致；当多设备在线且未传 `device_id` 时在 JSON 前或首字段清晰标注）。为方便模型稳定解析，推荐统一返回纯 JSON 文本并在结构内带 `_meta: { device_id, device_name, online_devices, routed_by }`，或在 `content` 中放两段文本（第 1 段一行中文摘要如 `[设备: Work-Laptop (darwin)，在线 2 台]`，第 2 段为结构化 JSON）。
  - 业务错误时（离线、路径越界、超时等）：返回 JSON-RPC 成功帧中的 `result: { isError: true, content: [{ type: "text", text: "[<ERROR_CODE>] <中文说明>" }] }`（符合 MCP 规范，避免协议层异常导致宿主断开 MCP 会话）。
  - 仅在 JSON 解析失败（`-32700`）、未知 JSON-RPC 方法（`-32601`）、缺少顶层必填字段（`-32600`）时返回 JSON-RPC `error` 对象。

### 4.2 容器侧认证与凭据保护

1. **认证方式**：容器向 `/desktop-mcp` 发起请求时携带 `Authorization: Bearer zpd.<...>`；网关用 `tokenUser(req, SESSION_KEY, users())`（`gateway/market-auth.mjs:25-35`）验签并定位唯一 `callerUser`。验签失败返回 HTTP `401 Unauthorized`（响应体仅 `{"error":"unauthorized"}`）。
2. **同人强隔离**：`tools/call` 仅可访问 `registry.get(callerUser.unionId)`；协议与参数中不存在任何指定其他用户的字段，跨用户路由在结构上不可达。
3. **凭据不进配置、不进环境变量、不进对话与日志**：
   - `/data/.zp-market-token` 由网关按权限 `0600` 写入（K8s 经 Secret 挂载并软链）。`gateway/services.mjs:55` 补齐在启用 `desktop` 时也会签发并定期续写该文件。
   - **禁止**把 `zpd.` 写入 `/data/.claude.json`。
   - **禁止**把 `zpd.` 导出为容器全局环境变量（防止被任意工具命令或崩溃日志打印到对话中）。
   - 新增 `/opt/workpartner/bin/wp-desktop-mcp-headers.py`（仅由 Claude Code 的 `headersHelper` 调用）：读取 `/data/.zp-market-token`，去除首尾空白后校验匹配 `/^zpd\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/` 且不含 `\r`/`\n`，仅向 stdout 输出 `{"Authorization":"Bearer zpd.<...>"}`；任何失败以非零码静默退出，不在 stderr 输出文件内容或令牌片段。

### 4.3 容器侧 MCP 注册机制

1. **环境变量导出（`gateway/organization/resolve.mjs`）**：
   - `nextEnvironment()` 新增 `PARTNER_INTERNAL_ORIGIN: data.runtime.internalOrigin`。
2. **多托管 MCP 支持（`image/bin/wp-mcp-config.py`）**：
   - 将 `/data/.claude.json` 根级托管记录 `_workpartnerMcp` 扩展为 `{ "names": ["workpartner-hub", "workpartner-desktop"] }`，同时向下兼容读取旧版 `{ "name": "..." }`。
   - 支持两种托管项来源：环境变量 Header（`wp-mcp-headers.py <ENV>`）与专用脚本 Header（`wp-desktop-mcp-headers.py`）。
   - 每个托管项独立检测是否与用户手写 MCP 同名冲突；未启用或已关闭的托管项自动清理；用户个人配置字节保持原样；原子写入。
3. **启动注册（`image/bin/wp-mcp-start.mjs`）**：
   - 保持 `workpartner-hub` 原有 3 秒探活逻辑不变。
   - 对 `workpartner-desktop`：当 `organizationData().desktop?.enabled === true` 且 `PARTNER_INTERNAL_ORIGIN` 为合法 `http(s)://` 地址（无账号密码/query/hash）时即写入托管项：
     ```json
     "workpartner-desktop": {
       "type": "http",
       "url": "http://workpartner-gateway:3091/desktop-mcp",
       "headersHelper": "python3 -I /opt/workpartner/bin/wp-desktop-mcp-headers.py",
       "alwaysLoad": true
     }
     ```
   - **不探活电脑、不依赖 `/data/.zp-market-token` 在注册瞬间已存在**（避开 `start.sh:68` 早于 `start.sh:72` 建软链的时序问题；同时建议在 `start.sh` 中将 `wp_link_published_files` 提前或确保在 AionUi 启动前完成）。
   - 阶段 2 默认先接入 Claude Code（见第 10 节待拍板问题 3）。
4. **容器使用说明（`image/home/CLAUDE.md`）**：
   - 追加 3 行简短规范：仅在用户明确要求访问本机文件时调用 `desktop_*` 工具；可先调 `desktop_list_devices` 查看在线设备与授权目录；收到离线或未授权报错时直接告知用户，不循环重试。

---

## 5. 工具定义

阶段 2 共暴露 4 个只读工具，工具名严格使用小写下划线前缀 `desktop_`。

### 5.1 `desktop_list_devices`（网关直接响应）

- **描述**：列出当前账号在线的桌面设备及其已授权目录，用于确认桌面端在线状态或获取目标 `device_id`。
- **入参 JSON Schema**：
```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```
- **出参 JSON Schema**：
```json
{
  "type": "object",
  "required": ["count", "devices"],
  "properties": {
    "count": { "type": "integer", "minimum": 0 },
    "devices": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["device_id", "device_name", "platform", "arch", "app_version", "preferred", "capabilities", "allowed_roots", "allowed_roots_count", "connected_at", "last_active_at"],
        "properties": {
          "device_id": { "type": "string" },
          "device_name": { "type": "string" },
          "platform": { "type": "string", "enum": ["darwin", "win32", "linux"] },
          "arch": { "type": "string" },
          "app_version": { "type": "string" },
          "preferred": { "type": "boolean" },
          "capabilities": { "type": "array", "items": { "type": "string" } },
          "allowed_roots": { "type": "array", "items": { "type": "string" } },
          "allowed_roots_count": { "type": "integer", "minimum": 0 },
          "connected_at": { "type": "string", "format": "date-time" },
          "last_active_at": { "type": "string", "format": "date-time" }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```
- **上限与行为**：无在线设备时返回 `{"count":0,"devices":[]}`（`isError: false`），并在文本摘要提示用户打开桌面客户端。

---

### 5.2 `desktop_list_dir`（桌面端执行）

- **描述**：列出本机白名单目录内的文件与子目录。
- **入参 JSON Schema**：
```json
{
  "type": "object",
  "required": ["path"],
  "properties": {
    "path": { "type": "string", "minLength": 1, "maxLength": 1024, "description": "本机目录的绝对路径，必须位于用户授权的目录白名单内。" },
    "device_id": { "type": "string", "minLength": 1, "maxLength": 64, "description": "可选，多台设备在线时指定目标设备 ID。" },
    "max_depth": { "type": "integer", "minimum": 1, "maximum": 3, "default": 1, "description": "遍历深度，1 表示仅列当前目录直接子项，最大 3。" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 100, "description": "最多返回的条目数，最大 200。" },
    "include_hidden": { "type": "boolean", "default": false, "description": "是否包含隐藏文件/目录（仍受敏感黑名单过滤）。" }
  },
  "additionalProperties": false
}
```
- **出参 JSON Schema**（桌面端 `rpc_res.data`；网关包装响应时补充 `device_id`、`device_name`）：
```json
{
  "type": "object",
  "required": ["path", "entries", "truncated", "skipped_count"],
  "properties": {
    "path": { "type": "string" },
    "entries": {
      "type": "array",
      "maxItems": 200,
      "items": {
        "type": "object",
        "required": ["name", "path", "kind", "mtime"],
        "properties": {
          "name": { "type": "string" },
          "path": { "type": "string" },
          "kind": { "type": "string", "enum": ["file", "dir", "symlink"] },
          "size_bytes": { "type": "integer", "minimum": 0 },
          "mtime": { "type": "string", "format": "date-time" }
        },
        "additionalProperties": false
      }
    },
    "truncated": { "type": "boolean" },
    "skipped_count": { "type": "integer", "minimum": 0 }
  },
  "additionalProperties": false
}
```
- **上限**：`max_depth <= 3`、`limit <= 200`、内部遍历节点数上限 `2000`、桌面内部超时 `10s` / 网关超时 `15s`。排序稳定（目录优先、按名称字典序）。因黑名单/权限/越界符号链接被过滤的条目仅累加 `skipped_count`，不返回路径名。

---

### 5.3 `desktop_read_file`（桌面端执行）

- **描述**：按行区间读取本机白名单目录内的 UTF-8 文本文件（拒绝二进制文件）。
- **入参 JSON Schema**：
```json
{
  "type": "object",
  "required": ["path"],
  "properties": {
    "path": { "type": "string", "minLength": 1, "maxLength": 1024, "description": "本机文件的绝对路径，必须位于用户授权的目录白名单内。" },
    "device_id": { "type": "string", "minLength": 1, "maxLength": 64, "description": "可选，多台设备在线时指定目标设备 ID。" },
    "start_line": { "type": "integer", "minimum": 1, "default": 1, "description": "起始行号（从 1 开始，含）。" },
    "end_line": { "type": "integer", "minimum": 1, "description": "结束行号（从 1 开始，含）；省略则读至文件末尾或达到 max_bytes 上限。" },
    "max_bytes": { "type": "integer", "minimum": 1, "maximum": 262144, "default": 65536, "description": "单次最多返回的文本字节数，上限 262144（256 KiB）。" }
  },
  "additionalProperties": false
}
```
- **出参 JSON Schema**：
```json
{
  "type": "object",
  "required": ["path", "encoding", "total_size_bytes", "start_line", "end_line", "returned_bytes", "truncated", "content"],
  "properties": {
    "path": { "type": "string" },
    "encoding": { "type": "string", "enum": ["utf-8"] },
    "total_size_bytes": { "type": "integer", "minimum": 0 },
    "start_line": { "type": "integer", "minimum": 1 },
    "end_line": { "type": "integer", "minimum": 0 },
    "returned_bytes": { "type": "integer", "minimum": 0, "maximum": 262144 },
    "truncated": { "type": "boolean" },
    "content": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **上限与边界**：
  - 若 `end_line < start_line`，返回 `INVALID_PARAMS`。
  - 源文件大小超过 **20 MiB（20,971,520 字节）** 时拒绝并返回 `FILE_TOO_LARGE`。
  - 检测前 8 KiB：若含 NUL 字节（`0x00`）或无法按 UTF-8 合法解码（高比例替换字符），判定为二进制文件，返回 `BINARY_FILE_UNSUPPORTED`。
  - 非普通文件（目录、FIFO、socket、设备节点）返回 `NOT_A_REGULAR_FILE`。
  - 返回内容在按行截断时保证不切断多字节 UTF-8 字符，实际返回字节数 `<= max_bytes <= 262144`；若达到 `max_bytes` 上限但未到 `end_line`/EOF，置 `truncated: true`。

---

### 5.4 `desktop_search_files`（桌面端执行）

- **描述**：在本机白名单目录内按文件名/通配符或纯文本内容搜索文件。
- **入参 JSON Schema**：
```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "path": { "type": "string", "minLength": 1, "maxLength": 1024, "description": "可选，限定搜索的根目录（必须在白名单内）；省略则搜索全部白名单目录。" },
    "device_id": { "type": "string", "minLength": 1, "maxLength": 64, "description": "可选，多台设备在线时指定目标设备 ID。" },
    "mode": { "type": "string", "enum": ["name", "content"], "default": "name", "description": "name 按文件名/相对路径匹配；content 按文本内容匹配。" },
    "query": { "type": "string", "minLength": 1, "maxLength": 200, "description": "搜索词。mode=name 支持 * 与 ? 通配符或子串匹配；mode=content 为纯文本字面匹配（不支持任意正则）。" },
    "case_sensitive": { "type": "boolean", "default": false },
    "max_results": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 },
    "max_depth": { "type": "integer", "minimum": 1, "maximum": 8, "default": 5 }
  },
  "additionalProperties": false
}
```
- **出参 JSON Schema**：
```json
{
  "type": "object",
  "required": ["mode", "matches", "truncated", "timed_out", "scanned_files"],
  "properties": {
    "mode": { "type": "string", "enum": ["name", "content"] },
    "matches": {
      "type": "array",
      "maxItems": 100,
      "items": {
        "type": "object",
        "required": ["path"],
        "properties": {
          "path": { "type": "string" },
          "kind": { "type": "string", "enum": ["file", "dir"] },
          "line": { "type": "integer", "minimum": 1 },
          "snippet": { "type": "string", "maxLength": 200 }
        },
        "additionalProperties": false
      }
    },
    "truncated": { "type": "boolean" },
    "timed_out": { "type": "boolean" },
    "scanned_files": { "type": "integer", "minimum": 0 }
  },
  "additionalProperties": false
}
```
- **上限与边界**：
  - `max_results <= 100`、`max_depth <= 8`；桌面端内部执行硬超时 **10 秒**（网关超时 **20 秒**）。超时后若有已命中条目则返回已命中结果且置 `timed_out: true, truncated: true`；若无结果则返回 `TOOL_TIMEOUT`。
  - `mode="content"` 仅扫描单个大小 ≤ **2 MiB** 的文本文件（自动跳过二进制文件、隐藏敏感文件及 `.git`/`node_modules`），总扫描文件数上限 **5,000**、总读取字节上限 **50 MiB**，达到上限即停止并置 `truncated: true`。
  - 严禁将用户 `query` 直接编译为任意正则表达式（防止 ReDoS）；`mode="name"` 的 `*`/`?` 通配符需先转义全部正则元字符再做线性匹配。

---

### 5.5 白名单校验分层、符号链接与路径穿越处理

#### (1) 白名单校验责任划分

- **桌面端（强制，唯一可信安全边界）**：
  - 必须无条件执行完整的输入格式检查、`realpath` 真实路径解析、白名单目录包含判定、永久敏感黑名单拦截与文件类型校验。
  - 白名单持久化于 `app.getPath('userData')/helper-config.json`（权限 `0600`），**默认空列表 `[]`**。
  - 用户在设置窗添加白名单目录时，必须拒绝添加文件系统根目录（`/`、`C:\` 等）、系统目录及客户端自身 `userData` 目录。
- **网关侧（可选加固层，推荐阶段 2 同步启用）**：
  - 当目标设备的 `allowedRoots` 为空数组时，直接返回 `NO_ALLOWED_ROOTS`，无需往返桌面端。
  - 当请求显式传入 `path` 时，网关按目标设备 `platform` 做词法路径规范化并进行白名单前缀预检；明显不在 `allowedRoots` 下时直接拦截返回 `PATH_NOT_ALLOWED`。
  - 网关无法解析本机符号链接与文件系统挂载，**网关放行绝不替代桌面端校验**。

#### (2) 路径穿越与符号链接规则（桌面端必须逐条实现）

1. **输入合法性拦截**：
   - 拒绝包含 `\0`（NUL）的路径。
   - 必须为绝对路径；Windows 额外拒绝驱动器相对路径（如 `C:foo`）、UNC 路径（`\\server\share`）以及设备命名空间路径（`\\?\...`、`\\.\...`）。
2. **`realpath` 真实边界判定**：
   - 每次校验前，分别对白名单根目录与目标路径执行 `fs.realpathSync.native`（先确保不跟随指向黑名单的链路）。
   - 使用 `path.relative(rootReal, targetReal)` 判断包含关系：仅当结果为空字符串，或不以 `..` 开头且 `path.isAbsolute(rel) === false` 时视为在白名单内（Windows 按大小写不敏感规范化比较盘符与路径段），彻底杜绝 `/Users/demo/doc` 误放行 `/Users/demo/docs` 的字符串前缀绕过。
3. **符号链接策略**：
   - **`desktop_list_dir`**：遍历使用 `lstat` / `withFileTypes: true`，**绝不递归进入符号链接目录**（防目录逃逸与循环软链）。对单个符号链接条目，仅当其 `realpath` 仍在白名单内且未命中黑名单时以 `kind: "symlink"` 返回；否则静默跳过并计入 `skipped_count`。
   - **`desktop_search_files`**：遍历过程中遇到任何符号链接一律跳过，不跟随。
   - **`desktop_read_file`**：若目标为符号链接，仅当其 `realpath` 仍严格位于白名单内、未命中敏感黑名单且指向普通文件时允许读取；打开文件句柄后执行 `fstat` 确认 `isFile()`，降低 TOCTOU 竞争风险。
4. **存在性防探测**：
   - 若请求路径经词法规范化已不在任何白名单目录内，或命中敏感黑名单，**无论该路径在磁盘上是否存在**，一律返回 `PATH_NOT_ALLOWED` / `SENSITIVE_PATH_BLOCKED`，不得返回 `PATH_NOT_FOUND`。
5. **永久敏感黑名单（即使所在父目录在白名单内也强制拒绝）**：
   - 密钥与凭据目录/文件：路径任一段匹配 `.ssh`、`.aws`、`.gnupg`、`.kube`、`.git-credentials`、`.npmrc`、`.pypirc`、`.netrc`、`.docker/config.json`，以及文件名匹配 `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`、`*.kdbx`（大小写不敏感）。
   - 浏览器与系统钥匙串敏感目录：macOS `~/Library/Keychains`、`~/Library/Cookies`、常见浏览器配置目录（Chrome/Edge/Brave/Safari/Firefox）；Windows `%LOCALAPPDATA%\Google\Chrome\User Data`、`%LOCALAPPDATA%\Microsoft\Edge\User Data`、`%APPDATA%\Mozilla\Firefox`。
   - 系统保留目录：POSIX `/System`、`/Library`、`/etc`、`/private/etc`、`/private/var`、`/proc`、`/sys`、`/dev`；Windows `C:\Windows`、`C:\Program Files`、`C:\Program Files (x86)`、`C:\ProgramData`。
   - 客户端自身目录：运行时动态获取的 `app.getPath('userData')`（保护本机 `desktop-token.enc`、`device-id`、`helper-config.json` 与审计日志）。

---

## 6. 错误码表

| 错误码 (`code`) | 产生端 | 传输层映射 | `retryable` | 面向 AI / 用户的标准中文说明要点 |
| --- | --- | --- | --- | --- |
| `UNAUTHORIZED` | 网关 | HTTP `401` | `false` | 认证凭据无效或已过期。 |
| `TOKEN_REVOKED` | 网关 | WS Close `4001` | `false` | 桌面登录凭据已被撤销，请重新登录。 |
| `DESKTOP_NOT_ADMITTED` | 网关 | HTTP `403` / WS `4003` / MCP `isError` | `false` | 当前账号尚未开通桌面端本地助手权限。 |
| `PROTOCOL_VERSION_UNSUPPORTED` | 网关 | HTTP `426` / WS `4004` | `false` | 桌面客户端协议版本不兼容，请升级到最新版本。 |
| `DEVICE_LIMIT_EXCEEDED` | 网关 | HTTP `429` | `false` | 当前账号同时在线桌面设备数已达上限（5 台）。 |
| `DEVICE_OFFLINE` | 网关 | MCP `isError` | `false` | 桌面客户端当前未连接（可能未启动、电脑休眠或断网），请提醒用户打开桌面端确认已连接后再试，不要循环自动重试。 |
| `DEVICE_NOT_FOUND` | 网关 | MCP `isError` | `false` | 指定的 `device_id` 不在线或不存在（附当前在线设备摘要）。 |
| `DEVICE_DISCONNECTED` | 网关 | MCP `isError` | `true` | 执行中途桌面端断开连接，请确认桌面端重连后再试。 |
| `NO_ALLOWED_ROOTS` | 网关 / 桌面 | MCP `isError` | `false` | 桌面端尚未配置任何授权目录（默认为空），请在桌面端设置中添加允许访问的文件夹。 |
| `PATH_NOT_ALLOWED` | 网关 / 桌面 | MCP `isError` | `false` | 目标路径不在已授权的目录白名单内（或符号链接指向白名单之外）。 |
| `SENSITIVE_PATH_BLOCKED` | 桌面 | MCP `isError` | `false` | 目标命中敏感文件或系统目录保护规则，禁止访问。 |
| `PATH_NOT_FOUND` | 桌面 | MCP `isError` | `false` | 白名单内的目标路径不存在。 |
| `NOT_A_DIRECTORY` | 桌面 | MCP `isError` | `false` | 目标路径不是目录。 |
| `NOT_A_REGULAR_FILE` | 桌面 | MCP `isError` | `false` | 目标路径不是普通文件，无法读取。 |
| `BINARY_FILE_UNSUPPORTED` | 桌面 | MCP `isError` | `false` | 目标文件为二进制格式，阶段 2 仅支持读取 UTF-8 文本文件。 |
| `FILE_TOO_LARGE` | 桌面 | MCP `isError` | `false` | 目标文件超过单文件读取大小上限（20 MiB）。 |
| `PAYLOAD_TOO_LARGE` | 网关 / 桌面 | HTTP `413` / MCP `isError` | `false` | 请求或响应数据超过单次传输上限，请缩小读取范围或行数。 |
| `INVALID_PARAMS` | 网关 / 桌面 | MCP `isError` | `false` | 参数缺失、类型无效或超出允许范围。 |
| `TOOL_NOT_SUPPORTED` | 网关 / 桌面 | MCP `isError` | `false` | 当前设备或协议阶段不支持该工具。 |
| `TOOL_TIMEOUT` | 网关 / 桌面 | MCP `isError` | `true` | 等待本机响应超时（已自动取消），请缩小范围或稍后重试。 |
| `CONCURRENCY_LIMIT_EXCEEDED` | 网关 / 桌面 | MCP `isError` | `true` | 本机并发请求数已达上限，请等待当前操作完成后再试。 |
| `INTERNAL_ERROR` | 网关 / 桌面 | MCP `isError` | `true` | 执行过程中发生内部错误（不回传敏感详情）。 |

---

## 7. 安全与审计

### 7.1 审计日志记录规范

1. **桌面端本地审计日志（用户可见）**
   - 路径：`app.getPath('userData')/logs/audit-YYYY-MM-DD.jsonl`（目录权限 `0700`，文件权限 `0600`，按天滚动，默认保留 30 天，单日上限 50 MiB）。
   - 每行 JSON 仅允许记录以下字段：
     ```json
     {
       "ts": "2026-11-27T14:00:00.000Z",
       "reqId": "req_7c9e6679-7425-40de-944b-e07fc1f90ae7",
       "tool": "desktop_read_file",
       "targetPath": "/Users/demo/Documents/notes.md",
       "argsSummary": { "start_line": 1, "end_line": 80, "max_bytes": 65536 },
       "decision": "auto_allow",
       "ok": true,
       "errorCode": null,
       "durationMs": 12,
       "returnedBytes": 1240,
       "truncated": false
     }
     ```
   - `decision` 取值（阶段 2）：`auto_allow`（命中白名单允许执行）、`policy_deny`（被白名单/黑名单/类型策略拒绝）。
2. **网关审计日志（运维排障）**
   - 路径：网关标准日志或 `${runtime.stateDirectory}/desktop-relay/audit.log`（权限 `0600`）。
   - 每行 JSON 仅允许记录元数据：`{ "at", "event", "unionId", "deviceId", "tool", "reqId", "durationMs", "status", "errorCode", "closeCode" }`。

### 7.2 严禁写入日志的内容（红线）

- **任何文件内容**、文件片段、搜索命中 `snippet`、目录条目列表。
- **任何凭据**：`wpd.`、`zpd.`、`wp_sid`、模型 API Key、`Authorization` 请求头、Cookie、PKCE `code` / `code_verifier`。
- **网关日志额外红线**：网关日志**禁止**记录 `path`、`allowedRoots`、`query`（避免用户本机文件名和搜索关键词落入集中日志）。
- **错误响应红线**：无论网关还是桌面端，错误消息中不得包含令牌、内部堆栈、未授权路径的实际存在性或系统环境变量。

---

## 8. 双方验收清单与演练联调步骤

### 8.1 网关与容器侧验收清单

- [ ] **中继单元测试**：`node --test gateway/tests/desktop-relay.test.mjs` 全过，覆盖：
  - `WSS /_wp/desktop/ws` 握手鉴权（有效 `wpd.` 通过，过期/伪造/`zpd.`/无头拒绝 `401`）；
  - 非法协议版本 `426`、非法 `deviceId` `400`、5 秒无 `hello` 关闭 `4004`；
  - 同人路由成功，跨用户隔离不可达；
  - `migration.forward` 将非本网关用户的 WS 升级透明转发到对端；
  - 25s `ping` / 60s 无 `pong` 踢断并释放 `inFlight`；
  - 同 `deviceId` 重连以 `4002` 顶替旧连接；超过 5 台返回 `429`；
  - `POST /_wp/api/desktop/revoke-all` 触发 `onRevoke` 立即以 `4001` 踢断全部在线连接；
  - 用户被移出 `desktop.allow` 或关闭 `desktop.enabled` 后被以 `4003` 踢断；
  - 离线调用 `< 50ms` 返回 `DEVICE_OFFLINE`；执行中断线立即返回 `DEVICE_DISCONNECTED`；超时发送 `rpc_cancel` 并返回 `TOOL_TIMEOUT`；
  - 多设备路由（指定 `device_id`、`preferred` 优先、`lastActiveAt` 优先）；
  - 并发上限（单设备 4 / 单用户 8）与 1 MiB 帧上限保护；
  - `/desktop-mcp` 的 `initialize`、`notifications/initialized`、`ping`、`tools/list` 在桌面离线时均正常响应；公网端口访问 `/desktop-mcp` 返回 `404`。
- [ ] **容器 MCP 配置测试**：`node --test tools/desktop-mcp-config.test.mjs` 及既有 `node --test tools/mcp-hub.test.mjs`、`node --test gateway/tests/desktop-auth.test.mjs` 全过，覆盖：
  - `workpartner-hub` 与 `workpartner-desktop` 共存；
  - 用户手写 MCP 字节原样保留、重名冲突保护、重复启动幂等；
  - `/data/.zp-market-token` 尚未生成时 `wp-mcp-start.mjs` 仍能正常写入托管项；
  - `wp-desktop-mcp-headers.py` 正常输出合法 Header、文件缺失或格式非法时静默非零退出且不回显内容。
- [ ] **仓库基线检查**：`bash tools/check.sh` 全部通过；开源防泄漏扫描零命中。

### 8.2 桌面端验收清单（使用 Mock Gateway 独立验收）

- [ ] **契约级 Mock Gateway**：本地测试目录提供按本契约实现的 Mock Gateway，可模拟 `hello_ack`、心跳 `ping`、4 个工具 RPC、`4001`/`4002`/`4003`/`4004`/网络中断/超时。
- [ ] **桌面端单元测试**：`cd desktop && npm test` 全过，覆盖：
  - 持久化 `device_id` 生成、读取、重启不变、权限 `0600`；
  - 白名单默认空（调用返回 `NO_ALLOWED_ROOTS`）、拒绝添加根目录与自身 `userData` 目录；
  - 路径防逃逸：`../` 穿越、相似前缀目录（`/a/doc` vs `/a/docs`）、指向白名单外的符号链接、循环符号链接、Windows UNC/相对驱动器路径全部拦截；
  - 永久敏感黑名单：`.ssh`、`.env`、`.env.local`、`*.pem`、`*.key`、系统目录、客户端自身 `userData` 目录全部返回 `SENSITIVE_PATH_BLOCKED`；
  - `desktop_list_dir` 深度/条数上限与 `skipped_count`；
  - `desktop_read_file` 行区间读取、256 KiB 截断、UTF-8 边界安全、二进制拒绝、20 MiB 超大文件拒绝；
  - `desktop_search_files` 文件名 glob 与纯文本内容搜索、100 条截断、10s 超时返回部分结果、无 ReDoS；
  - WSS 重连退避、`4001(token_revoked)` 停连并写 `.revoked`、`4002` 旧实例不重连、`4003` 降级、并发超 4 拒收、超 1 MiB 响应改返 `PAYLOAD_TOO_LARGE`；
  - 本地 `audit-YYYY-MM-DD.jsonl` 写入校验（权限 `0600`，断言不包含任何文件内容与 `wpd.` 令牌）。
- [ ] **构建与交互检查**：`cd desktop && npm run build` 通过；本地设置窗可正常增删目录白名单、显示连接状态、切换首选设备与暂停/恢复本地助手。

### 8.3 演练环境端到端联调步骤

1. **环境部署**：在演练环境网关（如 `https://staging.example.com`）部署阶段 2 网关与个人容器镜像；在组织配置中开启 `desktop.enabled: true`，将测试账号加入 `desktop.allow`；构建指向该演练网关的演练版客户端。
2. **容器 MCP 加载验证**：进入测试账号容器，核查 `/data/.claude.json` 同时包含 `workpartner-desktop`（及已有的 `workpartner-hub`），不含 `zpd.` 明文；手工执行 `python3 -I /opt/workpartner/bin/wp-desktop-mcp-headers.py` 验证输出合法 `Authorization`；在网页对话确认 Claude Code 成功加载 `workpartner-desktop`（重点验证 AionUi 启动 Claude Code 未屏蔽 `~/.claude.json`）。
3. **离线秒回验证**：在未启动演练版客户端时，在网页对话中触发 `desktop_list_devices` 与 `desktop_list_dir`，确认 1 秒内返回离线提示且对话不卡死。
4. **默认空白名单验证**：启动演练版客户端完成登录，确认托盘显示已连接；未添加目录时让 AI 读文件，确认返回 `NO_ALLOWED_ROOTS`。
5. **只读工具全链路验证**：在客户端设置页添加测试目录，依次验证 `desktop_list_devices`、`desktop_list_dir`、`desktop_read_file`、`desktop_search_files` 均正常返回；核查本地 `audit-*.jsonl` 仅含元数据（无文件内容）、网关日志不含路径与内容。
6. **越界与敏感拦截验证**：尝试读取未授权目录、测试目录内指向 `~/.ssh` 或 `/etc/hosts` 的软链、目录内 `.env` 文件、二进制文件，逐项确认返回对应错误码。
7. **长连接保活与断网恢复**：保持空闲 10 分钟确认心跳不掉线；主动断开本机网络或令电脑休眠后恢复，确认 30 秒内自动重连，**无需重启容器或新开对话**即可继续调用工具。
8. **多设备与撤销踢断验证**：使用两台设备（或两个独立 `userData` 实例）登录同一测试账号同时在线，验证 `desktop_list_devices` 与 `device_id` 路由；在网页端调用「退出所有桌面设备」（`POST /_wp/api/desktop/revoke-all`），确认全部在线实例 2 秒内收到 `4001` 断连并停止重连。

---

## 9. 版本与兼容

### 9.1 协议版本与能力协商

- 协议大版本号为正整数，阶段 2 固定为 `1`（携带于握手头 `X-WP-Protocol-Version` 与首帧 `hello.protocolVersion`）。
- 工具扩展优先通过 `hello.capabilities` 增量协商（阶段 2：`["fs.read"]`；阶段 3 可追加 `"fs.write"`、`"app.script"`、`"screen.capture"`），不破坏 `v1` 帧结构。
- JSON 消息遵循「忽略未知可选字段」原则，允许后续向后兼容地追加非必填字段。

### 9.2 混合版本降级规则

| 组合场景 | 预期行为 |
| --- | --- |
| **旧客户端（阶段 1）连新网关（阶段 2）** | 阶段 1 客户端不发起 `/_wp/desktop/ws`，继续正常使用网页壳与 `desktop-auth` HTTP 接口，完全兼容。 |
| **新客户端（阶段 2）连旧网关（阶段 1）** | 旧网关不识别 `/_wp/desktop/ws`（Upgrade 失败，返回 404/405/501 或直接断链）。客户端判定网关不支持中继后自动降级为「纯网页壳模式」，托盘显示「当前网关暂不支持本机助手」，退避至低频探测（每 10 分钟或重启后重试一次），不影响网页聊天。 |
| **协议版本超出网关支持区间** | 网关在握手阶段返回 HTTP `426 Upgrade Required`（带 `X-WP-Min-Protocol-Version` / `X-WP-Max-Protocol-Version`），或在 `hello` 阶段返回 Close Code `4004`（`unsupported_protocol`）。客户端停止自动重连，并在托盘/设置页提示升级。 |
| **未来新网关调用旧客户端未声明的能力** | 网关根据设备 `capabilities` 前置返回 `TOOL_NOT_SUPPORTED`（提示升级桌面端）；若请求仍到达旧客户端，桌面端对未知工具名兜底返回 `TOOL_NOT_SUPPORTED`。 |

---

## 10. 已定事项（2026-11-27）

1. **多设备未传 `device_id`**：自动路由至首选设备，无首选时取最近活跃设备（`lastActiveAt` 最新）；返回结果标注实际命中的设备名与在线总数。AI 可用 `desktop_list_devices` + `device_id` 显式切换。
2. **`allowedRoots` 上报**：上报至网关在线内存，不落盘、不写日志；`desktop_list_devices` 返回给本人容器的 AI，网关可做浅层越界预检，桌面端仍做最终完整校验。
3. **容器侧接入**：阶段 2 仅接入 Claude Code（`headersHelper` 按需读取令牌文件，不导出到环境变量）；Codex 待确认动态 Header 支持后再补。
4. **`.env` 黑名单**：阶段 2 拦截 `.env` 及所有 `.env.*`，不做豁免。
5. **退出登录**：默认只退出当前设备（断开本机 WSS、清理本地凭据与 Cookie）；另提供「退出所有桌面设备」，调用 `POST /_wp/api/desktop/revoke-all`。

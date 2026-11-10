
## 第 2 轮返工（2026-11-10）

继续使用 `T-1091-migration-owner` worktree，没有切换分支。当前 worktree 原先没有 report.md，本节作为第 2 轮报告创建。未改 check.sh、package 文件、rollout.py 或 runtime/，未新增依赖。

### 改动与规格对应

1. K3 按人转发：只有不以 `feishu-` 开头的登录回调留在入口；飞书用户授权回调按会话用户归属转发，pending state 留在接收 connect 的归属网关。路由和 Feishu handler 都使用配置的 callbackPath。`/_wp/preparing` 对名单内用户执行归属转发；不在名单内的用户继续走本地待开通流程。
2. 转发身份支持签名有效且仍在名单中的 `Bearer zpd.*`，覆盖 desktop-token、desktop-status，保留 cookie 身份优先级及原有认证校验。内部 `/token` 仍不转发：非本网关用户返回 403；归属文件不可用且无有效缓存时返回 503。
3. 归属文件失败关闭：未配置 ownersFile 时保持 main 行为；已配置但文件缺失、无法读取、JSON 或格式校验失败时沿用最后有效缓存。没有缓存时 owns 返回 false，禁止运行时写操作、prepare、新建和常驻拉起，公网 HTTP（包括登录入口和预览入口）返回 503，升级请求也返回 503，并记录不含文件内容的日志。修复文件后自动恢复。规格仅修改 K3 对应一句及其验收。
4. transport 新增末尾可选配置 `responseTimeoutMs`、`errorMessage`。整站 HTTP 和 WebSocket 转发设置 `responseTimeoutMs: 0`，即不设置响应头超时，允许慢操作在数分钟后开始响应；不设置流空闲超时。连接错误使用通用“服务暂时不可用，请稍后重试。”502 文案。预览调用方不传选项，继续使用 10 秒响应头超时、原 HTTP 错误文案及原 WebSocket 失败关闭行为。
5. 没有 ownersFile 时 guardRuntime 直接返回原 runtime，ownsId 通过 owns() 短路，不额外读取 users.json；用会抛错的名单 reader 验证。
6. 飞书维护：名单内用户继续受归属限制；已删除用户的 revoking 记录允许两边幂等重试撤销，串行队列执行时再次读取记录并核对资格，connected 记录不会因此被刷新。
7. 常驻保障保留 `replicas === 0` 的严格判断；null/undefined 均不视为已停用。Docker 不启动常驻保障；缺少 replicas、annotations 的 Docker inspect 仍按原有前台请求流程启动工作区。
8. services.mjs 在本轮开始时已包含上一轮修改，本轮仅追加向 Feishu 传入 migration.assertOwned，以让内部 `/token` 正确区分归属未知的 503 与明确归属对端的 403。market-auth.mjs 的上一轮修改原样保留。

### 测试覆盖与结果

原有断言保留；仅根据本轮明确变更的合同调整“授权回调留本地”“preparing 留本地”“文件缺失放行/坏文件必抛错”等旧期望。新增测试域名使用 `.test` / `.invalid`，本地服务器使用 loopback；没有加入真实部署标识。

- `tools/migration.test.mjs`：18 项通过。覆盖有效缓存和无缓存的缺失/不可读/解析与格式错误、恢复与热更新、运行时写保护、无 migration 时名单读取短路、已删除用户撤销、replicas 的 0/1/null/undefined、暂停注解、Docker inspect 缺字段的前台启动、无归属时 prepare/常驻均不访问运行时。传输测试覆盖预览默认 10 秒超时及文案、可选超时、整站等待 120 秒仍可返回响应头、SSE 持续输出、HTTP/WS 通用 502、WS 双向数据和头保留。
- `node --test-name-pattern='k8s gateway startup|gateway preserves a reused' tools/gateway.test.mjs`：2 项通过。其中不监听端口的网关子进程测试使用流对象模拟 peer，覆盖 feishu 回调、Bearer desktop-token/status、名单内 preparing 转发，登录回调和未登录 preparing 留本地，以及配置文件缺失/损坏时各入口返回 503 并记录日志。
- `node --test-name-pattern='identity and preview preparation' tools/runtime-models.test.mjs`：1 项通过，验证预览凭据存储回归。
- 双网关 TCP 集成用例已补完整 connect → 授权回调 → desktop-token/status 流程，核对回调成功、popup 跳转及授权令牌；另补配置文件故障的公网和内部 `/token` 503、名单不变、无运行时写操作，以及无 migration 时转发、预览、`/token`、常驻保障逐项回归用例。
- 要求命令 `node --test tools/migration.test.mjs tools/gateway.test.mjs` 已执行：迁移测试通过，依赖本地监听的网关集成测试被沙箱 `listen EPERM: operation not permitted 127.0.0.1` 阻断，不能报告整组通过。真实双网关完整授权和 TCP 预览流程须在允许本地监听的环境重跑。
- `bash tools/check.sh` 已执行：语法检查完成，随后既有 `tools/wp-seed.test.py` 创建本地 HTTPServer 时遇到 `PermissionError: [Errno 1] Operation not permitted`，提前退出；未修改检查入口或减少断言。
- `git diff --check` 通过。本机实际 Node 为 v22.22.1；任务要求的 Node 24、真实集群和真实身份提供方联调尚未验证。

### 对其他 K 任务接口的假设

- K2a inspect 合同按协调者本轮决定：`replicas` 为 StatefulSet `spec.replicas`，无则 null；`annotations` 为 StatefulSet 注解，无则 `{}`。本轮假 inspect 按此合同构造，另专门覆盖 undefined 兼容输入。只有数值 0 才进入常驻 start；缺失/未知副本数不触发拉起。Docker 允许两个字段均为 undefined，并保留 main 行为。
- K2a 提供原定 runtime 生命周期、地址、文件和执行方法；K3 不实现、也不修改 runtime/。运行时写操作会在执行前重查归属。常驻保障仍复用 AionUi jobs 表，跳过不存在、暂停、运行中、非零/未知副本和有任务的工作区。
- 两边按 K3 文件合同识别 default 与 slug override，共享签名密钥和相容的用户名单；整站转发保持 Host、Cookie、Authorization、请求体和响应头，并携带防环标记。

### R3 检查清单（仅报告，不改相关代码）

- [ ] k8s 模式 `legacy === null` 时，OLD_HOSTS 请求返回 403，旧名 cookie 不被识别；R3 要核实旧入口迁移与用户重新登录流程。
- [ ] R3 新用户归属由归属文件 default 决定；运维在 R3 将 default 设置为 `k8s`，新人放 k8s 节点。登录和新用户开通回调仍由入口处理，联调时核实新用户开通进入 k8s 网关。
- [ ] 归属文件必须按目录挂载，不能单文件绑定或使用固定文件 inode 的 subPath 挂载；发布通过目录内原子替换，让两边网关看到新 inode 并热更新。
- [ ] 在 Node 24、允许本地监听的环境重跑指定测试和完整 check.sh，再验证真实双网关 HTTP/WS、预览、飞书回调和 K2a 常驻行为。

# T-1182 飞书机器人信息脚本 + 消息桥守护（镜像侧）

## 目标
用户容器里新增一个命令，能报出「已连接的飞书机器人是哪个、在不在线」（不泄露密钥），并且能只重启飞书消息桥（cc-connect），不重启整个容器；扫码开通后不再需要重启容器，消息桥自己拉起。

## 背景
- 工作伙伴每个用户一个容器，启动脚本 `image/bin/start.sh`：只有 `/data/.cc-connect/config.toml` 存在才启动 cc-connect（约 76-79 行），所有服务进 `wait -n`，cc-connect 一退出整个容器就退出并被重建。
- 开通流程：网关 `gateway/feishu-onboarding.mjs` 在容器里执行 `image/bin/feishu-onboard.py`，配置写好后由网关 `runtime.restart(slug)` 重启整个容器（网页会话会断）。
- 飞书凭据在 config.toml 的 `projects[].platforms[].options.app_id` / `app_secret`（见 `image/home/cc-connect-feishu.toml`、`feishu-onboard.py` 124-125 行）。
- cc-connect 的管理接口里 feishu 的 connected 恒为 true，不能当在线状态。真实信号只在 cc-connect 输出的日志里：lark SDK 打印 `connected to <wss地址>`、`disconnected to`、`reconnecting`、`reconnect attempts exhausted`。
- 网关侧（另一个任务 T-1183 并行开发）会以容器用户（uid 1001，partner）执行 `python3 /opt/workpartner/bin/wp-feishu-bot.py <子命令>`，超时 10 秒，只读 stdout 的一行 JSON。下面的输出约定两边都按它写，不要改字段名。
- 后续第 2 步会支持一个用户多个机器人（config.toml 里多个 `[[projects]]`），本次输出已经按数组设计，但本次只需正确处理现有的单机器人和多 projects 读法。

## 要做的事
1. 新增 `image/bin/wp-feishu-bot.py`（随 Dockerfile 现有 `COPY ... image/bin/ /opt/workpartner/bin/` 一起进镜像，不用改 Dockerfile，除非需要可执行位），子命令：
   - `info`：stdout 只输出一行 JSON：
     `{"ok":true,"bots":[{"project":"<项目名>","appId":"cli_xxx","name":"<机器人名>"|null,"avatar":"data:image/...;base64,..."|null,"activate":true|false|null,"online":"online"|"offline"|"unknown","lastEvent":"connected"|"disconnected"|"reconnecting"|"exhausted"|null,"lastEventAt":"<ISO8601>"|null,"error":null|"feishu_unreachable"|"feishu_auth_failed"}]}`
     - 没有 config.toml：`{"ok":true,"bots":[]}`。配置读不了：`{"ok":false,"error":"config_unreadable"}`。
     - 机器人名、头像、activate：用 app_id/app_secret 调 `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal` 换 token，再调 `GET https://open.feishu.cn/open-apis/bot/v3/info`（返回 `bot.app_name`、`bot.avatar_url`、`bot.activate_status`，2 表示已启用）。头像下载后转成 data URL，超过 64KB 就给 null。每次 HTTP 超时 3 秒，整个命令必须在 8 秒内结束。
     - 结果缓存到 `/data/.cc-connect/run/bot-cache.json`（权限 600），按 appId 缓存 10 分钟；缓存有效时不访问飞书。`info --refresh` 忽略缓存。
     - online：cc-connect 进程在跑（读 pid 文件并确认进程存在）且 lastEvent 为 connected → `online`；进程不在 → `offline`；进程在但没有事件记录 → `unknown`；进程在但最后事件是 disconnected/reconnecting/exhausted → `offline`。
     - 飞书接口的基础地址允许用环境变量 `WP_FEISHU_API_BASE` 覆盖（给测试用）。
     - 输出里绝对不能出现 app_secret、token 或任何日志原文。
   - `restart`：只重启 cc-connect（通知第 2 条的守护循环），输出 `{"ok":true}`；守护循环不在时输出 `{"ok":false,"error":"no_supervisor"}`，退出码非 0。
2. 改 `image/bin/start.sh`：把 cc-connect 改成由一个后台守护循环管理，并且**不放进** `service_pids`（cc-connect 退出不再导致容器退出）：
   - config.toml 不存在时，每 3 秒检查一次，出现后自动启动 cc-connect（这样开通后不用重启容器）。
   - cc-connect 退出后自动重启：正常的 `restart` 请求立即重启；异常退出按 2、4、8…最长 60 秒退避，稳定运行 5 分钟后退避清零。
   - pid 写到 `/data/.cc-connect/run/bridge.pid`；`restart` 子命令通过它（或你选的更稳的方式，例如标记文件 + 信号）让循环重启 cc-connect，保证以 uid 1001 执行也有权限。
   - cc-connect 的 stdout/stderr 原样继续输出到容器日志，同时经过一个过滤器，只把上面 4 种连接事件写成 `/data/.cc-connect/run/bridge-state.json`（`{"event":..., "at":...}`，原子写入），不落其他日志内容。每次 cc-connect 新启动时先把状态清成无事件。
   - 保持现有 `mark bridge-started` 等标记的语义（第一次真正启动时打）。容器收到 TERM 时守护循环和 cc-connect 一起退出。
3. 测试（进 `image/tests/`，`bash tools/check.sh` 会跑）：
   - `wp-feishu-bot.py`：用本地假飞书 HTTP 服务（WP_FEISHU_API_BASE 指向它）测 info 的输出字段、缓存命中不再请求、`--refresh`、飞书不可达/鉴权失败时的 error、无配置时空数组、多 projects 读出多个、输出不含 secret；online 各分支（用假 pid 文件和 state 文件）。
   - 守护循环：用 PATH 里的假 cc-connect（打印一行 `connected to wss://x` 后挂起，或立即退出）测：配置出现后被拉起、restart 后换了新 pid、state 文件写成 connected、异常退出会被重启。测试要有超时，不能挂住。

## 范围
- 可以改：`image/bin/start.sh`、新增 `image/bin/wp-feishu-bot.py`、`image/tests/`、需要时 `image/Dockerfile`（只限加可执行位之类）、`docs/`里描述容器启动/飞书开通的文档段落。
- 不要改：`gateway/` 下任何文件（网关侧在 T-1183 里做）、`image/bin/feishu-onboard.py`、`image/rebrand/`。确实需要改时在汇报里说明，不要自己改。

## 验收标准
- [ ] `bash tools/check.sh` 全部通过。
- [ ] 新测试覆盖上面「测试」列出的每一条，且都通过。
- [ ] `python3 image/bin/wp-feishu-bot.py info` 在没有配置的环境里输出 `{"ok":true,"bots":[]}`，退出码 0。
- [ ] 全仓 grep 新代码，没有把 app_secret / tenant_access_token 打印、写日志或写进缓存文件（缓存里只存名字、头像 data URL、activate、时间）。
- [ ] start.sh 里 cc-connect 不在 `service_pids` 里；`shellcheck`（如可用）无新错误。

## 约束
- 不要 git 提交。沙箱禁网，需要新依赖时在汇报里列出，不要自己装；Python 只用标准库（toml 用 tomllib）。
- 只写必要的注释，只解释代码看不出来的原因；代码风格照仓库现有 image/bin 脚本（注释用中文）。
- 测试要测行为：像调用方那样调用，断言具体的期望值。

## 汇报格式
报告写到 `docs/tasks/T-1100/T-1182-feishu-bot-image/report.md`（各轮追加）。用中文：
1. 改了哪些文件，每个文件一句话。
2. 怎么验证的，命令和结果。
3. 需要协调者处理的事：依赖、超出范围的改动、没解决的问题。

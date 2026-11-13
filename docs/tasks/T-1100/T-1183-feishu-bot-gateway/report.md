# T-1183 网关侧报告

## 第一轮（2026-11-13）

### 1. 改了哪些文件

- `gateway/feishu-bot.mjs`：新增动态开关/名单鉴权、信息查询白名单映射、同用户并发合并、同源 JSON 重连接口及供开通流程复用的固定命令执行器。
- `gateway/feishu-bot-client.mjs`：新增“我的飞书机器人”菜单、原生弹层卡片、复制与对话、二次确认重连、首页状态条、可见时 60 秒轮询和重连后 3 秒单次刷新。
- `gateway/feishu-onboarding.mjs`：先重启飞书服务，命令失败才重启容器，保留 restarting、connected 和 aionui.forget 的调用顺序。
- `gateway/gateway.mjs`：挂载接口，并在预览开启和关闭的两处客户端输出中加入按名单返回的脚本。
- `gateway/organization/default.json`：增加默认关闭的 `features.feishuBot` 和空的 `feishuBot.allow`。
- `gateway/tests/feishu-bot.test.mjs`：增加权限、字段过滤、错误脱敏、JSON/同源、命令参数和并发合并的 handler 行为断言。
- `gateway/tests/feishu-bot-client.test.mjs`：执行实际序列化客户端，验证首次加载、60 秒轮询、隐藏暂停、瞬时故障重试和撤权后停止请求。
- `gateway/tests/feishu-onboarding.test.mjs`：覆盖服务重启成功，以及脚本缺失、非零退出、非法 JSON、ok=false 四类回退场景。
- `tools/gateway.test.mjs`：增加真实网关两处拼接的行为测试，覆盖预览开关、功能开关、名单内外和反馈插件共存时的原始脚本字节兼容。
- `tools/browser-tests/feishu-bot.e2e.mjs`：增加三种宽度的状态条/卡片/链接/复制/确认重连/延迟刷新/空数据/名单外/固定关闭按钮/横向溢出断言，以及 SPA 重挂载和撤权用例。
- `tools/browser-tests/lib/harness.mjs`：为假 Docker API 增加独立 exec ID、机器人数据和命令记录，继续使用真实网关处理浏览器请求。
- `tools/browser-tests/run.mjs`：注册 `feishu-bot` 组。
- `.github/workflows/browser-tests.yml`：仅在 matrix 增加 `feishu-bot`。
- `docs/organization.md`：说明配置、首批 tang 开放方式、接口和轮询行为及旧镜像回退。
- `docs/tasks/T-1100/T-1183-feishu-bot-gateway/plan.md`：记录执行步骤和边界选择。
- `docs/tasks/T-1100/T-1183-feishu-bot-gateway/report.md`：记录本轮改动与验证证据。

没有修改 `image/`、其他工作流或依赖清单，没有 git 提交。

### 2. 怎么验证的

| 命令 | 结果 |
| --- | --- |
| `node gateway/tests/feishu-bot.test.mjs` | 5/5 通过；请求直接使用 Node Readable 和响应适配器调用真实 handler，不需要监听 socket。 |
| `node gateway/tests/feishu-bot-client.test.mjs` | 5/5 通过；运行实际输出脚本，浏览器边界和计时器使用内存替身。 |
| `node gateway/tests/feishu-onboarding.test.mjs` | 5/5 通过。 |
| `node --test --test-name-pattern='(feishu bot\|my key) preview on and off' tools/gateway.test.mjs` | 通过；新增飞书和已有 my-key 各 8 组开关/预览/反馈组合，分别断言名单内外输出。 |
| `node --check`（本轮修改和新增的 JS/MJS 文件）及 `git diff --check` | 通过。 |
| `bash tools/check.sh` | 未通过：改动前基线和最终运行均停在现有 `tools/wp-seed.test.py::ModelDiscovery.test_model_permissions_are_read_with_an_identified_client`，创建 HTTPServer 时沙箱报 `PermissionError: [Errno 1] Operation not permitted`；此前脚本语法检查已完成，后续全量测试尚未执行。 |
| `node tools/browser-tests/run.mjs feishu-bot` | 已实际尝试，未通过；测试钩子启动假服务器时 `listen EPERM: operation not permitted 127.0.0.1`。 |
| `node tools/browser-tests/run.mjs menu flow access my-key` | 已实际尝试，四组均未通过；同一个假服务器初始化受沙箱 socket 限制，不能据此判断浏览器回归结果。 |

本机最初缺少工作区 `node_modules`；为诊断而临时引用机器已有的 ws 8.21.3、semver 7.8.5、Playwright 1.64.0 和 Chromium 缓存，没有联网或新增包依赖。指定 `CHROME_PATH=/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` 后仍在监听端口时失败，未进入页面测试；验证后清理临时依赖软链接。Actions 应继续用仓库锁定的 Playwright 1.65.0。

日志保留在 `/tmp/t1183-api.log`、`/tmp/t1183-client.log`、`/tmp/t1183-onboard.log`、`/tmp/t1183-injection.log`、`/tmp/t1183-check.log`、`/tmp/t1183-browser-final.log`、`/tmp/t1183-browser-final-detail.log`、`/tmp/t1183-browser-regressions.log`。

浏览器用例已配置截图路径（本机**未生成**）：

- `tools/browser-tests/output/shots/feishu-bot/home-1280.png`、`dialog-1280.png`
- `tools/browser-tests/output/shots/feishu-bot/home-390.png`、`dialog-390.png`
- `tools/browser-tests/output/shots/feishu-bot/home-360.png`、`dialog-360.png`
- `tools/browser-tests/output/shots/feishu-bot/empty.png`

独立只读代码审查未发现可确认的实现缺陷；审查指出的 SPA 重挂载和运行中撤权覆盖缺口已补充浏览器用例。真实布局、截图和五组浏览器回归仍需 Actions 验证，不能标记为已通过。

### 3. 需要协调者处理的事

1. 在允许本机监听端口的环境运行 `bash tools/check.sh` 和五组浏览器测试，并查看三种宽度截图及 overflow 断言；当前全量检查和浏览器验收尚未完成。
2. 合入 T-1182 的镜像脚本后联调 `info`、`info --refresh`、`restart`，确认新镜像只重启飞书服务且网页会话不中断；旧镜像开通时仍回退容器重启，手动重连接口则返回 503。
3. 首批部署配置需设置 `features.feishuBot: true`、`feishuBot.allow: ["tang"]`；仓库默认保持 false/[]，本轮未修改部署私有配置。
4. 无新增依赖、无超出范围改动；除此之外没有已确认但未修复的代码问题。

实现选择：首页多机器人时显示第一条，弹层显示全部；同一用户已有 info 执行时，后续普通/refresh 请求复用它，由首个请求决定是否带 `--refresh`；重连后 3 秒刷新一次，随后继续 60 秒可见轮询。

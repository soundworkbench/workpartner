# T-1183 「我的飞书机器人」弹层和首页状态条（网关侧）

## 目标
名单内用户在工作伙伴网页里能看到自己连的是哪个飞书机器人（头像、名字、App ID、在线/离线），点「对话」直接跳到飞书里和这个机器人的私聊，能一键「重新连接」；扫码开通后不再重启整个容器（新镜像上），网页会话不断。第一版只对用户 tang 开放。

## 背景
- 现在：首页输入框上方的开通横幅（镜像里的 `image/rebrand/overlay/wp-feishu.js`）在连上后直接消失，界面上没有任何地方显示已连的机器人。
- 按人开关功能的现成写法照抄 my-key：`gateway/my-key.mjs`（`policy()`、`admitted()`、`clientFor(user)` 名单外返回空串）、`gateway/my-key-client.mjs`（往 `.wp-settings-menu` 插菜单项、原生 `<dialog>`、样式用 `var(--wp-*)`，见 `image/rebrand/overlay/wp-overlay.css` 39-65 行，含深色）。配置：`gateway/organization/default.json` 的 `features.*` 默认 false + 顶层 `<功能>.allow`（slug、unionId 或 "*"），每次请求重读 `organizationData()`。文档 `docs/organization.md`。
- 前端脚本拼接点有两处都要加：`gateway/gateway.mjs` 约 90 行的 extraClient 和约 293 行预览关闭时的分支；路由挂在约 303 行，构造在约 101-110 行。
- 容器内命令由并行任务 T-1182 新增：网关用 `runtime.exec(slug, ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', <子命令>], { user: String(uid), timeout: 10000 })` 调用（写法参考 `gateway/feishu-onboarding.mjs` 第 10 行）。约定（不要改字段名）：
  - `info` / `info --refresh` → stdout 一行 JSON：`{"ok":true,"bots":[{"project","appId":"cli_xxx","name"|null,"avatar":"data:image/..."|null,"activate":true|false|null,"online":"online"|"offline"|"unknown","lastEvent","lastEventAt","error":null|"feishu_unreachable"|"feishu_auth_failed"}]}`；没配置时 `bots` 为空数组；失败 `{"ok":false,"error":...}`。
  - `restart` → `{"ok":true}`；旧镜像里没有这个脚本时 exec 会失败（命令不存在/非 0 退出）。
- 打开机器人私聊的链接：`https://applink.feishu.cn/client/bot/open?appId=<appId>`（飞书官方 AppLink）。
- 这个仓库的前端都是原生 JS 注入上游打包好的 AionUi 页面，不能用 React 组件库；本任务照现有 overlay 的原生写法和 `--wp-*` 变量，不引入 @crysound/ui（协调者已定）。

## 要做的事
1. 配置：`default.json` 增加 `features.feishuBot: false` 和顶层 `feishuBot: { "allow": [] }`；`docs/organization.md` 补说明。
2. 新增 `gateway/feishu-bot.mjs`（照 my-key.mjs 的结构）：
   - `GET /_wp/feishu-bot/bots`：登录用户且在名单内才可用，否则 404。执行容器内 `info`（查询参数 `refresh=1` 时带 `--refresh`）。返回白名单字段：`{bots:[{appId,name,avatar,online,activate,lastEventAt,error,openUrl}]}`。appId 必须匹配 `^cli_[A-Za-z0-9]+$` 才生成 `openUrl`，否则丢弃该条；avatar 只接受 `data:image/(png|jpeg|gif|webp);base64,` 开头的，否则置 null；name 截断到 64 字符。容器 exec 失败或超时返回 503 `{error:"unavailable"}`，不把容器输出原文透给浏览器。
   - `POST /_wp/feishu-bot/reconnect`：同源 + JSON 校验（照 feishu-onboarding.mjs 的 start），名单内才可用；执行 `restart`；成功 200 `{ok:true}`，失败 503。
   - 对同一用户的 `info` 调用做并发合并（同时多个请求只跑一次 exec）。
3. 新增 `gateway/feishu-bot-client.mjs`（`clientFor(user)` 名单外返回空串）：
   - 设置菜单（`.wp-settings-menu`）加一项「我的飞书机器人」，点开原生 `<dialog>`：每个机器人一张卡片：头像（无头像时用名字首字的圆形占位）、名字（无名字显示「飞书机器人」）、在线状态圆点+文字（在线/离线/状态未知）、App ID（等宽字体 + 「复制」按钮）、按钮「对话」（新窗口打开 openUrl）、「重新连接」（二次确认后调用 reconnect，完成后 3 秒刷新一次）。右上角「刷新」调用 `refresh=1`。没有机器人时显示一句「还没连接飞书机器人，在首页点「开通」扫码即可」。error 为 feishu_unreachable/feishu_auth_failed 时卡片上用一行小字提示「暂时拿不到机器人信息」。
   - 首页（存在 `[data-testid=guid-input]` 的页面）输入框上方，当至少有 1 个机器人时显示一条紧凑状态条：小头像 + 「飞书机器人：<名字>」+ 状态圆点 + 「对话」+「管理」（打开上面的弹层）。没有机器人时不显示（原开通横幅照旧负责）。页面加载时取一次，之后每 60 秒刷新，页面不可见时暂停。
   - 窄屏（<768px）卡片单列、按钮不溢出、文字不截断（名字过长可换行）。键盘可操作，按钮有可访问名称；弹层关闭按钮不随内容滚动（参照反馈弹层的做法）。
4. 改 `gateway/feishu-onboarding.mjs`：状态为 needs_restart 时，先 exec `restart`；成功就不再 `runtime.restart(slug)`；exec 失败（旧镜像）才回退到原来的 `runtime.restart(slug)`。其余状态流转（restarting → connected → aionui.forget）保持不变。这一条对所有用户生效。
5. 测试：
   - `gateway/tests/feishu-bot.test.mjs`：名单内外（slug、unionId、"*"）、feature 关闭时 404、字段白名单与 appId/avatar 校验、exec 失败/超时返回 503 且不透传原文、reconnect 的同源和 JSON 校验、并发合并只 exec 一次、`clientFor` 名单外为空串、两个拼接点都带上脚本。
   - onboarding 回退逻辑的测试（restart 成功不重启容器；失败才重启容器）。
   - 浏览器测试：新增 `tools/browser-tests/feishu-bot.e2e.mjs`（照 `my-key.e2e.mjs` 的假运行时/假数据方式），在 `.github/workflows/browser-tests.yml` 的 matrix 加 `feishu-bot` 组。覆盖：首页状态条显示名字和在线状态；「对话」链接是正确的 applink；弹层卡片内容、复制 App ID、重新连接调用接口；无机器人时状态条不显示、弹层显示提示；名单外用户看不到菜单项和状态条；1280px 桌面、390px、360px 三个宽度截图存到测试产物目录，并断言无横向溢出。

## 范围
- 可以改：`gateway/`（含 tests）、`tools/browser-tests/`、`tools/gateway.test.mjs`（如需）、`.github/workflows/browser-tests.yml`（只加 matrix 组）、`docs/organization.md` 及相关文档。
- 不要改：`image/` 下任何文件（镜像侧在 T-1182 做）、其他工作流。确实需要改时在汇报里说明，不要自己改。

## 验收标准
- [ ] `bash tools/check.sh` 全部通过。
- [ ] `node tools/browser-tests/run.mjs feishu-bot` 通过，并且原有 `menu`、`flow`、`access`、`my-key` 组仍通过（本机跑不了浏览器就在汇报里写明，由协调者在 Actions 上跑）。
- [ ] 上面「测试」列出的每一条都有对应断言。
- [ ] 默认配置下（features.feishuBot=false）网页行为与改动前完全一致（除 onboarding 的重启回退逻辑）。
- [ ] 接口响应里不出现容器 stdout 原文、app_secret、token。

## 约束
- 不要 git 提交。沙箱禁网，不新增依赖；需要时在汇报里列出。
- 只写必要的注释，风格照 my-key.mjs / my-key-client.mjs。
- 测试要测行为：像调用方那样调用，断言具体的期望值。

## 汇报格式
报告写到 `docs/tasks/T-1100/T-1183-feishu-bot-gateway/report.md`（各轮追加）。用中文：
1. 改了哪些文件，每个文件一句话。
2. 怎么验证的，命令和结果（含截图路径）。
3. 需要协调者处理的事：依赖、超出范围的改动、没解决的问题。

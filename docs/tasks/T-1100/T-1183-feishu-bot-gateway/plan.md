# T-1183 实现计划

目标、接口、字段和验收标准以任务 T-1183 用户说明为准。沿用 my-key 的网关模块、原生注入客户端和现有浏览器假运行时，不新增依赖，不改 image，不提交 git。当前已在任务独立 worktree。

- [x] 接口：先写 HTTP 行为测试，覆盖动态名单、开关、字段过滤、失败、同源 JSON、并发；实现 createFeishuBot({organization, organizationData, authenticate, runtime})，返回 handler 和 clientFor。
- [x] 开通：先写重启行为测试；使用 wp-feishu-bot.py restart，成功不重启容器，失败回退，保持状态流转及 forget。
- [x] 页面：新增 feishuBotClient()，插入菜单、原生 dialog、首页状态条，60 秒可见轮询、重连后 3 秒刷新；接入两处脚本拼接和路由。
- [x] 浏览器：扩展现有假 Docker API，覆盖三个宽度、链接、复制、确认重连、空数据、名单外；run 和 matrix 加 feishu-bot。
- [ ] 验证：bash tools/check.sh；运行 feishu-bot、menu、flow、access、my-key；核对 diff 和报告。

重点边界：恶意字段和脚本注入、动态撤权、同一用户混合 refresh 并发、旧镜像失败、多菜单插件共存与 SPA 重挂载。重连后的 3 秒刷新为单次刷新，随后恢复 60 秒周期。首页多机器人时显示第一条，管理展示全部。

进度：接口/客户端/onboarding 共 15 项单测和脚本拼接集成已通过。独立审查无已确认缺陷；补充 SPA 和撤权浏览器用例。完整 check 与浏览器运行受 socket EPERM 阻塞，未生成截图，详见 report.md。未提交 git。

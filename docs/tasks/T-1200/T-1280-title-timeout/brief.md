# T-1280 Workpartner gateway: longer chat-title timeout and configurable title model

## 目标
工作伙伴网关自动给新会话起标题时，不再因 8 秒超时被大量取消；用哪个模型起标题可以由部署配置指定（以便改走按负载分流的分组或更快的小模型），不再只能固定打 `gpt-6-luna`。

## 背景
- 代码：`gateway/title.mjs` 的 `generate()`（约 64–100 行）。整段流程（读会话、`/v1/models`、`chat/completions`、保存标题）共用一个 `AbortSignal.timeout(8000)`；`json()` 帮助函数（约 14 行）默认也是 8000。模型选择固定优先 `leaf(id) === 'gpt-6-luna'`，按 magpie 的 `/v1/models` 列表实际落到一个固定实例（mp-cx-jifang）。
- 11-17 OpenAI 上游首字时间 p50 约 9.5 秒，导致每天约 5000 次标题请求在网关侧被取消，白白耗额度，且全部集中在同一个实例。
- `createChatTitles` 在 `gateway/gateway.mjs` 约 17 行引入，看它怎么传配置；网关其他配置项怎么从环境变量或组织配置读，照现有写法来。这是公开仓库，代码和注释用英文，风格跟周围一致。

## 要做的事
1. 标题生成总超时改为可配置，默认 30000 毫秒（例如环境变量 `WP_TITLE_TIMEOUT_MS`，非法值回落默认，限制在 5000–120000）。`/v1/models` 这类小请求可以继续用较短超时，但不得短于 8 秒。
2. 起标题的模型改为可配置的优先列表（例如 `WP_TITLE_MODELS=a,b,c`，按顺序取第一个在 `/v1/models` 里出现的 id，按完整 id 或 leaf 匹配）；未配置时保持现有行为（先 `gpt-6-luna`，再退回当前会话模型）。仍然只用列表里真实存在的 id，不凭空拼路由。
3. 补测试（放在 `tools/` 下现有 gateway 测试旁，按仓库习惯）：默认超时 30 秒、非法配置回落、优先列表命中顺序、列表都不存在时回落到旧逻辑、未配置时行为不变。
4. 如 `docs/` 或部署示例里有网关环境变量清单，补上这两个变量的一行说明。

## 范围
- 可以改：`gateway/title.mjs`、必要时 `gateway/gateway.mjs` 里传配置的那几行、`tools/` 下相关测试、环境变量说明文档。
- 不要改：其他文件。

## 验收标准
- [ ] 新增和受影响的测试通过；跑 `node --test tools/<相关测试>.test.mjs`，贴命令和结果（不要跑整套浏览器测试）。
- [ ] 未设置新环境变量时，除超时变为 30 秒外，模型选择行为与改前一致（有测试证明）。

## 约束
- 不要 git 提交；禁网；不要安装依赖。只写必要的注释。

## 汇报格式
报告写到 worktree 里 `docs/tasks/T-1200/T-1280-title-timeout/report.md`（目录不存在就建），中文：改了哪些文件、怎么验证、需要协调者处理的事。

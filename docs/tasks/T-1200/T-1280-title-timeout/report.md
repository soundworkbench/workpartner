# T-1280 标题超时与模型配置报告

## 修改内容

- 修改 `gateway/title.mjs`：标题生成总超时默认 30000 毫秒，配置值非法时回退默认，并将有效值限制在 5000–120000 毫秒；模型列表请求使用独立的 8000 毫秒短期限，同时受总期限约束。
- 修改 `gateway/title.mjs`：新增 `WP_TITLE_MODELS` 优先列表，按配置顺序按完整模型 ID 或 leaf 匹配真实的 `/v1/models` 列表；没有命中时保留原来的 `gpt-6-luna`、当前会话模型回退逻辑。
- 修改 `gateway/gateway.mjs`：把 `WP_TITLE_TIMEOUT_MS` 和 `WP_TITLE_MODELS` 传给标题生成器。
- 新增 `tools/title.test.mjs`：覆盖默认和非法超时配置、范围限制、优先列表顺序、列表未命中回退，以及未配置时的原有模型选择行为。
- 修改 `docs/deployment.md`：补充两个网关环境变量说明。

## 验证

- `node --test tools/title.test.mjs`：通过（退出码 0）。
- `node --check gateway/title.mjs && node --check gateway/gateway.mjs`：通过。
- `git diff --check`：通过。
- `node --test tools/gateway.test.mjs`：当前执行环境禁止本地监听端口，多个 fixture 报 `listen EPERM: operation not permitted 127.0.0.1`，因此无法完成该集成测试；标题相关单元测试不依赖监听端口并已通过。

## 需要协调者处理的事

请在允许本地端口监听的环境中重跑 `node --test tools/gateway.test.mjs`，确认网关集成 fixture。

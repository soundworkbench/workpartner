# T-1185 实施报告

## 第 1 轮（2026-11-13）

### 1. 改动文件

- `gateway/voice.mjs`：新增语音识别路由，逐请求重读开关和名单，校验同源与 WAV 类型，限制 2 MiB 上传及每用户并发，设置 30 秒上游总超时并只返回规定字段。
- `gateway/voice-client.mjs`：新增原生话筒 UI、点按/长按/取消交互、Worklet 与 ScriptProcessor 采音、16 kHz WAV 编码、60 秒限时、临时提示和受控 textarea 光标插入。
- `gateway/gateway.mjs`：在两个客户端拼接点追加语音脚本，并在 `/_wp/` 兜底及主转发读体之前挂载独立路由。
- `gateway/organization/default.json`：增加默认关闭的 `features.voice` 和空的 `voice.allow`。
- `gateway/tests/voice.test.mjs`：新增假 HTTP ASR 的接口测试、WAV/重采样断言和真实网关两处注入的集成测试。
- `gateway/tests/voice-client.test.mjs`：增加可在无浏览器、无监听端口环境执行的录音生命周期和文字插入测试。
- `tools/browser-tests/voice.e2e.mjs`：增加点按、长按、取消、光标、错误提示、权限、名单、重渲染、首页/对话页及三个宽度的截图和布局断言。
- `tools/browser-tests/lib/voice.mjs`：生成本地正弦波 WAV 夹具，提供验证 16 kHz/单声道/16 位 WAV 请求的假 ASR。
- `tools/browser-tests/lib/site.mjs`：仅在 voice 组加入输入框、发送按钮、移动工具栏及模拟 React value tracking 的夹具。
- `tools/browser-tests/lib/harness.mjs`：支持语音名单和 ASR 地址，管理 voice 组音频夹具服务。
- `tools/browser-tests/lib/browser.mjs`：仅向 voice 组 Chrome 添加三个 fake media 参数。
- `tools/browser-tests/run.mjs`：注册 voice 测试组。
- `.github/workflows/browser-tests.yml`：仅在 matrix 中增加 voice。
- `docs/organization.md`：说明配置、tang 首批启用方式、接口映射、录音交互与数据处理边界。
- `docs/tasks/T-1100/T-1185-voice-gateway-client/report.md`：追加本轮实施、验证和协调事项。

语音代码没有音频、识别文本或上游原文日志。成功响应只返回截断后的 `text`；错误响应不包含上游原文。默认值仍为 `false` 和空名单；实际 tang 灰度配置留给协调者操作。未改 `image/`、`asr/`、`deploy/` 或其他工作流，未执行 git 提交。

### 2. 验证

已执行并通过：

- `node gateway/tests/voice-client.test.mjs`：8/8 通过，覆盖手势内创建/resume、权限等待期间取消、提前松开、权限拒绝、Worklet 优先与失败回退、加载中取消、track/Blob URL/定时器释放、短音频、60 秒采样上限、光标替换和追加、错误提示；日志 `tools/browser-tests/output/T-1185-client.log`。
- `node --test gateway/tests/voice-client.test.mjs`：通过。
- `node --test --test-name-pattern='PCM' gateway/tests/voice.test.mjs`：通过，断言 RIFF/WAVE/fmt/data 头、PCM 格式、声道、16 kHz、16 位、字节率、样本数、重采样结果和样本裁剪；日志 `tools/browser-tests/output/T-1185-pcm.log`。
- 对 11 个新增/修改的 JS 模块逐一运行 `node --check`，并解析默认 JSON：通过。
- 分别以 voice 开/关调用 `buildSite()`，用 `vm.Script` 解析生成 HTML 中的内联脚本：通过。
- `git diff --check`：通过。

已执行，但受本机环境阻断：

- `bash tools/check.sh`：未全部通过；前置语法检查完成，随后已有 `tools/wp-seed.test.py` 创建本地 HTTPServer 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`，后续检查未执行；日志 `tools/browser-tests/output/T-1185-check.log`。
- `node --test gateway/tests/voice.test.mjs` / `node gateway/tests/voice.test.mjs`：纯函数用例通过，其余 8 个 HTTP/网关用例在监听 `127.0.0.1` 时遇到 `listen EPERM`，未能验证接口集成；详细日志 `tools/browser-tests/output/T-1185-voice-api.log`。已有 my-key HTTP 测试也受同一限制。
- `node tools/browser-tests/run.mjs voice`：未启动浏览器，缺少仓库已声明的 `playwright-core`，报 `ERR_MODULE_NOT_FOUND`；日志 `tools/browser-tests/output/T-1185-browser-voice.log`。
- `node tools/browser-tests/run.mjs menu flow access my-key`：四个原有组均因相同依赖缺失未启动；日志 `tools/browser-tests/output/T-1185-browser-existing.log`。

浏览器测试已定义六张截图，预期路径为 `tools/browser-tests/output/shots/voice/{1280,390,360}-{home,chat}.png`，每张截图前断言页面无横向溢出、话筒和发送按钮在视口内且矩形不重叠。本机没有产生截图，不能把这些浏览器断言记为已通过。

需求断言对应：

| 要求 | 测试位置 |
| --- | --- |
| slug / unionId / `*` 名单、feature 关闭、坏配置、名单外 client 空串 | `voice.test.mjs` 的 policy 用例 |
| 403、415、超长 Content-Length 和 chunked 413、未读完整个请求体、ASR 未收到请求 | 同文件 checks / oversized 用例 |
| 每用户一路 429、其他用户独立、完成或失败后释放 | 同文件 in-flight / timeout / oversized 用例 |
| 上游状态和非 JSON 映射、连接失败、总超时、无原文/日志泄漏 | 同文件 upstream / timeout 用例 |
| 2000 Unicode 字截断、WAV 和重采样 | 同文件 text / PCM 用例 |
| 两个拼接点、默认关闭和名单外响应字节保持不变 | 同文件 real gateway 用例（按同一用户比较 preview scope） |
| 点按、光标、长按、Esc/移出/pointercancel、无自动发送 | `voice.e2e.mjs` toggle / caret / gestures 用例 |
| busy / unavailable / 空结果 / 短录音 / 权限 / 不支持 / 转圈禁用 / 50–60 秒 | 同文件 messages / permission / timer 用例及 `voice-client.test.mjs` |
| 名单外无按钮、preview 关闭、首页/对话页、克隆跳过、textarea 局部替换和整体重渲染防重复 | `voice.e2e.mjs` admission / layout 用例 |
| 1280、390、360 截图、无横向溢出、不遮挡发送 | 同文件三个 layout 用例 |

### 3. 需要协调者处理

1. 在允许本地监听端口且具备 Chrome/Chromium 的 CI/Actions 上安装仓库现有锁定依赖（现有工作流已有 `npm ci --prefix gateway` 和 `npm ci --prefix tools/browser-tests`），运行 `bash tools/check.sh`、voice 组及 menu/flow/access/my-key 四个回归组，并检查六张截图。本轮没有新增依赖，也未在禁网沙箱中下载安装依赖。
2. 与 T-1184 的 `wp-asr` 联调并部署后，在实际组织配置设置 `features.voice: true`、`voice.allow: ["tang"]`；默认服务地址是 `http://wp-asr:8080`，有差异时通过 `WP_ASR_URL` 指定。本轮没有修改部署或实际组织配置。
3. 合并 T-1183 时保留双方的客户端拼接、路由行和 matrix 组；本轮语音追加表达式和路由单独成行，工作流只增加 voice 一项。
4. 尚未完成的事项是受环境限制的 HTTP/浏览器端到端验收及真实 ASR 联调；当前不能宣称全部验收标准通过。没有其他已知必须越界修改的事项。

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

## 第 2 轮（2026-11-13）

### 1. 改动文件与返工项

- `gateway/tests/voice.test.mjs`：GET 用 `send: req => req.end()` 明确不写请求体，避免污染 keep-alive 连接；增加慢速上传超时、上传期间不访问 ASR、超时释放名额及上传/上游共用截止时间的 HTTP 断言。503 夹具改为真实契约的 JSON `{"error":"busy"}`；非 JSON 503 仍断言 `unavailable`。
- `gateway/voice-client.mjs`：在 document 监听 `lostpointercapture`，匹配当前指针后取消，覆盖目标已脱离 DOM 时事件发到 document 的情况；新 pointerdown 先清除指向已脱离按钮的旧 press 状态。识别会话保存原输入框的具体 data-testid selector，结果优先写回原可见输入框，否则按相同 selector 找当前可见输入框，跳过过渡克隆；找不到时提示「找不到输入框，请返回对话页面后重试」。MutationObserver/resize 用 requestAnimationFrame 合并挂载，safe 包装同步异常及 Promise rejection；录音颜色改为 `var(--wp-danger, #d92d20)`。
- `gateway/voice.mjs`：用单调时钟记录总截止时间，读体阶段也有超时；在 2 MiB 限制内收完整个请求体后才访问 ASR，上游仅使用剩余预算。慢速上传到期返回 408 `unavailable`、关闭连接，清除读体监听器/计时器和缓冲区，finally 释放用户名额。405/403/415 校验及现有上游响应映射保持审核通过的逻辑。
- `gateway/tests/voice-client.test.mjs`：删除按源码字符串边界截取函数后放入 vm 执行的测试；直接 import 已正式导出的 resample/encodeWav，验证采样时长、幅度、RIFF 字段、16 kHz/单声道/16 位、PCM 样本、裁剪和空输入。vm 仅用于完整下发脚本的语法解析，不执行截取片段。
- `gateway/tests/voice-upload.test.mjs`：新增无需监听端口的公开路由处理器测试，以 Node 流、模拟时钟及模拟 HTTP 上游验证慢速读体、429、408、预算扣除、完整体转发、413、中断和名额释放。
- `tools/browser-tests/voice.e2e.mjs`：新增真实页面交互断言，覆盖丢失指针捕获后的取消/track 释放、丢失事件未送达时旧按钮被移除后的再次操作、识别中 textarea 整体重建及光标插入、同 selector 的隐藏/克隆输入框跳过、无输入框提示、MutationObserver 多次变化在一帧只扫描一次、DOM 查询异常后可恢复；将权限等待中的取消/提前结束、Worklet 加载失败回退与加载期间取消/Blob URL 释放等生命周期交给浏览器测试。
- `tools/browser-tests/lib/voice.mjs`：busy 假 ASR 返回 T-1184 约定的 JSON `{"error":"busy"}`，不修改生产映射。
- `docs/organization.md`：补充上传和识别共用 30 秒截止时间、先缓冲再访问 ASR，以及 408 关闭连接/释放名额的行为。
- `docs/tasks/T-1100/T-1185-voice-gateway-client/report.md`：追加本轮改动和真实验证结果。

未新增依赖，未改 `image/`、`asr/`、`deploy/` 或工作流，未执行 git 提交。

### 2. 验证

本轮环境为 Node v22.22.1。已执行并通过：

- `node gateway/tests/voice-client.test.mjs`：4/4 通过；日志 `tools/browser-tests/output/T-1185-round2-client.log`。
- `node gateway/tests/voice-upload.test.mjs`：3/3 通过；日志 `tools/browser-tests/output/T-1185-round2-upload.log`。这些是流和模拟 HTTP 调用测试，不是实际监听端口的 HTTP 集成测试。
- `node --test gateway/tests/voice-client.test.mjs`：通过。
- 对本轮 7 个新增/修改 JS 模块运行 `node --check`：通过。
- `git diff --check`：通过。

已尝试，但未完成验收：

- `node --test gateway/tests/voice.test.mjs` 和 `node gateway/tests/voice.test.mjs`：均失败；本机禁止监听端口，直接执行的 10 个用例均在 `listen 127.0.0.1` 时遇到 EPERM，未进入接口验证，**不能宣称 voice.test.mjs 已通过或接口断言已跑过**。日志分别为 `tools/browser-tests/output/T-1185-round2-voice-api.log`、`tools/browser-tests/output/T-1185-round2-voice-api-direct.log`。
- `bash tools/check.sh`：前置语法检查完成，随后已有 `tools/wp-seed.test.py` 创建 HTTPServer 被拒绝，报 `PermissionError: [Errno 1] Operation not permitted`；后续检查未执行，全量检查未通过。日志 `tools/browser-tests/output/T-1185-round2-check.log`。
- `node tools/browser-tests/run.mjs voice`：缺少仓库已声明的 `playwright-core`，报 ERR_MODULE_NOT_FOUND，未启动浏览器，本轮新增与原有浏览器断言均未执行；日志 `tools/browser-tests/output/T-1185-round2-browser-voice.log`。
- `node tools/browser-tests/run.mjs menu flow access my-key`：四组均因相同依赖缺失未启动；日志 `tools/browser-tests/output/T-1185-round2-browser-existing.log`。

本轮未生成截图。原有六张截图的预期路径仍为 `tools/browser-tests/output/shots/voice/{1280,390,360}-{home,chat}.png`，无溢出/不遮挡断言仍保留，需在浏览器环境实际验证。

### 3. 需要协调者处理

在允许本地监听的 CI/Actions 中准备仓库现有锁定依赖和 Chrome/Chromium，运行 `bash tools/check.sh`、voice 及 menu/flow/access/my-key 浏览器组并检查截图。尤其复核 GET 后连续 403/415 的 keep-alive 回归、新增真实 HTTP 慢速上传用例和浏览器生命周期/重渲染断言。本轮受环境限制不能确认这些集成验收通过；不需要新增依赖或越界改动。

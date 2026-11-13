# T-1185 语音输入：网关转发接口 + 输入框话筒按钮

## 目标
名单内用户在工作伙伴网页的对话输入框旁边看到一个话筒按钮。按住说话、松开后识别，文字填进输入框，不自动发送。识别由集群内服务 `wp-asr` 完成（并行任务 T-1184 在做）。第一版只开给用户 tang。

## 背景
- 按人开关功能照抄 my-key：
  - `gateway/my-key.mjs` 里的 `policy()`、`admitted()`、`clientFor(user)`（名单外返回空串）；
  - `gateway/organization/default.json` 的 `features.*`（默认 false）加顶层 `<功能>.allow`（slug、unionId 或 "*"），每次请求重读；
  - 文档在 `docs/organization.md`。
- 前端脚本靠网关在 `/_wp/preview/client.js` 后面拼接下发：`gateway/gateway.mjs` 约 90 行的 extraClient，和约 291-293 行预览关闭时的分支，两处都要加。路由挂在约 303 行 myKey 那一行附近。必须在 `/_wp/` 的 404 兜底（约 343 行）之前；主转发路径会把整个请求体读进内存，不能让语音请求走到那里。
- 注意：并行任务 T-1183（飞书机器人）也在改 gateway.mjs 的这两处拼接点、路由和 `.github/workflows/browser-tests.yml` 的 matrix。你的改动在这几处要尽量少、各自独立成行，方便合并。
- 可以照抄的写法：
  - 鉴权：`authenticate: req => userFor(req).user`（gateway.mjs 约 118 行）。
  - 同源：`req.headers.origin === origin`，见 feishu-onboarding.mjs:72、my-key.mjs:188,197。
  - 限量读请求体：feedback.mjs:21-28 的 `read(req,max)`，超限返回 413。
  - 访问集群内服务加总超时：my-key.mjs:108-125 的 `upstream()`，和 title.mjs:75,84 用 Service 短名的做法。
- 前端照现有 overlay 的原生 JS 写法，样式用 `var(--wp-*)`（`image/rebrand/overlay/wp-overlay.css` 39-65 行，含深色），不引入 React 或组件库。
  - 输入框是 textarea：对话页 `[data-testid="sendbox-input"]`，首页 `[data-testid="guid-input"]`。
  - 往 React 受控 textarea 写值要先调原生 setter 再派发冒泡 input 事件，见 `image/rebrand/overlay/wp-overlay.js` 727-728 行：`Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true}))`。
  - 按钮位置参照该文件 1482-1489 行模型选择按钮的放法：
    - 桌面：`.sendbox-panel .sendbox-actions`；
    - 首页：`[class*="_guidInputInner"] [class*="_actionSubmit"]` 旁边；
    - 手机单行布局：`.sendbox-tools-mobile-compact`；
    - 跳过克隆出来的 `.wp-transition-composer`；
    - 页面重渲染后要能重新插回（MutationObserver，防重复插入）。
  - 只读参考，不要改 `image/`。

## 要做的事
1. 配置：`default.json` 加 `features.voice: false` 和顶层 `voice: { "allow": [] }`；`docs/organization.md` 补说明。
2. 新增 `gateway/voice.mjs`：`POST /_wp/api/voice/recognize`。
   - 规则：
     - feature 关或不在名单返回 404；
     - 不同源返回 403；
     - Content-Type 不是 `audio/wav` 返回 415；
     - 请求体超过 2MiB 返回 413，超限立即停止读取；
     - 同一用户已有一个识别在进行返回 429 `{error:"busy"}`。
   - 转发：POST 到 `WP_ASR_URL`（默认 `http://wp-asr:8080`）的 `/v1/recognize`，总超时 30 秒。
   - 响应映射：
     - 上游 200 → 200 `{text}`，text 截断到 2000 字；
     - 上游 400 → 400 `{error:"bad_audio"}` 或 `{error:"too_long"}`（只透传这两个已知值）；
     - 上游 503 → 503 `{error:"busy"}`；
     - 其它（连不上、超时、非 JSON）→ 503 `{error:"unavailable"}`。
   - 不透传上游原文，不在日志里记音频或识别文字。
3. 新增 `gateway/voice-client.mjs`，`clientFor(user)` 名单外返回空串。
   - 按钮：
     - 圆形话筒图标按钮，`aria-label="语音输入"`；
     - 样式 `touch-action:none; user-select:none`，并阻止 contextmenu，避免手机长按选字。
   - 交互：
     - 按下超过 300ms 视为「按住说话」，松开结束；
     - 短按一下视为「开始」，再点一下结束；
     - 录音中按 Esc 或手指移出按钮后松开，视为取消，不识别。
   - 录音：
     - 在用户手势里创建或 resume `AudioContext`，用 `getUserMedia({audio:true})`；
     - 优先 AudioWorklet（用 Blob URL 加载 worklet 代码），不支持时回退 ScriptProcessor；
     - 采 Float32 PCM，重采样到 16000Hz，编码成 16 位单声道 WAV，结束后 stop 所有 track。
   - 状态显示：
     - 录音中按钮变红，旁边显示已录秒数；
     - 60 秒自动停止并识别，50 秒起提示即将结束；
     - 识别中按钮转圈，期间禁用。
   - 结果写入：插入到 textarea 当前光标处（没有焦点时追加到末尾，和原文之间按需补一个空格），用原生 setter + input 事件，然后聚焦并把光标放到插入内容之后。不触发发送。
   - 错误提示（用一个小的临时提示条，3 秒消失，不用 alert）：
     - 没权限：「没有麦克风权限，请在浏览器设置里允许」；
     - 浏览器不支持（无 `navigator.mediaDevices` 或非安全上下文）：按钮置灰，title 写原因，点了也给这句提示；
     - busy：「识别忙，请稍后再试」；
     - unavailable：「语音识别暂时不可用」；
     - 空结果：「没听清，请再说一次」；
     - 录音不足 0.5 秒：「说话时间太短」。
4. 测试：
   - `gateway/tests/voice.test.mjs`，用假的上游 HTTP 服务。覆盖：
     - 名单内外（slug、unionId、"*"），feature 关时 404；
     - 403、415、413（断言没有读完整个请求体，上游没收到请求）；
     - 每人一路 429，第一个结束后可以再请求；
     - 上游各种响应的映射，以及不透传原文；
     - 超时返回 503；
     - text 截断；
     - `clientFor` 名单外为空串；
     - 两个拼接点都带上脚本。
   - 前端 WAV 编码和重采样函数要能单独测：导出纯函数，或在测试里加载脚本取出，断言 RIFF 头字段、采样率 16000、样本数。
   - 浏览器测试 `tools/browser-tests/voice.e2e.mjs`，照 `my-key.e2e.mjs` 的假运行时/假数据方式：
     - 夹具页面补上 sendbox textarea 和 actions 骨架；
     - Chrome 加 `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<夹具 wav>`，在 `tools/browser-tests/lib/browser.mjs` 里只对 voice 组加，别影响其他组；
     - 假 ASR 上游断言收到的是 16k 单声道 16 位 WAV，返回固定文字。
   - 浏览器测试的覆盖点：
     - 点按开始、再点结束后，文字出现在输入框且没有发送；
     - 输入框已有文字时插在光标处；
     - 按住松开路径；
     - 取消路径（Esc）不发请求；
     - busy 和 unavailable 的提示文字；
     - 名单外用户看不到按钮；
     - 首页和对话页都有按钮。
   - 截图：1280px、390px、360px 三个宽度，存测试产物目录，并断言无横向溢出、按钮不遮挡发送按钮。
   - `.github/workflows/browser-tests.yml` 的 matrix 加 `voice` 组。

## 范围
- 可以改：`gateway/`（含 tests）、`tools/browser-tests/`、`.github/workflows/browser-tests.yml`（只加 matrix 组）、`docs/organization.md`。
- 不要改：`image/`、`asr/`、`deploy/`、其它工作流。确实需要改时在汇报里说明，不要自己改。

## 验收标准
- [ ] `bash tools/check.sh` 全部通过。
- [ ] `node tools/browser-tests/run.mjs voice` 通过，原有 `menu`、`flow`、`access`、`my-key` 组仍通过（本机跑不了浏览器就在汇报里写明，由协调者在 Actions 上跑）。
- [ ] 上面「测试」列出的每一条都有对应断言。
- [ ] 默认配置（features.voice=false）下网页行为和改动前完全一致。
- [ ] 接口响应和日志里不出现音频内容、识别文字（成功响应本身除外）、上游原文。

## 约束
- 不要 git 提交。沙箱禁网，不新增依赖；需要时在汇报里列出。
- 只写必要的注释，风格照 my-key.mjs / my-key-client.mjs。
- 测试测行为：像调用方那样调用，断言具体的期望值。

## 汇报格式
报告写到 `docs/tasks/T-1100/T-1185-voice-gateway-client/report.md`（各轮追加）。用中文：
1. 改了哪些文件，每个文件一句话。
2. 怎么验证的，命令和结果（含截图路径）。
3. 需要协调者处理的事：依赖、超出范围的改动、没解决的问题。

# T-1190 语音话筒按钮位置

## 根因

原挂载逻辑按容器分支定位：首页把 `_actionSubmit` 容器当作发送按钮，插到了 `_actionRow` 中间；手机对话页单行退回左侧加号工具栏；多行则 append 到发送按钮后面。旧夹具把发送按钮直接放进这些容器，掩盖了真实 AionUI 2.1.47 结构下的问题。

## 改动

- `gateway/voice-client.mjs`：在输入框最近的 `.sendbox-panel` / `_guidInputInner` 内查找真实发送 testid 或 `.sendbox-stop-button`，用同父元素的 `insertBefore` 放到按钮紧左边；仅父元素或紧邻关系变化时移动。没有发送／停止按钮时不挂载。`.wp-voice` margin 改为 0，其余样式不变。
- `tools/browser-tests/lib/site.mjs`：仅语音模式重建首页、手机单行、对话页多行三种结构，使用真实 testid、哈希类名和 flex CSS。加入静态长模型名、停止切换、token 后插入及单行／多行切换开关。形态切换保留 textarea，但替换发送按钮父元素；手机多行移除 `.wp-pick-row`。仅在语音测试生成的脚本中跳过动态模型选择器，由静态按钮模拟模型宽度，不修改 `image/` 文件。
- `tools/browser-tests/voice.e2e.mjs`：在 1280、390、360 宽度验证 DOM 紧邻关系、模型在先、水平坐标、不重叠、不溢出和话筒唯一性；覆盖发送→停止→发送、token 后插入、手机单行→多行→单行、重渲染、过渡克隆、缺少发送按钮，以及无关 DOM 变化不重复移动话筒。
- 截图沿用 `tools/browser-tests/output/shots/voice/`（或 `BROWSER_TESTS_OUTPUT/shots/voice/`）：`1280-home.png`、`1280-chat-multi.png`，以及 390、360 各自的 `home`、`chat-single`、`chat-multi`，共 8 张，由浏览器测试生成。
- `gateway/tests/voice-client.test.mjs` 没有挂载相关用例，无需同步修改；组织文档没有旧按钮位置描述。未新增依赖，未修改 `image/`、`asr/`、`deploy/`，未做 git 提交。

## 验证结果

- 沙箱内运行指定命令时，`voice.test.mjs` 因禁止监听端口出现 `listen EPERM: operation not permitted 127.0.0.1`；审核员在宿主机实跑 `node --test gateway/tests/voice-client.test.mjs gateway/tests/voice.test.mjs gateway/tests/voice-upload.test.mjs`，17/17 通过。
- `node --check`：三个修改的 `.mjs` 文件全部通过；`git diff --check` 通过。
- 实际调用新旧 `buildSite`，非语音模式生成的 9 个文件与 HEAD 版本逐字节一致，因此 feishu-bot、my-key、menu、flow、access 使用的夹具不变。
- 实际生成语音站点，以 `node:vm` 编译内联脚本和生成后的覆盖层脚本，均通过。
- 本机无法监听端口，且未安装浏览器测试所需的 `playwright-core`；未运行浏览器 E2E，未生成本地截图。浏览器测试和截图以现有 GitHub Actions 的 voice 任务结果为准。此次未提交，未触发或宣称 CI 已通过。

## 第 2 轮

- 将报告从仓库根目录移动到本任务目录 `docs/tasks/T-1100/T-1190-voice-mic-placement/report.md`，根目录不再保留 `report.md`。
- 更新验证结果：说明沙箱内的 `listen EPERM` 限制，并记录审核员在宿主机执行指定单测命令后 17/17 通过。
- `tools/browser-tests/lib/site.mjs` 在语音夹具替换 `modelPicker` 前检查 `function modelPicker() {` 是否存在；若签名变化则抛错，提示同步夹具。

本轮验证：运行 `node --check gateway/voice-client.mjs`、`node --check tools/browser-tests/lib/site.mjs`、`node --check tools/browser-tests/voice.e2e.mjs`，以及 `git diff --check`。以上检查通过。单测命令在沙箱内受 `listen EPERM` 限制；宿主机实跑结果为 17/17 通过。浏览器 E2E 依 GitHub Actions，未在本地运行；未提交 git。

## 第 3 轮

### 根因

源码核查支持协调者判断：布局用例将 `#voice-composer` 克隆后清空 id，追加到 body；语音夹具的宽度、textarea、flex、按钮和手机断点规则却全部依赖该 id。克隆因此丢失布局约束，并参与普通文档流，与 CI 中仅克隆后的 390/360 页面 overflow 失败吻合。真实 `image/rebrand/overlay/wp-overlay.js` 的 `ghostShow()` 保留克隆的类名样式，并按源元素矩形设置固定定位；本轮修正夹具模拟，不修改产品逻辑。

### 改动

- `tools/browser-tests/lib/site.mjs`：语音布局规则统一以 `:is(#voice-composer, .wp-transition-composer)` 为前缀，包括手机断点，让克隆在移除 id 后仍保留相同布局，模拟真实上游类名样式。规则仍仅在 voice 模式生成。
- `tools/browser-tests/voice.e2e.mjs`：克隆按源输入框的 left/top/width/height 固定定位，设置零 margin、禁用指针事件、`aria-hidden` 和 `inert`，对应真实 `ghostShow()` 的初始克隆行为。保留可见克隆及其布局，不通过隐藏或裁剪溢出来绕过检查。
- 所有 overflow、位置及唯一性断言保持不变；未修改 `gateway/voice-client.mjs`。
- 已核对截图调用链：每个宽度先测试 conversation，再测试 guid；之前 conversation 的克隆断言失败会提前退出，无法到达首页截图。该阶段通过并继续到首页位置检查后，现有 `suite.shot()` 会生成 `tools/browser-tests/output/shots/voice/390-home.png` 和 `360-home.png`（可由 `BROWSER_TESTS_OUTPUT` 改写输出根目录）；现有 Actions 上传该输出目录，无需修改截图逻辑。

### 验证

- `node --check tools/browser-tests/lib/site.mjs`、`node --check tools/browser-tests/voice.e2e.mjs`：通过。
- `git diff --check`：通过。
- 按要求未在本地运行浏览器 E2E，未生成本地截图；390/360 用例通过及两张首页截图的实际产出需以 GitHub Actions 的 voice 组结果确认。本轮未提交 git。

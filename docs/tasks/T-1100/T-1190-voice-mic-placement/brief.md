# T-1190 语音话筒按钮位置：统一放在发送按钮左边、模型按钮右边

仓库 soundworkbench/workpartner，分支 `T-1190-voice-mic-placement`，基于 main。不要 git 提交，提交由协调者完成。

## 背景
T-1185 给输入框加了话筒按钮（`gateway/voice-client.mjs` 的 `mount()`）。用户在手机上试用后反馈：话筒跑到输入栏中间。要求：**首页和对话页统一放在发送按钮左边、模型按钮右边**（模型按钮是覆盖层注入的 `button.wp-pick-btn`，总是它所在容器的第一个子元素）。

## 真实 AionUI 2.1.47 结构（已调研，手机断点 `window.innerWidth<768`）

对话页，手机单行状态（手机初始状态）：
```
div.sendbox-panel
├ div.flex.items-center.gap-2.w-full.min-w-0.overflow-hidden
│ ├ div.sendbox-tools.sendbox-tools-mobile-compact   (左边，只有加号 button[data-testid=sendbox-mobile-plus-btn])
│ ├ div.sendbox-highlight-container (flex:1) > textarea[data-testid=sendbox-input]
│ └ div.flex.items-center.gap-2      (无类名，发送按钮的父元素)
│     ├ (token 用量圆环，可能没有)
│     └ button.send-button-custom[data-testid=sendbox-send-btn]  或  button.sendbox-stop-button(无 testid)
└ div.wp-pick-row (覆盖层追加，display:flex; justify-content:flex-end) > button.wp-pick-btn
```
对话页多行状态（桌面始终如此，手机文字变长时切换）：
```
div.sendbox-panel
├ div.w-full.overflow-hidden > div.sendbox-highlight-container > textarea[data-testid=sendbox-input]
└ div.flex.items-center.justify-between.gap-2.w-full
  ├ div.sendbox-tools(桌面) | div.sendbox-tools-mobile-compact(手机，只有加号)
  └ div.sendbox-actions.flex.items-center.gap-2
      ├ button.wp-pick-btn (覆盖层，firstChild)
      ├ 权限模式选择（仅桌面）
      ├ token 圆环（可能没有）
      └ 发送 [data-testid=sendbox-send-btn] / 停止 .sendbox-stop-button
```
单行/多行切换时 React 会整体替换发送按钮的父元素；多行时覆盖层会删掉 `.wp-pick-row`。

首页（guid 页，桌面和手机结构相同）：
```
div._guidInputInner_<hash> > textarea[data-testid=guid-input] …
└ div._actionRow_<hash> (display:flex; justify-content:space-between; align-items:flex-end; gap:8px)
  ├ div._actionTools_<hash> (inline-flex; 手机 flex:1 1 auto; overflow-x:auto)
  │   └ div._actionEntry_<hash> > button[data-testid=file-upload-btn]
  └ div._actionSubmit_<hash> (display:flex; gap:6px; margin-left:auto; 手机 flex-shrink:0; margin-left:8px)
      ├ button.wp-pick-btn (覆盖层，firstChild)
      ├ div._actionConfigGroup_<hash> (覆盖层 CSS 隐藏)
      └ button.send-button-custom[data-testid=guid-send-btn]
```

## 现在错在哪
- 首页：代码把 `_actionSubmit` 当发送按钮，`insertBefore(wrap, submit)` 把话筒插进了 `_actionRow`，夹在加号区和 `_actionSubmit` 之间，手机上落在中间。
- 对话页手机单行：退到 `.sendbox-tools-mobile-compact`，话筒跑到输入框左边。
- 对话页多行：`append` 到 `.sendbox-actions`，话筒跑到发送按钮右边。

## 必改
1. `mount()` 改成：在 `area.closest('.sendbox-panel, [class*="_guidInputInner"]')` 里找发送/停止按钮
   `[data-testid="sendbox-send-btn"], [data-testid="guid-send-btn"], .sendbox-stop-button`，
   把话筒插到它前面（同一父元素，`insertBefore`）；当 `wrap.parentElement !== slot || wrap.nextElementSibling !== send` 时才移动，避免 MutationObserver 反复触发。删掉原来 `visible(actions)` / `compact` / `submit` 三套分支。找不到发送按钮就不挂。
   - 发送和停止按钮互相切换、token 圆环后插入时，话筒都要回到发送/停止按钮紧左边。
2. `.wp-voice` 的 `margin:0 4px` 改为 `margin:0`（容器自带 gap）。其他样式不变。
3. 结果应为：
   - 桌面对话页：`[模型][权限][圆环][话筒][发送]`
   - 手机对话页多行：`[+] …… [模型][圆环][话筒][发送]`
   - 手机对话页单行：`[+][输入框][话筒][发送]`，模型按钮在下一行靠右（覆盖层既有设计，本任务不改 image/ 下的 wp-overlay.js）
   - 首页（桌面和手机）：`[+] …… [模型][话筒][发送]`

## 夹具和测试（必须按真实结构重写，旧夹具恰好掩盖了这个 bug）
- `tools/browser-tests/lib/site.mjs`：按上面三棵树重写语音相关的输入栏夹具：
  - 发送按钮用真实 testid（`sendbox-send-btn` / `guid-send-btn`），提供停止按钮 `.sendbox-stop-button` 的切换开关；
  - 首页做出 `_actionRow > _actionTools(_actionEntry > 加号) + _actionSubmit(.wp-pick-btn + 发送)`，类名带哈希后缀，照抄上面的 flex CSS，包括 `@media (max-width:768px)` 下 `_actionTools{flex:1 1 auto}`、`_actionSubmit{flex-shrink:0;margin-left:8px}`；
  - 对话页做出单行/多行两种形态：手机宽度默认单行（含 `.wp-pick-row`），可用开关切到多行（删掉 `.wp-pick-row`，替换发送按钮父元素）；桌面始终多行；
  - 放静态的 `.wp-pick-btn`，带一段较长模型名文字（模拟真实宽度）；
  - 不要破坏其他测试组（feishu-bot、my-key、menu、flow、access）用到的夹具结构，改动尽量只影响语音相关路径；如果共用，跑一遍受影响的测试组。
- `tools/browser-tests/voice.e2e.mjs`：
  - 原来引用 `[data-testid="send"]` 的地方改成真实 testid；
  - 第 311 行附近「话筒在 `.sendbox-tools-mobile-compact` 里」的断言改为：话筒 wrap 的 `nextElementSibling` 是发送（或停止）按钮；同一父元素中有 `.wp-pick-btn` 时它在话筒之前；
  - 加水平坐标断言（1280、390、360 三个宽度，首页和对话页多行）：模型按钮 right ≤ 话筒 left < 话筒 right ≤ 发送按钮 left；手机对话页单行断言话筒紧挨发送按钮左边且在输入框右边；
  - 加用例：发送 → 停止 → 发送切换后、单行 → 多行 → 单行切换后，话筒仍紧挨发送/停止按钮左边，且页面上只有一个话筒；
  - 截图：首页和对话页在 1280、390、360 下各一张（对话页手机单行、多行各一张），放到测试已有的截图目录里。
- `gateway/tests/voice-client.test.mjs`（如存在相关挂载用例）同步改。

## 范围
- 能改：`gateway/voice-client.mjs`、`gateway/tests/voice-client.test.mjs`、`tools/browser-tests/voice.e2e.mjs`、`tools/browser-tests/lib/site.mjs`、`docs/organization.md`（如有描述按钮位置的句子），以及本任务 report.md。
- 不改 image/、asr/、deploy/，不加依赖。

## 本机测试
- 单测：`node --test gateway/tests/voice-client.test.mjs gateway/tests/voice.test.mjs gateway/tests/voice-upload.test.mjs`，必须通过。
- 浏览器测试本机起不了监听端口（listen EPERM），以 GitHub Actions 为准；改过的文件都要 `node --check` 通过。
- report.md 写清根因、改动、测试结果。

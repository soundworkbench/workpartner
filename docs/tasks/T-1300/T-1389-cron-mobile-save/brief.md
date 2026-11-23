# T-1389 工作伙伴「自动化」弹窗：手机端输入框字号 ≥16px；查清高级 Cron 老任务点保存无反应

## 目标
1. 手机(宽度 <768px)上打开「新建/编辑自动化」弹窗，里面所有输入框(包括下拉选择里的搜索输入框、时间选择框、文本框)计算字号都不小于 16px，iOS 点进去不再自动放大页面。
2. 一个表达式只能用「高级 Cron 表达式」显示的老任务(例如 `0,30 1-2 * * *`)，打开编辑、不改任何东西直接点保存，要和别的老任务一样：发出保存请求、表达式一字不变、弹窗关闭。

## 背景
- 仓库是公开仓库 soundworkbench/workpartner，基准分支 `main`(当前 41a540b，已含刚合并的「按时间段」功能)。
- 「自动化」页是 AionUi 2.1.47 网页版自带的定时任务页。前端是第三方压缩产物，构建镜像时 `image/rebrand/rebrand.py` 按 `UI_PATCHES`(原文锚点 → 替换，每个锚点在全部原始 js 里必须恰好命中 1 次)打补丁，再把 `image/rebrand/overlay/*.js` 拼成 `wp-overlay.js`；样式在 `image/rebrand/overlay/wp-overlay.css`。
- 上一个任务新增了 `image/rebrand/overlay/wp-cron-window.js`、`rebrand.py` 末尾一组 cron 相关补丁(改了 `M`/`vt`/`xt`/`yt`/`re`/重复方式下拉/表单/提交 `je`/`Obo`)，以及 `tools/cron-window.test.mjs`、`tools/cron-window-patches.test.mjs`、`tools/fixtures/aionui-2.1.47-cron.js`。
- 本机有一份解包好的 AionUi 2.1.47 静态资源(只读)：`/root/build/notes/wp-kong-img/pkg/aionui-web/static/`，表单在 `assets/jobAgentMeta-D3UNrFgf.js`，列表在 `assets/index-DtMbFZNb.js`。
- 实测现象(浏览器 Playwright，打过补丁的产物)：
  - 390/360 宽度下 `.wp-cron-window` 面板里的 input 计算字号是 14px(arco Select 内部搜索输入框等)。弹窗里其他原生输入框没逐个量过，一并检查。
  - 预置老任务 `0,30 1-2 * * *`，打开编辑：频率显示「自定义」、重复方式「高级 Cron 表达式」；不改直接点保存，没有发出任何请求(PUT 没发)、弹窗不关、也没看到报错提示。其他 13 条老表达式(`0 9 * * *`、`0 9 * * MON,WED`、`*/5 * * * *`、`0 9 15 * *`、`15 10 * * MON-FRI`、`0 * * * *`、`*/30 1-2 * * MON`、`30 8 * * MON-FRI`、`0 */2 * * *`、`*/30 1-2 * * *` 等)同样操作都正常保存。
  - 还不知道这是原生 AionUi 就有的问题，还是上一个任务的补丁(特别是提交 `je` 的拦截、`yt`/`vt` 改动、或 window 模式下隐藏「生成的 Cron」预览的那段)引入的。

## 要做的事
1. **字号**：在 `wp-overlay.css` 里加一段 `@media (max-width: 767px)` 规则，让自动化弹窗里的 `input`、`textarea`、arco Select/TimePicker/InputNumber 的输入元素计算字号 ≥16px。选择器要限定在自动化弹窗范围内(用 `.wp-cron-window` 以及你在原生代码里找到的该弹窗稳定类名/结构；找不到稳定类名就在 `rebrand.py` 里给该弹窗加一个 `wp-cron-modal` 类名的补丁)，不要影响站点其他页面。桌面宽度样式不变。
2. **保存无反应**：
   a. 读原生 `jobAgentMeta-D3UNrFgf.js`，弄清「高级」模式下表单字段、校验规则(`u.validate()` 校验了哪些字段、高级表达式输入框的 rules)和 `je` 提交流程；再对照打过补丁的版本，判断 `0,30 1-2 * * *` 打开后哪一步失败(校验失败但错误没显示？字段被隐藏但仍必填？`je` 拦截误判？`yt`/`vt` 返回的状态缺字段？)。
   b. 在报告里写清结论：原生就有 / 补丁引入，以及具体原因(引用压缩代码片段前 80 个字符和所在文件)。
   c. 修复：不管是哪种原因，都在补丁层修好(改 `rebrand.py` 里已有的 cron 补丁或新增补丁、或 `wp-cron-window.js`)，让「高级」模式的老任务不改直接保存能发出请求，且 `expr` 原样不变；用户在高级模式里真把表达式改坏时，仍要有原生的错误提示而不是静默。
3. **测试**：在 `tools/cron-window-patches.test.mjs` 里补行为测试，覆盖「高级模式老表达式不改保存」的失败点(fixture 不够就从真实资源逐字补摘相关片段到 `tools/fixtures/aionui-2.1.47-cron.js`，新增锚点同样断言在 fixture 中恰好命中 1 次)；如果原因只能在真实浏览器里复现，就把可复现的逻辑部分测掉，并在报告里写清协调者怎么在浏览器里验证。字号规则加一条简单断言(例如测试读取 css 文本，确认在 767px 媒体查询下这些选择器有 `font-size: 16px`)即可。

## 范围
- 可以改：`image/rebrand/overlay/wp-overlay.css`(只加自动化弹窗相关规则)、`image/rebrand/rebrand.py`(只改/加 cron 相关的 `UI_PATCHES`)、`image/rebrand/overlay/wp-cron-window.js`、`tools/cron-window.test.mjs`、`tools/cron-window-patches.test.mjs`、`tools/fixtures/aionui-2.1.47-cron.js`。
- 不要改：`image/rebrand/overlay/wp-skills.js`、`gateway/**`、`image/bin/*`、`image/skills/**`、`org/**`、`.github/workflows/*`、`image/Dockerfile`、`image/third-party.lock.json`、`wp-overlay.js` 里已有的 cron 请求拦截。确实需要改时在汇报里说明原因，不要自己改。

## 验收标准
- [ ] AC-1 `node --test tools/cron-window.test.mjs tools/cron-window-patches.test.mjs` 全部通过，且新增测试在修复前会失败(报告里说明怎么确认的，例如临时还原补丁跑一次)。
- [ ] AC-2 `node --test tools/*.test.mjs` 通过(能跑 `bash tools/check.sh` 就跑；沙箱权限导致的失败写清原因)。
- [ ] AC-3 真实资源演练成功：
      `rm -rf /tmp/t1389-static-wp /tmp/t1389-brand && python3 -I image/rebrand/rebrand.py /root/build/notes/wp-kong-img/pkg/aionui-web/static /tmp/t1389-static-wp /tmp/t1389-brand image/rebrand/overlay image/streaming/smooth-text.mjs`
      退出码 0，所有补丁锚点都是 1 处；输出最后 30 行贴进汇报。演练产物不要放进仓库。
- [ ] AC-4(协调者补跑)浏览器：390×844、360×800 下自动化弹窗(含「按时间段」面板)所有 input/textarea 计算字号 ≥16px，无横向溢出；1440 宽度样式不变。
- [ ] AC-5(协调者补跑)浏览器：预置 `0,30 1-2 * * *` 打开编辑不改点保存，发出 PUT、存储的 expr 不变、弹窗关闭；之前 13 条老表达式照样通过；高级模式把表达式改成非法值点保存，有错误提示、不发请求。
- [ ] AC-6 PR 上「Linux tests」「Browser tests」通过(协调者推送后核对)。

## 测试环境
- 本机 codex 沙箱(workspace-write，禁网，不能起 Chromium，可能不能监听端口)。node v22，python3 3.14。
- worktree 里如果没有 `gateway/node_modules` 而测试需要，就软链到 `/root/build/notes/zp-gh/wp-src/gateway/node_modules`(先 `ls -ld` 确认它不是真实目录)。新测试只用 node 内置模块。
- 协调者补跑命令(请在报告里给出可直接用的版本)：
  `/root/build/notes/wp-kong-img/pkg/aionui-web/aionui-web start --static-dir /tmp/t1389-static-wp --port 25899 --no-open --data-dir /tmp/t1389-data`，用 Playwright 打开 `#/scheduled`，老任务通过 `/api/cron/jobs` 预置。要和原生对比时，用未打补丁的 `static/` 目录再起一份。

## 约束
- 不要 git 提交、推送、打镜像、部署。禁网；需要新依赖时在汇报里列出，不要自己安装(本任务预期不需要)。
- 不改后端 aioncore，不改 `/api/cron/jobs` 请求体结构。
- 工作伙伴前端是 AionUi 原生(arco)加 overlay，不用 CRYSOUND 设计系统，照现有风格。
- 公开仓库：代码、注释、测试、fixture 里不写内部人名、内网地址、台账编号、内部服务器信息。
- 只写必要的注释，只解释代码看不出来的原因。
- 测试测行为，断言具体期望值。
- 查看任何含凭据的配置只能用 `cfg-peek`(本任务预期不需要)。

## 汇报格式
报告写到 `task-paths report T-1389-cron-mobile-save` 给出的路径；各轮追加到同一文件。用中文写：
1. 改了哪些文件，每个文件一句话；新增/改动的补丁锚点(前 60 个字符)和作用。
2. 「保存无反应」的结论：原生还是补丁引入、具体原因。
3. 怎么验证的：命令和结果(含 AC-3 输出末尾、`git diff --stat main`)。
4. 需要协调者处理的事：浏览器补跑命令、没解决的问题、超出范围的改动。

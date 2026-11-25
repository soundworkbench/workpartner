# T-1389 Cron 移动端与高级表达式修复

## 1. 改动

- `image/rebrand/overlay/wp-overlay.css`：在 `@media (max-width: 767px)` 下为 `.wp-cron-modal` 内的 `input`、`textarea`、Arco Select/TimePicker/InputNumber 输入元素统一设置 `font-size: 16px`；保留 `.wp-cron-window` 限定，桌面端规则不变。
- `image/rebrand/rebrand.py`：新增 3 个 Cron 补丁锚点：
  - `u.setFieldsValue({name:n.name,assistant:o,prompt:n.target.payload.text})`：编辑初始化时同步 `customCronExpr`，使高级老表达式通过原生必填校验。
  - `g.mode==="advanced"&&t.createElement(E,{label:a("cron.page.form.cronExpr"),field:"customCronExpr"...`：为高级表达式增加原生 Form validator，并在输入变化时同步表单字段；非法表达式由原生表单错误流程提示且不会提交。
  - `className:"w-[min(560px,calc(100vw-32px))] max-w-560px"`：给自动化弹窗增加稳定类名 `wp-cron-modal`，供移动端 CSS 限定范围。
- `image/rebrand/overlay/wp-cron-window.js`：增加高级 Cron 五字段及范围校验 `validateAdvanced`，保留原有表达式内容；供原生 Form validator 调用。
- `tools/fixtures/aionui-2.1.47-cron.js`：补入上述原生表单初始化、字段和弹窗锚点的逐字测试摘录。
- `tools/cron-window-patches.test.mjs`：新增高级老表达式初始化/原样保留、非法表达式阻断、输入同步、移动端字号规则和弹窗类名断言；高级字段补丁在 fixture 中同样要求唯一命中。

## 2. 「保存无反应」结论

问题是 AionUi 原生行为，补丁未引入。原生文件 `assets/jobAgentMeta-D3UNrFgf.js` 的编辑初始化片段前 80 字符为 `u.setFieldsValue({name:n.name,assistant:o,prompt:n.target.payload.text})`，而高级输入框片段前 80 字符为 `g.mode==="advanced"&&t.createElement(E,{label:a("cron.page.form.cronExpr"),field:"customCronExpr"...`，该字段有 `required` 规则。`0,30 1-2 * * *` 被 `yt` 判为 `custom`，`vt` 放入 `advancedExpression`，但初始化没有写入 Form 的 `customCronExpr`，所以 `u.validate()` 失败，`je` 在请求前进入错误路径；其它可映射为 daily/weekly 等频率的老表达式不会触发该字段校验。

补丁现在把原始表达式写入 `customCronExpr`，并保持提交表达式使用原始字节的既有逻辑；用户编辑高级表达式时同步 Form 字段，非法五字段/范围由原生 Form validator 报错并阻止请求。

## 3. 验证

- `node --test tools/cron-window.test.mjs tools/cron-window-patches.test.mjs`：通过，2 个文件、全部测试通过。
- 新增高级保存测试在修复前会失败：原始 fixture 没有 `cronEditInit` 的 `customCronExpr` 写入，且高级字段没有 `validateAdvanced` validator；修复后分别由初始化断言和非法表达式断言覆盖。
- 真实资源演练：
  `python3 -I image/rebrand/rebrand.py /root/build/notes/wp-kong-img/pkg/aionui-web/static /tmp/t1389-static-wp /tmp/t1389-brand image/rebrand/overlay image/streaming/smooth-text.mjs`：退出码 0；所有补丁锚点均报告 `1 处`。
- AC-3 输出末尾：

  ```text
  界面补丁锚点：1 处，u.setFieldsValue({name:n.name,assistant:o,prompt:n.target.payload.text})
  界面补丁锚点：1 处，g.mode==="advanced"&&t.createElement(E,{label:a("cron.page.form.cronExpr"),field:"customCronExpr"...
  界面补丁锚点：1 处，className:"w-[min(560px,calc(100vw-32px))] max-w-560px"
  界面补丁锚点：1 处，je=async()=>{try{const e=await u.validate();
  界面补丁锚点：1 处，x(!0);const r=re.expr,o=re.description,N=tt(r,o),
  界面补丁锚点：1 处，function Obo(e,t){if(!e)
  界面补丁锚点：1 处，if(s==="*"&&i==="*"&&l==="*"&&a!=="*"&&o!=="*")
  文字替换：59 个文件，1420 处
  ```

- `git diff --check`：通过。
- `git diff --stat main`：5 个文件，新增 63 行、删除 2 行。
- 已尝试 `node --test tools/*.test.mjs`；全套在当前沙箱中无法完成：部分既有测试会启动长驻服务而超时，另有测试缺少 `ws` 依赖（`ERR_MODULE_NOT_FOUND`）。这与本次改动无关。

## 4. 协调者补跑

当前环境不能启动 Chromium，因此请协调者补跑浏览器 AC-4/AC-5/AC-6。可直接使用：

```bash
rm -rf /tmp/t1389-static-wp /tmp/t1389-brand
python3 -I image/rebrand/rebrand.py /root/build/notes/wp-kong-img/pkg/aionui-web/static /tmp/t1389-static-wp /tmp/t1389-brand image/rebrand/overlay image/streaming/smooth-text.mjs
/root/build/notes/wp-kong-img/pkg/aionui-web/aionui-web start --static-dir /tmp/t1389-static-wp --port 25899 --no-open --data-dir /tmp/t1389-data
```

用 Playwright 打开 `#/scheduled`，在 390×844、360×800 检查自动化弹窗（含按时间段面板）所有 `input/textarea` 计算字号至少 16px 且无横向溢出；用 `/api/cron/jobs` 预置 `0,30 1-2 * * *`，编辑后不改直接保存，确认 PUT、expr 原样和弹窗关闭；再把高级表达式改成非法值，确认出现原生字段错误且没有请求。桌面 1440 宽度和其余老表达式也需照验收标准复跑。

## r2 返工追加

### 1. 改动与完成情况

- `image/rebrand/overlay/wp-cron-window.js`：将 `validateAdvanced` 的星期字段改为逐逗号段解析；每段支持 `*`、单值、区间和 `/n`，星期数字与名称可混用、名称不区分大小写，按 `MON=1…SUN=7` 且 `0` 归一为星期日检查区间顺序。
- `tools/cron-window-patches.test.mjs`：新增三个表单锚点的 fixture 恰好一次断言；新增星期字段合法/非法直接测试；新增高级保存行为测试，非法表达式不调用请求函数，老表达式 `0,30 1-2 * * *` 原样进入提交。

三个新增锚点均在 fixture 命中 1 次：

- `u.setFieldsValue({name:n.name,assistant:o,prompt:n.target.payload.text})`
- `g.mode==="advanced"&&t.createElement(E,{label:a("cron.page.form.cronExpr"),field:"customCronExpr"...`
- `className:"w-[min(560px,calc(100vw-32px))] max-w-560px"`

### 2. 验证

- `node --test tools/cron-window.test.mjs tools/cron-window-patches.test.mjs`：通过，2 个测试文件全部通过。
- `git diff --check`：通过；`git diff --stat main`：5 个文件，新增 149 行、删除 2 行。
- 真实资源演练命令退出码 0：
  `python3 -I image/rebrand/rebrand.py /root/build/notes/wp-kong-img/pkg/aionui-web/static /tmp/t1389-static-wp /tmp/t1389-brand image/rebrand/overlay image/streaming/smooth-text.mjs`
  输出末尾为：
  ```text
  界面补丁锚点：1 处，u.setFieldsValue({name:n.name,assistant:o,prompt:n.target.payload.text})
  界面补丁锚点：1 处，g.mode==="advanced"&&t.createElement(E,{label:a("cron.page.form.cronExpr"),field:"customCronExpr"...
  界面补丁锚点：1 处，className:"w-[min(560px,calc(100vw-32px))] max-w-560px"
  文字替换：59 个文件，1420 处
  ```

### 3. 协调者处理

本轮未运行浏览器；请按上文命令补跑 AC-4/AC-5/AC-6。未提交、未推送。

## r3 返工追加

### 1. 改动与完成情况

- `image/rebrand/overlay/wp-overlay.css`：在 `@media (max-width: 767px)` 的 `.wp-cron-modal` 作用域新增 `.arco-select-view-input { font-size: 16px !important; }`，覆盖 Arco Select 的 single/multiple 与各尺寸选择器优先级。
- `tools/cron-window-patches.test.mjs`：移动端字号测试新增断言，要求弹窗内 `.arco-select-view-input` 的 16px 规则带 `!important`，确保能覆盖 `.arco-select-size-default.arco-select-single input` 等 Arco 规则。

本轮没有新增 JavaScript 补丁锚点；新增 CSS 规则的作用域和覆盖方式由上述测试直接锁定。

### 2. 验证

- `node --test tools/cron-window.test.mjs tools/cron-window-patches.test.mjs`：通过，2 个测试文件全部通过。
- `git diff --check`：通过。
- `git diff --stat main`：5 个文件，新增 151 行、删除 2 行；本轮工作区实际修改为上述 CSS 和测试文件，未提交、未推送。

### 3. 协调者处理

浏览器复测仍由协调者执行：在 360×800 和 390×844 的自动化弹窗中确认助手、频率等 Select 搜索输入框计算字号至少 16px，并按既有 AC-4/AC-5/AC-6 命令复跑。桌面端和弹窗外页面无需变更。

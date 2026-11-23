# T-1395 交付记录

## 修改文件

- `image/rebrand/overlay/wp-skills.js`：为每次 `load()` 增加递增序号；只有最新请求返回时才刷新卡片和提示，旧请求的成功或失败结果都会丢弃。
- `tools/market-skills.test.mjs`：补充旧请求晚返回、旧请求晚失败的并发刷新测试。
- `gateway/tests/market-shared.test.mjs`：补充审批通知和作者结果通知的批次断言，验证新批次先成功后旧批次失败时最终仍为成功。

## 测试

命令：

```text
node --test gateway/tests/market-shared.test.mjs tools/market-skills.test.mjs tools/shared-runtime.test.mjs
```

输出摘要：

```text
gateway/tests/market-shared.test.mjs  not ok（HTTP 测试无法监听本地端口）
tools/market-skills.test.mjs         ok
tools/shared-runtime.test.mjs        ok
测试总计：2 通过，1 失败
```

网关其余 15 个测试（包含本任务的通知批次测试）通过；HTTP 测试失败原因为当前 Codex 沙箱禁止监听本地端口，报 `listen EPERM`。

## 依赖

无需安装依赖。

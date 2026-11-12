# T-1161 实施报告

## 1. 文件变更

- `gateway/my-key.mjs`：逐请求读取参考额度及个人覆盖，输出百分比、超额标志和限额存在标志，移除回复中的金额与限额明细，固定 UTC 窗口并收紧调用归属校验。
- `gateway/my-key-client.mjs`：以今天、本周百分比进度条替换金额，增加中英文参考说明、无障碍属性和浅深色警告颜色，移除旧金额格式与提示。
- `gateway/organization/default.json`：增加默认关闭的 `reference: { weekly: 0, accounts: {} }`。
- `docs/organization.md`：说明参考额度、个人覆盖优先级、每日五分之一、逐请求刷新、不阻断使用及新的回复和归属规则。
- `gateway/tests/my-key.test.mjs`：更新旧金额断言，补充百分比边界、配置覆盖及刷新、归属漏洞、UTC 窗口和回复无金额检查。
- `tools/browser-tests/my-key.e2e.mjs`：替换金额测试，补充中英文进度条、正常／警告／超额颜色、999%+、无参考额度、回复和页面无金额、两种窄屏布局及指定截图用例。
- `tools/organization-resolve.test.mjs`：仅调整受新增默认字段影响的两处配置比较。
- `docs/tasks/T-1100/T-1161-my-key-percent-bars/report.md`：记录实施、验证结果及交接事项。

## 2. 验证

默认 `node` 为 v22.22.1；已找到环境自带的 v24.22.1，并在临时目录建立指向该解释器的链接，没有安装依赖。以下命令中的 `PATH` 前缀用于选择这个 Node 24。增加 `--test-isolation=none` 是为了获得逐项测试结果；默认子进程模式在本环境只显示整文件结果。

通过的检查：

```sh
PATH="/tmp/my-key-node24/bin:$PATH" node --check gateway/my-key.mjs
PATH="/tmp/my-key-node24/bin:$PATH" node --check gateway/my-key-client.mjs
PATH="/tmp/my-key-node24/bin:$PATH" node --check gateway/tests/my-key.test.mjs
PATH="/tmp/my-key-node24/bin:$PATH" node --check tools/browser-tests/my-key.e2e.mjs
PATH="/tmp/my-key-node24/bin:$PATH" node --test --test-isolation=none --test-name-pattern='^(UTC windows|limits map|model shares|dialog installer|pure mapping|percentages use|upstream limits only|usage ownership rejects|served script)' gateway/tests/my-key.test.mjs
PATH="/tmp/my-key-node24/bin:$PATH" node --test --test-isolation=none --test-name-pattern='^my key defaults' tools/organization-resolve.test.mjs
git diff --check
```

语法和空白检查通过；纯函数及客户端脚本测试 11/11 通过；My key 默认配置测试 1/1 通过。

完整模块测试：

```sh
node --test gateway/tests/my-key.test.mjs
PATH="/tmp/my-key-node24/bin:$PATH" node --test --test-isolation=none gateway/tests/my-key.test.mjs
```

首次运行只报告整文件失败；Node 24 的逐项结果为 11 项通过、13 项失败，失败均发生在创建测试服务器时：`listen EPERM: operation not permitted 127.0.0.1`，尚未执行 HTTP 行为断言。受阻的测试为：

- `session identity owns masked and revealed keys regardless of selectors`
- `masking handles prefixed, unprefixed and short keys without exposing GET plaintext`
- `reveal validates actions, origin, content type, body size and methods before reading keys`
- `missing and empty key files skip all upstream calls`
- `access precedes body, key and upstream reads and live admission fails closed in both directions`
- `public settings are sanitized and re-read with admission`
- `upstream period and totals use UTC including hourly points on a single-day Monday`
- `upstream transport and malformed replies degrade to 200 while reveal remains available`
- `usage ownership, time alignment and malformed numbers fail closed`
- `browser replies exclude private rows and identities and cap advertised strings`
- `audit is flushed with only timestamp slug action and fails closed on write failure`
- `reference settings are live, account overrides prefer slugs and invalid entries fall back`
- `GET replies contain no amounts or reference settings with or without upstream limits`

另外执行了：

```sh
PATH="/tmp/my-key-node24/bin:$PATH" node --test --test-isolation=none tools/organization-resolve.test.mjs
```

结果 9/10 通过。未改动的 `startup exports quick-line configuration and preserves a container override for child processes` 在第 127 行失败：期望测试字符串 `fast'model`，实际子进程标准输出为空；此次未修改相关启动逻辑。

遵照任务限制，没有启动浏览器，因此 `my-key` 浏览器组、实际颜色和布局、截图尚未验证或生成。没有运行 `tools/gateway.test.mjs` 或整个 `tools/check.sh`，没有安装依赖、联网或修改分支及历史。

## 3. 协调者交接

- 请在可监听端口的 Node 24 环境补跑 `node --test gateway/tests/my-key.test.mjs`、`node --test tools/gateway.test.mjs tools/organization-resolve.test.mjs` 和 `node tools/browser-tests/run.mjs my-key`。
- 请复核上述启动配置测试的空输出失败；若需要修改启动脚本，应另行处理，本任务未扩展文件范围。
- 浏览器用例将生成 `usage-bars-light-desktop`、`usage-bars-light-390x844`、`usage-over-light-390x844`、`usage-bars-dark-390x844` 截图，使用虚构数据并保持钥匙掩码。
- 覆盖顺序采用有效 slug 值、有效 unionId 值、有效全局值；无效项跳过，因此无效 slug 与有效 unionId 同时存在时采用 unionId，已写入文档和测试。
- 正常状态与限额说明通过真实网关测试；颜色阈值和超额布局用拦截回复覆盖，复用现有夹具及周一处理，无需改动 harness 或通用浏览器助手。
- 报告已写入指定路径，但本地 `.git/info/exclude` 忽略了 `docs/tasks/`，因此它不会出现在普通 `git status` 中；如需随代码提交，协调者需显式加入该文件，本次未改动忽略规则。
- 无其他范围外修改需求或待确认产品问题；提交由协调者完成。

# T-1109 交付报告

## 改动

- S10 开头的 `waitForPolicy` 现在同时检查两个用户 Pod：DNS 去重结果严格等于 `[gatewayIp]`，且通过 `c.from` 探测 gateway HTTP、gateway internal、model egress，要求 `open === true`。配置外部探针时，也等待该探针放行。继续使用原有超时配置和轮询间隔。
- 三个固定放行项与可选外部探针分别定义并供等待、矩阵复用，保持矩阵目标顺序不变。拒绝项不进入等待；原有 `checkMatrix`、DNS 断言、入站断言、Job 拒绝断言均未修改。
- 检查了 Job 后的 `c.ready(slug)` 重建路径：第一个 Pod 重建后，S10 中只有另一用户 Pod 对它的拒绝检查，没有针对它的后续放行断言，因此无需添加等待。S11 原有 `until` 保持不变。
- 新增 `tools/k8s/e2e/tests/policy-ready.test.mjs`，使用假 runtime 和真实 `probeRunners` 执行完整 S10。该文件在本 worktree 原先缺失，但现有 `tests/index.js` 已引用它，无需修改测试入口。
- 离线测试覆盖两个 Pod 的三个固定放行项与外部探针前两次超时、之后恢复；未配置外部探针；DNS 执行超时和额外地址后恢复；拒绝项每个源/目标只探测一次；瞬时意外放行立即失败；持续 TCP 不通在任何拒绝检查或 Job 前超时；等待成功后原矩阵放行断言仍然生效。测试只使用虚构占位标识，未引入实际环境标识。

## 测试输出摘要

- 先添加回归测试、再修改生产代码：修改前 **2 通过、7 失败**，包括四个放行项在原矩阵中因 `false !== true` 失败；修改后同一测试文件 **9/9 通过、0 失败、0 跳过**。命令：`node --test --experimental-test-isolation=none tools/k8s/e2e/tests/policy-ready.test.mjs`。日志：`/tmp/T-1109-red.log`、`/tmp/T-1109-policy-tests.log`。
- `node --test tools/k8s/e2e/tests/`：退出 **0**，目录入口汇总 **1/1 通过、0 失败、0 跳过**。日志：`/tmp/T-1109-tests.log`。
- `node --test --experimental-test-isolation=none tools/k8s-e2e.test.mjs`：退出 **0**，**19/19 通过、0 失败、0 跳过**。日志：`/tmp/T-1109-controller-tests.log`。
- 修改的模块与测试文件 `node --check` 通过；`git diff --check` 通过。
- `bash tools/check.sh`：退出 **1**。前置语法检查通过后，既有 `tools/wp-seed.test.py` 中的 `ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 创建本地 HTTPServer socket 被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`。后续检查未执行，未修改或跳过该测试；完整检查需在允许本地 socket 的环境运行。日志：`/tmp/T-1109-check.log`。

未运行真实集群端到端测试，未提交 git。

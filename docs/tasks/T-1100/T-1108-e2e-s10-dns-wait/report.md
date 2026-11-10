# T-1108 交付报告

## 改动

- S10 矩阵开始前新增策略收敛等待，使用 `until(..., c.config.policyTimeoutMs ?? 60000, 200)`。每轮要求两个用户 Pod 的 DNS 结果去重后均严格等于 `[gatewayIp]`；执行超时、探针失败和地址不匹配在等待期内重试。超时抛出英文错误，包含失败 Pod 的完整名称、slug 和最后一次错误原因。等待成功后，原有 DNS 断言、网络矩阵及 Job 拒绝断言保持不变。
- S12 将既有收敛重试限定为应放行的正控制项；正控制通过后执行原有拒绝矩阵，任何意外放行立即失败，不通过重试掩盖拒绝断言失败。保留原有例外端口记录。
- 已检查策略切换后的 S9/restored、S11、S13：S9 的服务就绪检查和 S11 的 HTTP 控制已有等待；S11 的 403 是应用层返回，不能被网络超时替代。S13 检查 Pod 身份、重启计数及接管状态，没有紧接策略恢复的网络断言，其接管状态已有等待，因此未额外增加网络等待。
- `context.mjs` 抽出可注入假 runtime/client 的 `probeRunners`，保持单次执行超时为 6000ms。`from` / `fromProbe` 的超时错误包含英文 kind/host/port（默认 kind 为 tcp，缺省字段为 n/a）及原始错误原因，并保留 cause。诊断同时写入 runner 已有的 `reason` 字段，确保 CI 结果中可见；不加入探针 stdout、stderr 或认证头。
- 新增 `policy-ready.test.mjs` 并接入目录测试入口，使用假 runtime 执行完整 S10：覆盖两个 Pod 前几次 DNS 超时后恢复、任一 Pod 持续超时、地址不匹配和多余地址、等待后的原始 DNS 断言仍生效，以及两个探针入口的超时诊断。更新 S12 回归，验证瞬时意外放行也立即失败、正控制始终不通时不会假通过。

## 测试输出摘要

- `node --test --experimental-test-isolation=none tools/k8s/e2e/tests/policy-ready.test.mjs`：退出 **0**，**6/6 通过，0 失败，0 跳过**。日志：`/tmp/T-1108-policy-tests.log`。
- `node --test tools/k8s/e2e/tests/`：退出 **0**，目录测试入口 **1/1 通过，0 失败，0 跳过**（当前 Node 版本按目录入口汇总）。日志：`/tmp/T-1108-tests.log`。
- `node --test --experimental-test-isolation=none tools/k8s-e2e.test.mjs`：退出 **0**，**19/19 通过，0 失败，0 跳过**，包括 S11/S12 控制项及主机探针清理回归。日志：`/tmp/T-1108-controller-tests.log`。
- 修改的模块和测试文件 `node --check` 通过；`git diff --check` 通过。
- `bash tools/check.sh`：退出 **1**。前置语法检查通过后，既有 `tools/wp-seed.test.py` 的 `ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 在创建本地 HTTPServer socket 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`。后续检查未执行，未修改或跳过该测试。日志：`/tmp/T-1108-check.log`。完整检查仍需在允许本地 socket 的环境运行。

未运行真实集群端到端测试，未提交 git。新增离线测试仅使用虚构占位标识，报告未包含实际环境标识。

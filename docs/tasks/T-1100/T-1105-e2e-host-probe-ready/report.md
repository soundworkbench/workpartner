# T-1105 交付报告

## 根因

主机探针 Pod 没有 readinessProbe，容器进入 Ready 不代表其中的 Node 服务已经开始监听。原 `withHostProbes` 在 Ready 后只尝试一次本机 TCP 连接，连接失败立即中止，存在启动竞态。`model-egress` 辅助 Pod 同样只等待 Pod Ready，未验证服务监听；gateway 已配置 TCP readinessProbe，无需更改。

## 改动

- `tools/k8s/e2e/controller.mjs`：抽出 `waitForListener`，使用单调时钟计算每个监听的 30 秒总预算，失败后间隔 500ms 重试；每次命令最多 5 秒且不超过剩余预算，Pod 内 TCP 连接另设 1 秒超时。失败退出码和执行异常均在预算内继续重试，成功立即返回，超时才抛出英文错误，包含运行时节点、端口、Pod 和最后一次可用的命令日志路径。
- S10/S12 的两个主机探针分别完成本机监听检查后才执行场景；model 辅助 Pod 在场景启动前复用同一等待逻辑。探针清理流程、场景放行/拒绝断言及网络策略均未改动。
- `tools/k8s/e2e/tests/listener-ready.test.mjs`：用假 kubectl 和虚拟时钟离线覆盖前三次失败后成功、持续失败并报告节点/端口/日志、命令耗时计入总预算及末次超时裁剪、执行异常后恢复。目录入口 `tests/index.js` 加载新增测试。

## 测试输出摘要

- 先执行新增测试，确认缺少等待函数时四项均失败；实现后四项均通过。
- `node --test tools/k8s/e2e/tests/`：退出 **0**，目录测试入口通过，失败 0、跳过 0。日志：`/tmp/T-1105-tests.log`。
- `node --test --experimental-test-isolation=none tools/k8s/e2e/tests/ci-adapters.test.mjs tools/k8s/e2e/tests/listener-ready.test.mjs`：退出 **0**，展开结果 **26/26 通过，0 失败，0 跳过**。日志：`/tmp/T-1105-tests-detailed.log`。
- `node --test --experimental-test-isolation=none tools/k8s-e2e.test.mjs`：退出 **0**，**19/19 通过，0 失败，0 跳过**，包括主机探针在场景成功和失败时均及时删除，以及网络场景正反控制的既有回归。日志：`/tmp/T-1105-controller-tests.log`。
- controller 和新增测试文件的 `node --check` 通过；`git diff --check` 通过。
- `tools/check.sh`：退出 **1**。前置语法检查完成后，既有 `tools/wp-seed.test.py` 的 `ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 创建本地 HTTPServer socket 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`。后续检查未执行，未修改或跳过该测试。需在允许本地 socket 的环境重跑完整检查。日志：`/tmp/T-1105-check.log`。

未运行真实集群端到端测试，未提交 git。新增测试仅使用通用占位标识；报告不包含实际环境标识。

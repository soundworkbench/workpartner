# T-1110 交付报告

## 改动

- `pv` 读取 `--node` 对应 Node 的 `metadata.labels['kubernetes.io/hostname']`，要求非空；data 和可选 oldwork 的 local PV 都生成 `matchExpressions` / `kubernetes.io/hostname` / `In`，使用实际标签值。缺失标签时不创建 PV/PVC。
- 统一读取 hostname 亲和。`pv` 全计划比对和 AlreadyExists 并发复核均拒绝旧 `matchFields` / `metadata.name`，明确提示人工删除对应 PV/PVC 对象（Retain，不删除数据）后重跑 pv。新写法支持 API 默认字段、容量规范化及部分创建后的幂等重跑。
- `switch` 在创建操作锁前检查 data/oldwork 亲和，拿锁后再检查；旧写法不会触发 Docker、归属、Kubernetes 对象写入。`verify` 读取 Pod 所在 Node 的 hostname 标签再比较，允许标签值与节点名不同，并检查可选 oldwork。
- `status` 经检查不读取 PV 节点亲和；其归属与重复实例只读检查保持不变。
- 更新 `docs/kubernetes.md` K7 中 pv、switch 预检、verify 的描述。
- 未实现 runtime 可选 nodeSelector 双保险：网关现有 RBAC 为命名空间级 Role，不含集群级 PV 读取权限。读取 Bound PVC 对应 PV 需要扩展权限及运行时 API 依赖，并非简单补充字段；保留 Bound/预绑定 PVC 不追加新用户 nodeSelector 的行为，现有 runtime 回归覆盖此约束。

## 测试输出摘要

- 先改离线用例再改实现，确认旧实现不能通过新要求：缺失/空 hostname 标签及旧亲和被错误接受，新亲和生成与验证失败；修复后 `node --test --experimental-test-isolation=none tools/k8s-adopt.test.mjs`：161 tests，161 pass，0 fail。
- 新增覆盖包括：标签值与节点名不同；data/oldwork 新亲和；新卷重跑无 create；缺失/空标签无对象写入；pv/switch/verify 拒绝旧 data/oldwork 亲和；旧 oldwork 阻止尚未创建的 data 卷写入；switch 拒绝发生在锁创建前；verify 检测标签不匹配或缺失。
- `node --test --experimental-test-isolation=none tools/*k8s*.test.mjs`：329 tests，328 pass，0 fail，1 skipped（nft 检查需显式设置 `WORKPARTNER_TEST_NFT_CHECK=1`）。
- `node --test --experimental-test-isolation=none tools/runtime-k8s.test.mjs tools/runtime-k8s-files.test.mjs tools/k8s-render.test.mjs`：113 tests，113 pass，0 fail。
- 补充 `tools/kube-client.test.mjs`：20 tests，20 pass，0 fail；`tools/k8s/e2e/tests/*.test.mjs`：35 tests，35 pass，0 fail。初次补查发现 worktree 未装 `ws`；临时复用本地与锁文件一致的 gateway 依赖后通过。初次对 CI 用例设置的 10 秒限时不足，`up fails immediately if either runtime check or readiness wait fails` 被取消；改为 60 秒限时完整重跑后通过。
- `node --test tools/`：当前 Node v22.22.1 将目录参数作为模块加载，报 `MODULE_NOT_FOUND`；改用明确的测试文件 glob。默认隔离模式输出按文件汇总，因此另外使用 `--experimental-test-isolation=none` 获取逐项结果。
- 另尝试 `node --test tools/*.test.mjs` 全量测试；等待数分钟仍只有 TAP 头部、没有逐文件结果，已中断（退出 130），不记作通过。补齐本地依赖后的全量重试也未给出逐文件结果，已中断（退出 130）。上面的显式 k8s 子集已完整结束。
- 单独诊断全量中的 `tools/core.test.mjs` 用例 `gateway login, session isolation, personal routing, caching and logout`：1 test，0 pass，1 fail，原因为本地监听被沙箱拒绝（`listen EPERM: operation not permitted`），不是本次改动的断言失败。
- `bash tools/check.sh`：此前 JavaScript/Python/shell 语法检查通过；在原有 `tools/wp-seed.test.py` 的 `ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 停止。其 HTTPServer 创建 socket 被沙箱拒绝：`PermissionError: [Errno 1] Operation not permitted`。未绕过沙箱，也未将该次 check 记作通过。
- `node --check`（本次改动的两个 JavaScript 文件）与 `git diff --check` 通过。
- 独立只读代码审查：未发现问题。

## 范围与限制

验证使用的临时 gateway 依赖链接已移除，未修改依赖或锁文件。未访问真实集群，未进行在线调度或挂载验证。新增内容仅含通用标识、合成测试值和摘要，无真实基础设施或人员信息。未提交 git。

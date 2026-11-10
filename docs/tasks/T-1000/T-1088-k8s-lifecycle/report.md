# T-1088 K2a 实施报告

## 第 2 轮返工（2026-11-10）

沿用 `T-1088-k8s-lifecycle` worktree，基准为 `T-1084-k8s-spec`（`57f531e`），未切换分支。开始时此路径没有报告文件，本轮新建并记录返工结果。实现对应执行规格的 K2a 生命周期、装配和 inspect 合同，并落实本轮新增的每人资源覆盖。

### 修改范围与对应要求

| 要求 | 完成内容 |
| --- | --- |
| 1：execNamed 容器名 | 新增可选 `runtime.k8s.systemContainer`，配置时校验为非空 DNS label；个人 exec 仍用 `workspace`。K2b 当前接受字符串，因此 `execNamed(name)` 先解析 `配置值 ?? name`，再把字符串放入 context，按容器名缓存工厂 Promise。不同目标并发调用不会共享可变容器名。未配置时，目标 Pod 内的容器名必须与 Pod 名相同；不同名时显式配置。 |
| 2：名称长度 | StatefulSet 名上限为 52，为 controller revision hash 标签的连字符和哈希留出 11 字符，同时满足 Secret/PVC 后缀长度要求。 |
| 3：inspect 地址 | 仅满足主容器 running、有 podIP、无 deletionTimestamp 的完整运行判据时返回地址；Terminating、Pending、Succeeded、Failed 均返回 null。 |
| 4：启动错误 | `waitRunning` 仅转换 K1 的 `reason: 'Timeout'` 错误，附带 Pod 原因并保留 cause；403、网络错误及其他错误对象原样抛出。 |
| 5：日志上限 | `runOnce` 调用 logs 时传 `limitBytes: 1024 * 1024`，即 1 MiB，限制维护任务输出占用；仍保留原有 finally 清理流程。 |
| 6：模板字段清理 | 重复 create 对撤掉的 priorityClassName、nodeSelector 显式发送 null；更新 nodeSelector 时还会删除已撤掉的键。env、挂载和卷数组整体替换，撤掉的 modelConfig、oldwork 不残留。副本数与既有注解保留。 |
| 7：删除等待诊断 | stop/remove 超时列出最后一次轮询仍存在的所有用户 Pod 名；remove 在 StatefulSet 仍存在时也列出它的名字。保持非超时错误原样抛出，不主动删除遗留的一次性 Pod，不强制删除卡住的 Pod。 |
| 8：测试域名 | 测试中的 example.com 全部替换为 example.test，示例 IP 保持 RFC 5737 文档保留地址。 |
| 9：差异说明 | CPU 缺省、createRequire 和 Secret subPath 生效条件详见下节。 |
| 10：inspect 合同 | 保留并完善 replicas、annotations；资源不存在时返回 replicas: null、annotations: {}，字段自身缺失时也采用这些缺省值。Docker inspect 不增加字段。 |
| 11：每人资源 | `runtime.k8s.userResources[slug]` 在 create 时逐项覆盖 memory/cpu limits，支持 Kubernetes quantity 字符串；未列出的人或未覆盖的资源使用全局值，requests 不变。重复 create 撤掉覆盖后恢复全局值。 |

本轮只修改 `gateway/runtime/index.mjs`、`gateway/runtime/k8s.mjs`、`tools/runtime-k8s.test.mjs`、`docs/organization.md`，并按验收要求新增本报告。未修改 kube-client、k8s-exec、k8s-files、Docker 实现、check.sh、package 文件或 rollout.py，也未新增依赖。

### 接口与行为说明

- 未配 `runtime.nanoCpus` 时，Kubernetes CPU limit 缺省为 **2**；Docker 的对应缺省行为为不限 CPU。每人覆盖只用于 create 构建的常驻工作区模板；一次性维护 Pod 仍用全局 limits。requests 默认 memory=512Mi、cpu=100m。
- `index.mjs` 使用 `createRequire` 是为了保留现有同步 `createRuntime` 工厂接口，同时仅在选择 Docker 时加载 docker.mjs，避免 k8s 启动引入 Docker 传输。使用项目要求的 Node 24 对同步 ESM 的 require 支持；Docker 参数和实现保持原样。已有导入钩子测试验证 k8s 工厂初始化不加载 Docker、K1 或 K2b 模块。
- 模型钥匙以 Secret **subPath** 方式挂载，更新 Secret 不会更新已运行容器内的钥匙，必须重建 Pod（例如 restart）才生效。StatefulSet 使用 OnDelete，资源或其他模板配置变更同样要在 Pod 重建后生效。
- 已读取 K1 main 实现，假客户端超时使用同样的 `reason: 'Timeout'`；exec 验证要求 container 是非空字符串。
- 已读取 `T-1090-k8s-exec-files` worktree 的真实 K2b 工厂，其 systemContainer 是字符串。另用该工厂进行只读装配验证，分别覆盖未配置/显式配置、个人 exec、两个不同系统 Pod 及重复调用，全部通过；未复制或修改 K2b 文件。
- docs/organization.md 已补充两个可选字段、虚构 slug 示例、名称上限、inspect 合同及上述行为差异。

### 测试证据

原有 21 条测试全部保留，原断言未减少；按新合同更新缺失资源、日志选项及超时文案的预期值，并补充更强的检查。新增 7 条测试，共 **28 条全部通过**：

1. 名称 52 字符可创建、53 字符在请求前拒绝。
2. inspect 在缺失、停用、运行、Terminating 和其他 phase 下的 replicas、annotations、address 合同。
3. start/restart 轮询中的 403、K1 网络错误和原生连接错误保持对象身份。
4. 重复 create 清除优先级、节点选择、选择器旧键、modelConfig 和 oldwork 挂载。
5. stop/remove 列出多个遗留 job Pod、保留这些 Pod，并原样传播非超时错误；原有 Terminating 用例同时加强为检查主 Pod 名。
6. 经 createRuntime 装配，在遵循 K1 容器名校验的假 client 上执行 exec/execNamed；覆盖默认值、显式配置、多个目标、并发与实例复用。
7. 经组织配置覆盖双资源、只覆盖内存、只覆盖 CPU、未列出的用户，以及撤掉部分/全部覆盖，始终验证 requests 不变。

验证命令（Node 24）：

```sh
node --test tools/runtime-k8s.test.mjs
node --test --test-isolation=none tools/runtime-k8s.test.mjs
node --test --test-isolation=none tools/runtime-k8s.test.mjs tools/runtime-models.test.mjs
bash tools/check.sh
git diff --check
```

- K2a 单文件标准命令退出码 0；关闭测试进程隔离以显示逐条结果时为 tests=28、pass=28、fail=0。
- 联合测试为 tests=59、pass=55、fail=4；其中 runtime-models 为 27 通过、4 失败。以 `git archive HEAD` 在临时目录导出原基准快照，再用同一 Node 24 跑未改动的 runtime-models，仍为 27 通过、相同的 4 项失败：一个本地监听 `EPERM`，两个 `fchown EINVAL`，一个 `chown EINVAL`。没有发现本轮引入的额外失败，未更改或跳过原测试。
- 完整 check.sh 的语法检查阶段通过，随后 tools/wp-seed.test.py 建本地 HTTP 服务时报 `PermissionError: Operation not permitted`，因此脚本在进入后续测试前停止。该 Python 测试在基准快照上同样失败。本环境禁止本地监听及所需 UID/GID 的属主切换，不能将完整检查报告为通过。
- `git diff --check` 通过。检查新增源码、测试、文档及报告：示例只用虚构名称、测试域名和文档保留 IP；无组织部署值。
- 本地验证日志保留在 `/tmp/t1088-k8s-node24.log`、`/tmp/t1088-targeted-node24.log`、`/tmp/t1088-baseline-runtime-models.log`、`/tmp/t1088-check.log` 和 `/tmp/t1088-baseline-check-blocker.log`。

### 尚需集成环境验证

当前 worktree 基准尚未包含 K1/K2b 生产模块，因此单元测试采用注入客户端与工厂；真实 K2b 工厂装配另行验证通过。沙箱没有集群，未验证真实 StatefulSet 控制器、Secret subPath 更新、资源调度、网络策略或集群端到端场景。合并配套模块后，应在允许监听和属主切换的 Node 24 环境复跑完整 check.sh，并按 K8 执行集群验收。

# T-1107 交付报告

## 改动摘要

- `docs/kubernetes.md`：新增稳定锚点 `model-egress-routing`，明确固定端点仅适用于所有节点上的 Pod 均可经路由到达、且不是任何节点本机地址的外部端点。说明多节点网桥地址重复及 ClusterIP DNAT 后进入 INPUT 被 node-guard 拦截的两条原因。
- 补充系统命名空间中的 TCP 中继 Deployment 和配套 selector 配置：nodeSelector 唯一固定 Docker 节点、非 root、只读根文件系统、drop ALL、禁止提权、无 ServiceAccount token、TCP readiness/liveness 探针、Node 内联双向转发与连接错误清理。中继直连网桥发布端口，经 Docker DNAT/FORWARD；注明镜像预导入、地址替换、探针局限和逐节点真实请求验证要求。
- 网关上线步骤及 `docs/deployment.md` 同步说明：同节点 Docker 服务（包括迁移 peer）直连网桥发布端口，不经指向网桥地址的 Kubernetes Service。
- `tools/k8s/render.mjs`：仅对 RFC1918 三段地址追加英文 warning，CLI 沿用已有 stderr 输出通道，指向上述文档章节；不新增错误、不改清单模板或渲染对象。
- `tools/k8s-render.test.mjs`：新增边界及相邻地址测试，确认共享地址空间不误报，函数不写 stdio、不修改输入、不跨调用保留 warning；覆盖 CLI stdout、`--only`、文件输出和清单内容不变。
- 示例使用 `192.0.2.x` / `example.com` 等占位标识；RFC1918 测试数据为协议网段边界，不含实际部署信息。未提交 git。

## 测试输出摘要

- `node --test tools/k8s-render.test.mjs`：退出 **0**。展开执行 `node --test --experimental-test-isolation=none tools/k8s-render.test.mjs`：**58 通过、0 失败、0 跳过**。日志：`/tmp/T-1107-render-tests.log`、`/tmp/T-1107-render-tests-detailed.log`。
- 文档配置片段通过 JSON/YAML 解析；Deployment selector 与 Pod 标签匹配，安全设置检查通过；提取内联转发代码后 `node --check` 通过。渲染器、测试文件语法检查及 `git diff --check` 通过。
- 原样执行 `node --test tools/`：退出 **1**。当前 Node **v22.22.1** 将目录参数作为入口模块处理，仓库没有 `tools/index.js`，报 `MODULE_NOT_FOUND`，未运行测试。日志：`/tmp/T-1107-tools-tests.log`。没有为此改动测试入口。
- `tools/check.sh`：退出 **1**。前置语法检查完成；既有 `tools/wp-seed.test.py` 的 `ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 创建 HTTPServer socket 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`，脚本在此停止。未修改或跳过该测试。日志：`/tmp/T-1107-check.log`。
- 补跑 `node --test tools/*.test.mjs` 及其关闭测试隔离的版本，均未完成，手动终止（退出 **130**）；随后按文件执行 `node --test --experimental-test-isolation=none tools/<文件>.test.mjs`，每文件设 45 秒上限，结果如下。日志汇总：`/tmp/T-1107-per-file-tests.log`；逐文件日志：`/tmp/T-1107-<文件>.test.mjs.log`。

| 文件 | 通过 | 失败 | 结果 |
| --- | ---: | ---: | --- |
| k8s-adopt | 152 | 0 | 退出 0 |
| k8s-render | 58 | 0 | 退出 0 |
| kube-client | 20 | 0 | 退出 0 |
| migration | 18 | 0 | 退出 0 |
| organization-resolve | 4 | 0 | 退出 0 |
| runtime-k8s-files | 27 | 0 | 退出 0 |
| runtime-k8s | 28 | 0 | 退出 0 |
| gateway | 2 | 6 | 既有监听测试报 `listen EPERM` |
| identity-cli | 1 | 1 | 既有监听测试报 `listen EPERM` |
| runtime-models | 27 | 4 | 1 项 `listen EPERM`，3 项 `chown` / `fchown EINVAL` |
| core、k8s-e2e、k8s-tools | — | — | 各 45 秒超时，没有最终测试计数；未判定通过 |

- 单独补跑 `tools/check.sh` 中未执行的后续 Python 测试：image-inputs **4/4**、init-hooks **19/19**、model-defaults **7/7**、no-blocking-foreground **4/4**、no-repeat-poll **10/10**，共 **44/44** 通过。日志：`/tmp/T-1107-python-remaining.log`。

本次变更的渲染测试通过，不能宣称全量检查通过。需在支持本地 socket、所需文件属主操作的环境中，以文件通配符执行 Node 测试并重跑完整 `tools/check.sh`，同时复核超时文件。未运行真实集群或 Docker 网络验收。

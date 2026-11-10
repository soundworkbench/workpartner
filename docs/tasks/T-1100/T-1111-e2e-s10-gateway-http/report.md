# T-1111 交付报告

## 根因判断及代码依据

本次静态检查未能证明一个具体的网络根因。现有证据最支持的问题范围是 k3d 中用户 Pod 到网关 Pod 的实际网络转发或策略执行路径；尚不能区分 NetworkPolicy 数据面、node-guard 或其他 CNI 状态。不能把本次配置对齐描述为已经验证解决了连续三次 S10 失败，需下一次 CI 的诊断结果确认。

- 排除当前代码中的“相同 hostPort/containerPort 触发 portmap 冲突”解释：修改前 `controller.mjs` 虽然配置两者相同，但在 apply 前明确删除了网关 Deployment 的 `hostPort` 和 `hostIP`。实际 e2e 网关没有这条 hostPort 映射。仅修改 organization 中的端口不能修复一条原本不存在的映射。
- 监听没有发现静态错配：`e2e/gateway.mjs` 依次在所有 IPv4 地址上监听配置中的 gateway、internal 和 sample 三个端口；Deployment 的 readiness/liveness 都探测名为 gateway 的 TCP 端口。初次 rollout 成功说明当时监听存在，但不能证明 S10 时仍正常。
- Service 没有发现静态错配：e2e 调用与生产相同的 `tools/k8s/render.mjs`，网关使用 headless Service；Service port、targetPort、Deployment containerPort 都来自同一组 gateway/internal 配置。e2e 没有覆盖 Service 或 NetworkPolicy。EndpointSlice 的实际地址、端口和就绪状态由运行中的集群决定，需要失败快照。
- 策略没有发现静态端口差异：用户命名空间的 `workpartner-user-egress` 使用 system namespace + gateway Pod selector 放行两个配置端口。system namespace 中渲染的 model ingress 仅选择 model Pod。用户命名空间的 default deny 不选择网关 Pod。
- node-guard 使用同一份 `deploy/k8s/node-guard.nft.tmpl`，保护节点输入流量及用户到节点地址的转发；它没有单独按 gateway HTTP/internal 端口放行或拒绝的逻辑。实际节点地址集合、命中计数与 CNI 路径仍需运行证据判断。
- 原始失败不能证明“internal 能通”：S10 的 allowedTargets 顺序是 HTTP、internal、model，HTTP 断言失败后该次循环立即中断，后两项尚未执行。新诊断独立执行各项，即使 HTTP 失败仍保留 internal 的结果。

## 改动

- 修正 e2e 与生产入口形态的确定差异：入口 hostPort 改为 18085，Pod HTTP/internal 保持 18083/18084，localAddress 同步入口；停止删除渲染出的 hostPort/hostIP，让实际 apply 的 Deployment 保留 loopback 映射。新增 samplePort 冲突校验。此项是生产形态对齐，效果待真实 e2e 验证；未修改产品渲染和网络策略，也未延长策略等待时间或放宽矩阵断言。
- `waitForPolicy` 超时时保留已有 evidence，并增加 `policyTimeout`（失败 slug、Pod 名称）。controller 在 host probe 删除、策略恢复和 namespace 清理前收集诊断，写入 `results.json` 和 `state.json` 中相应场景的 `evidence.policyDiagnostics`。S10、S12 均可触发，成功路径不采集。
- 新增 `diagnostics.mjs`，收集实际 gateway Pod 的地址、节点、声明端口、Ready、容器就绪及重启次数；网关 Service 和 EndpointSlice 的地址/端口/就绪状态；用户及 system 两个命名空间的 NetworkPolicy 名称、选择器和端口规则。
- 从网关容器分别对 loopback 和实际 Pod 地址执行 gateway/internal TCP 探测，并对 HTTP 端口执行 HTTP 请求。对矩阵两个用户 Pod 直接探测网关 Pod 的两个端口；若存在同节点额外用户 Pod，也加入探测，并列出同节点来源。缺少网关或同节点用户 Pod 时明确记录，诊断不创建资源。
- 在两节点采集 `workpartner_guard` 规则及计数器，内嵌失败时快照并引用 `guard-*.txt`。保留原有 finally 采集；关闭 guard 或采集失败均明确记录。
- 元数据采用字段白名单，不导出 Pod 环境、注解、日志、Secret、ConfigMap 或 HTTP 正文。异常正文不写入 evidence，命令失败仅引用私有命令日志。API/节点命令限时 5 秒，exec 限时 6 秒；单项失败不会中断其他诊断，也不会覆盖原场景失败。不扩大生产网关 ServiceAccount 权限，读取系统资源由原 controller 执行。

## 离线测试与验证

- 新增假 runtime 测试覆盖：完整资源与两个端口诊断；HTTP 端口拒绝但 internal 放行；同节点额外用户探测；双节点规则引用；API/exec/节点采集部分失败；缺少网关和关闭 guard；环境、注解、响应正文及异常敏感哨兵不出现在 evidence。
- 渲染测试核对入口与 Pod 端口不同、localAddress 一致、headless Service 及用户出站策略端口一致。假 kubectl 集成测试核对实际 apply 保留 hostPort、超时诊断在清理前完成、results/state 均保存诊断、诊断失败仍保留原 FAIL，成功路径不额外采集。
- `node --test tools/k8s/e2e/tests/`：通过，目录入口汇总 1/1，0 失败、0 跳过。日志：`/tmp/T-1111-tests.log`。
- `node --test --experimental-test-isolation=none tools/k8s-e2e.test.mjs`：19/19 通过，0 失败、0 跳过。日志：`/tmp/T-1111-controller-tests.log`。
- 新增诊断与策略等待测试单独运行：13/13 通过，0 失败、0 跳过。日志：`/tmp/T-1111-targeted.log`。
- 修改模块及测试的 `node --check`、`git diff --check`：通过。
- `bash tools/check.sh`：退出 1。前置语法检查完成，既有 `tools/wp-seed.test.py` 的 `ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 创建本地 HTTPServer socket 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`。后续检查未执行，未修改或跳过该测试。日志：`/tmp/T-1111-check.log`。

未运行真实集群 e2e，未提交 git。报告和新增测试仅使用通用 fixture 标识，不收录实际环境地址、域名、节点名称或人员信息。

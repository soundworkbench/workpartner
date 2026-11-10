# T-1111 e2e：S10 用户 Pod 到网关 HTTP 始终不通（查根因 + 失败时留诊断）

仓库：公开仓库 workpartner（本 worktree），基准 main。公开仓库，不得出现公司名、IP、域名、主机名、人名。

## 现象
T-1109 合并后，GitHub Actions 的 k3d e2e（两节点：server-0 + agent-0）连续 3 次 S10 失败，S1–S9 全过。results.json：
```
S10 Two-node network matrix FAIL durationMs 65345
reason: Policy convergence timed out for Pod <prefix>-node-server-0 (node-server); last error: node-server: gateway HTTP
false !== true
location: waitForPolicy (tools/k8s/e2e/scenarios.mjs:28)
```
即 T-1109 加的收敛等待里，DNS 已正常，但「gateway HTTP」（网关主机名:gatewayPort）在 65 秒内从未 open。
同样的网络矩阵在真实两节点 k3s（生产渲染，网关 hostPort 与 containerPort 不同：127.0.0.1:3092→3090，internal 3091）全部通过；
e2e 里 controller.mjs 约 85–95 行 gatewayPort 18083、internalPort 18084、入口 hostPort 18083 且 hostIP 127.0.0.1，hostPort == containerPort。
怀疑方向（未证实，需你核对代码判断）：hostPort 与 containerPort 相同 + hostIP 127.0.0.1 时 portmap/CNI 规则影响了到 Pod IP:18083 的流量；或 e2e 渲染的 NetworkPolicy / node-guard 规则对 gatewayPort 的放行与生产不同；或网关在 e2e 里监听地址/端口与 Service 端口不一致；或「gateway internal」能通而 HTTP 不通说明端口级差异。

## 要做
1. 静态核对 e2e 与生产渲染在网关端口、Service、NetworkPolicy、node-guard 放行上的差异，找出最可能的根因并修复（优先改 e2e 配置使其与生产形态一致，例如 hostPort 与 containerPort 不同；若根因在产品渲染/策略，修产品并补测试）。
2. 加失败诊断：waitForPolicy 超时时，把以下信息写进 evidence（不要含密钥）：网关 Pod IP/端口/就绪状态、网关 Service 与 EndpointSlice、相关 NetworkPolicy 名称与端口、从网关 Pod 自身访问 127.0.0.1:gatewayPort 与 PodIP:gatewayPort 的结果、从同节点另一用户 Pod 访问网关 Pod IP 的结果、两节点 node-guard 规则摘要（已有 guard-*.txt 可复用）。保证下次 GitHub 运行失败时能直接看出原因。
3. 离线测试覆盖新增诊断（假 runtime），node --test tools/k8s/e2e/tests/、node --test --experimental-test-isolation=none tools/k8s-e2e.test.mjs 全过；tools/check.sh 尽量跑（沙箱限制写明）。

## 交付
report.md 追加：根因判断及依据、改动、测试输出摘要。不要提交 git。

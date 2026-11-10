# T-1109 e2e：S10 放行项 TCP 也等策略收敛

仓库：公开仓库 workpartner（本 worktree），基准 main。公开仓库，不得出现公司名、IP、域名、主机名、人名。

## 现象
T-1108 合并后 GitHub Actions 运行：S10 的 DNS 收敛等待已通过，但随后 checkMatrix 第一项 node-server →「gateway HTTP」（网关主机名:gatewayPort，expectedOpen=true）reason=timeout，断言失败。GitHub 上 k3d/kube-router 在 S9/restored 重新应用 NetworkPolicy 后，TCP 放行规则收敛也慢于 DNS。

## 要做
1. tools/k8s/e2e/scenarios.mjs S10：把开头的 waitForPolicy 检查扩展为：每个用户 Pod 的 DNS 等于 gatewayIp，且三个放行项（gateway HTTP、gateway internal、model egress）用 c.from 探测 open===true；外部探针（c.config.externalProbe 存在时）也一并等待。只对 expectedOpen=true 的项等待；拒绝项不得进入等待（避免假通过）。等待通过后原 checkMatrix 和所有断言完全不变。可以把三个放行项的定义抽成函数供等待与 targets 复用。
2. 同一场景里，第一个 Pod 的 job 跑完后 c.ready(slug) 会重建该 Pod；检查后续是否还有对刚重建 Pod 的放行断言，如果有同样补等待（S11 已有 until，不动）。
3. 离线测试（tools/k8s/e2e/tests/ 现有 waitForPolicy 测试旁）：假 runtime 让 gateway HTTP 前几次 open=false/timeout、之后 open=true → S10 继续；拒绝项始终只探一次。node --test tools/k8s/e2e/tests/、node --test --experimental-test-isolation=none tools/k8s-e2e.test.mjs 全过；tools/check.sh 尽量跑（沙箱限制写明）。

## 交付
report.md 追加：改动、测试输出摘要。不要提交 git。

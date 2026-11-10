# T-1108 e2e：S10 第一跳 DNS 等策略收敛

仓库：公开仓库 workpartner（本 worktree），基准 main。公开仓库，不得出现公司名、IP、域名、主机名、人名。

## 现象
GitHub Actions 两次运行（含已修主机探针监听的 T-1105 之后），S1–S9 全过，S10 在约 6.08 秒失败，`error: {name: Error, reason: Timeout}`。S10 第一步是 `c.from(slug, {kind:'dns', host: gateway.hostname})`，`context.mjs` 的 `from` 用 `runtime.exec(..., {timeout: 6000})`，所以是用户 Pod 里第一次 DNS 解析超过 6 秒没返回。S9/restored 刚重新应用 NetworkPolicy，GitHub 上的 k3d（kube-router）策略收敛慢，DNS UDP 包在收敛前被丢，glibc/Node 解析器重试超出 6 秒。真实两节点集群上能过。

## 要做
1. S10 开始做矩阵前，按 S11 的写法用 `until(..., c.config.policyTimeoutMs ?? 60000, 200)` 等待「两个用户 Pod 都能解析网关主机名且结果等于 gatewayIp」，单次探测超时的异常在等待期内吞掉重试；超时后抛出英文错误，写明哪个 Pod、最后一次错误原因。等待成功后原有断言和矩阵完全不变。
2. 检查 S12、S13 等在重新应用策略后紧接网络断言的地方，同样的收敛等待按需补上（只加等待，不放宽断言；「应拒绝」的检查不能因为等待变成假通过——等待只针对应放行的正控制项）。
3. `from` / `fromProbe` 超时时，错误里带上 spec 的 kind/host/port（英文），方便看日志定位。
4. 离线测试：tools/k8s/e2e/tests/ 或 tools/k8s-e2e.test.mjs 里补一个用假 runtime 的测试：前几次 DNS 探测抛 Timeout，后成功 → 场景继续；一直失败 → 超时报错含 Pod 名。`node --test tools/k8s/e2e/tests/`、`node --test --experimental-test-isolation=none tools/k8s-e2e.test.mjs` 全过，`tools/check.sh` 尽量跑（沙箱 socket 限制的既有失败写明）。

## 交付
report.md 追加：改动、测试输出摘要。不要提交 git。

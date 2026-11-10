# T-1105 e2e：S10/S12 主机探针等监听就绪再测

仓库：公开仓库 workpartner（本 worktree），基准 main。公开仓库，代码和文档里不得出现公司名、IP、域名、主机名、人名。

## 现象
GitHub Actions 上跑 `.github/workflows/e2e-k3d.yml`，S1–S9 全过，S10 在 6 秒内失败，结果 `{"name":"Error","reason":"Timeout"}`，命令日志只有 `command terminated with exit code 1`。

`tools/k8s/e2e/controller.mjs` 的 `withHostProbes`（约 317 行）：建两个 hostNetwork 探针 Pod，`kubectl wait --for=condition=Ready` 后**立即**在 Pod 里用 node 连 `127.0.0.1:<samplePort>`，连不上就 exit 1。探针 Pod 没有 readiness 探测，容器一启动就 Ready，而 `node -e "...listen()"` 还没开始监听，于是在快机器上必现竞态。真实集群（慢）上能过。

## 要做
1. `withHostProbes` 里对每个探针 Pod 的本机监听检查改为有限重试：最多约 30 秒、间隔约 500ms，期间每次失败不抛；超时才失败，并且错误信息写清是哪个节点、哪个端口的监听没就绪（英文）。也可以给 auxiliary 探针加 TCP readinessProbe 后 `kubectl wait`，二选一，选更简单可靠的。
2. 同样检查 controller 里其它「建 Pod 后立刻连其服务」的地方（如 model-egress 辅助 Pod），有同样竞态的一并修。
3. 不改场景的断言语义（该放行的放行、该拒绝的拒绝），不放宽任何网络检查。
4. 测试：若 tools/k8s/e2e/tests/ 能离线测重试逻辑（抽成小函数、假 kubectl），加测试：前几次失败后成功→通过；一直失败→超时失败并带节点/端口信息。`node --test tools/k8s/e2e/tests/` 全过；`tools/check.sh` 全过。

## 交付
report.md 追加：根因、改动、测试输出摘要。不要提交 git。

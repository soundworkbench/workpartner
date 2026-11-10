## T-1096 K8 端到端测试套件

仓库 soundworkbench/workpartner（本机 /root/build/notes/zp-gh/wp-src），分支 T-1096-k8s-e2e，基于 main。沙箱不联网，没有 Docker、k3d 和集群；脚本要写成在沙箱外由协调者实跑。
执行规格：docs/specs/2026-11-11-k8s-runtime.md，按「K8 端到端测试套件」一节实现（准备、运行参数、S1–S13 场景、清理、验收照做）。

### 并行开发说明
- main 上已有：K1 kube-client.mjs、K2b k8s-exec.mjs 和 k8s-files.mjs、K4 image/bin/wp-init-hooks.sh。
- K2a（gateway/runtime/k8s.mjs）、K3（gateway/migration.mjs）、K5（tools/k8s/render.mjs 和 deploy/k8s/ 模板）、K6（tools/k8s/distribute-image.sh、node-guard.sh）还在别的分支返工，可以只读参考：/root/build/notes/zp-gh/wp-src/.worktrees/T-1088-k8s-lifecycle、T-1091-migration-owner、T-1093-k8s-manifests、T-1094-node-guard-image（不要改那些目录）。按规格固定的接口和命令行调用它们，不复制代码。K2a 的 inspect 另有 `replicas`、`annotations` 两个字段。
- 场景代码在网关 Pod 里通过 createRuntime({kind:"k8s"}) 跑，结果输出 JSON；e2e.sh 负责渲染、部署、执行、汇总和 trap 清理。

### 约束
- 只新增规格 K8 节列出的文件（tools/k8s/e2e.sh、tools/k8s/e2e-k3d.sh、tools/k8s/e2e/*.mjs、tools/k8s/fixtures/e2e-image/），以及一个能在沙箱里跑的离线测试 tools/k8s-e2e.test.mjs（检查脚本 bash -n、参数解析、场景模块能加载、用假 kubectl 验证 --cleanup 的删除清单）。不改 check.sh、package 文件、rollout.py，不新增依赖。
- 所有前缀、节点地址、镜像名、kubeconfig 都从参数传入，不写死；对象一律带 `workpartner-e2e=<前缀>` 标签。
- 公开仓库：不得出现公司名、人名、真实 IP、域名、主机名；地址示例用 192.0.2.0/24，域名用 *.test。

### 验收
- `node --test tools/k8s-e2e.test.mjs` 全过，`bash -n` 两个脚本通过，测试镜像 Dockerfile 语法合理（沙箱里不构建）。
- 报告写到 docs/tasks/T-1000/T-1096-k8s-e2e/report.md：用法（k3d 和真实集群两种）、每个场景怎么判定、需要协调者在沙箱外跑的命令、对 K2a/K3/K5/K6 接口的假设。

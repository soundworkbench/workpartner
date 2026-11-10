# T-1098 集群运行时文档和类型（K9）

## 背景
仓库是一个开源网关项目（公开仓库），执行规格 `docs/specs/2026-11-11-k8s-runtime.md`。K1–K8 都已合入 main：
- K1 `gateway/runtime/kube-client.mjs` 集群接口客户端
- K2a `gateway/runtime/k8s.mjs` 生命周期；K2b exec/文件
- K3 `gateway/migration.mjs`、`gateway/aionui.mjs` 迁移期按归属转发
- K4 初始化钩子
- K5 `tools/k8s/render.mjs` + `deploy/k8s/*.tmpl` 部署清单
- K6 `tools/k8s/node-guard.sh`、`tools/k8s/distribute-image.sh`、`deploy/k8s/node-guard.*`
- K7 `tools/k8s/adopt-user.mjs`、`adopt-state.mjs` 单个用户接管 / 回滚 / status
- K8 `tools/k8s/e2e.sh`、`e2e-k3d.sh`、`tools/k8s/e2e/**` 端到端测试
各任务的交付报告在 `docs/tasks/T-1000/<分支>/report.md`，可参考其中的用法和注意事项（内容以代码为准）。

## 要做的
只改这 4 个文件：`docs/organization.md`、`docs/deployment.md`、`docs/kubernetes.md`（新建）、`gateway/organization/resolve.d.mts`。

1. `docs/kubernetes.md`（主文档，中文）：
   - 全部 `runtime.k8s.*`、`runtime.migration.*` 等新增配置项及缺省值（从 `gateway/organization/resolve.mjs` 和各模块逐项核对，不要凭印象）；
   - 名称和标签规则（命名空间、StatefulSet/Pod/PVC/PV/Secret 名、标签、注解，包括 paused）；
   - 与 Docker 运行时已接受的差异；
   - 部署顺序：节点准备 → node-guard → 渲染清单 → apply → 镜像分发 → 网关上线 → 归属文件；
   - 单个用户迁移和回滚步骤（K7 各子命令的顺序、dry-run 与 --apply、每步失败怎么处理、status 三类报警的含义）；
   - 探针（K8 e2e）怎么跑：k3d 与真实集群、`--guard`、`--distribute`、`--output`、中断后用原 `--output` 清理；
   - 镜像分发和回收（pin / unpin）；
   - 常见故障：Pending 原因、ErrImageNeverPull、节点失联时 Pod 卡在 Terminating（不要强删，否则可能出现两份机器人）、归属文件缺失或损坏时 503 的含义与恢复。
2. `docs/organization.md`、`docs/deployment.md`：补上指向 kubernetes.md 的入口和必要的配置说明，删掉已过时的说法；Docker 部署原有内容保留。
3. `gateway/organization/resolve.d.mts`：把 resolve.mjs 里新增的 k8s / migration 配置字段补进类型声明，与实现一致。

## 限制
- 公开仓库：不写公司名、真实 IP、域名、主机名、人名；示例用 192.0.2.0/24、2001:db8::、example.test。
- 只改上面 4 个文件。不改代码逻辑、测试、check.sh、package 文件。
- 不联网，不 git 提交，不真连集群或 Docker。

## 验证
`bash tools/check.sh` 通过（跑不动就在报告里写明）。在 `docs/tasks/T-1000/T-1098-k8s-docs/report.md` 写交付报告：每个配置项从哪个源码位置核对的，文档覆盖规格 K9 内容的逐条对照。

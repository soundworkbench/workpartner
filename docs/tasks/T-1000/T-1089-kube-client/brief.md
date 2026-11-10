## T-1089 工作伙伴 k3s 集群 K1：Kubernetes API 客户端

仓库 soundworkbench/workpartner（公开仓库）。基准分支 T-1084-k8s-spec = main + 执行规格 `docs/specs/2026-11-11-k8s-runtime.md` + check.sh 通配。Node 24 环境；沙箱无网络、无集群。测试入口 `bash tools/check.sh`（不设 WORKPARTNER_TEST_IMAGE）。

### 任务
完整执行规格「里程碑 → 一、开发子任务」中的 **K1** 一节：目标、改动文件、要点、验收全部照做。先通读规格的「范围」「约束」「已接受的差异」「配置项」「已定的决定」，它们对本任务同样有约束力。规格和代码现状冲突时，按规格做并在报告里写明。

### 并行说明
K1、K2a、K2b、K3、K4、K5、K6 七个任务同时在各自分支开发，各自只改规格给自己列出的文件。需要别的任务提供的模块时（例如 K2a 用 K1 的客户端、K2b 的 exec/文件模块），按规格里固定的接口编写，测试里用注入的假对象，不要实现别人负责的文件。确需改列表外的文件，在报告里写明理由。

### 约束
1. 公开仓库：代码、注释、测试、文档里不写公司名、人名、真实 IP、真实域名、节点主机名；示例只用 example.com、192.0.2.0/24 这类文档保留值。
2. 不加依赖；不改 gateway/package*.json、tools/rollout.py、tools/check.sh（它已自动包含 tools/*.test.mjs、image/tests/*.test.py、image/bin/*.sh、tools/k8s/*.sh，新测试按这些命名即可）。
3. 不配置 runtime.kind 时 Docker 行为与 main 一致；现有测试断言不减少。
4. 注释和标识符用英文，跟现有代码风格一致。

### 验收
- 规格本节的验收全部满足；`bash tools/check.sh` 全过。
- 开源卫生自查：`git diff` 里没有组织值。
- 报告写清：改了什么、对应规格哪几条、新增测试清单、沙箱里没法验证的点、对其他 K 任务接口的假设。

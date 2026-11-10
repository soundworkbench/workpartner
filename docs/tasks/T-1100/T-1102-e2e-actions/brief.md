# T-1102 集群端到端测试在 GitHub Actions 上跑

## 背景
公开仓库，执行规格 docs/specs/2026-11-11-k8s-runtime.md（K8 部分）。K8 已合入：tools/k8s/e2e.sh、tools/k8s/e2e-k3d.sh、tools/k8s/e2e/**，用法见 docs/kubernetes.md 和 docs/tasks/T-1000/T-1096-k8s-e2e/report.md。现在只能在维护者机器上跑 k3d，会动宿主内核模块和网桥，影响同机其他服务。改为在 GitHub 托管的一次性虚拟机上跑。

## 要做的
1. 新建 .github/workflows/e2e-k3d.yml：仅 workflow_dispatch 触发（不在 push/PR 自动跑）；permissions 只给 contents: read；runs-on ubuntu-24.04；timeout 合理（如 60 分钟）；第三方 action 一律按提交 SHA 固定（照 tests.yml 写法）。
2. 步骤：装 Node 24、kubectl 和 k3d（固定版本，校验 sha256）；k3s 镜像用 workflow 输入参数，默认 rancher/k3s:v1.37.2-k3s1；按 report.md 构建测试镜像和网关镜像（明确 tag，规范化完整引用如 docker.io/library/...）；e2e-k3d.sh up → e2e.sh 全部场景，尽量带 --guard 和 --distribute（k3d 节点用 docker exec 适配 --node-command；节点缺 nft 就在构建步骤里准备带 nft 的同版本节点镜像）；无论成败都执行 e2e.sh --cleanup 和 e2e-k3d.sh down（if: always()）。
3. results.json、日志作为 artifact 上传；任何场景 FAIL 或 SKIP 时 job 失败（SKIP 不算通过），在 job summary 打印每个场景结果。
4. 如需适配脚本（例如 node-command 的 docker exec 适配器），放在 tools/k8s/e2e/ 下，不改 gateway/ 代码。
5. docs/kubernetes.md 探针一节补上「在 GitHub Actions 上跑」的说明，并写明不要在跑着其他服务的宿主上起 k3d（会加载 br_netfilter、改网桥）。

## 限制
- 公开仓库：不写公司名、真实 IP、域名、主机名、人名；不需要也不得使用任何 secrets。
- 只改 .github/workflows/e2e-k3d.yml（新建）、tools/k8s/e2e/ 下新增或修改的适配脚本、docs/kubernetes.md 中探针一节、任务目录 report.md。不改 gateway/、check.sh、package 文件，不改 adopt 相关文件（另一任务在改）。
- 不联网、不 git 提交、不真跑 Docker/k3d（沙箱里做不到）。

## 验证
bash tools/check.sh 通过（跑不动写明原因）；workflow 逐项人工核对语法和参数（沙箱有 actionlint 就跑）。任务目录 report.md 写交付报告：每一步对应的脚本参数从哪里核对。

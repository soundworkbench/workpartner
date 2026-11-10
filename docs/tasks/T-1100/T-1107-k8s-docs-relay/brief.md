# T-1107 文档：多节点下模型出口与 Docker 服务的正确接法

仓库：公开仓库 workpartner（本 worktree），基准 main。公开仓库，不得出现公司名、真实 IP、域名、主机名、人名，示例用 192.0.2.x / example.com。只改文档和 render 警告，不改现有渲染结果。

## 背景
docs/kubernetes.md 约 126 行建议 `modelEgressEndpoint.address` 填「从 Pod 可达的网桥地址」。在多节点集群 + node-guard 下这是错的：
- 其他节点常有同网段 Docker 网桥（如同为 172.18.0.1），Pod 在那些节点访问该地址会落到本节点宿主机。
- 本节点 Pod 经 Service（ClusterIP）访问网桥地址时，kube-proxy 先 DNAT 到网桥地址，包进宿主 INPUT，被 node-guard 的 `iifname cni0 drop` 拦截。
正确做法：在 Docker 所在节点跑一个系统命名空间的 TCP 中继 Pod，用 `modelEgressSelector` 选中它；中继直连网桥上发布的端口（Docker DNAT 后走 FORWARD，不经 INPUT）。网关 Pod 访问同节点 Docker 服务也应直连网桥发布端口，不要经过 k8s Service。

## 要做
1. docs/kubernetes.md：改写 modelEgressEndpoint 段落，明确它只适用于从所有节点都能经路由（非本机地址）到达、且不是节点本机地址的外部端点；Docker 网桥服务改用中继 Pod + selector，写清上面两条原因；给一个中继 Deployment 示例（nodeSelector 钉节点、非 root、只读根、drop ALL、无 SA token、tcpSocket 探针、node 内联 TCP 转发）。约 218 行附近补一句网关访问 Docker 服务的规则。docs/deployment.md 若有相同说法一并改。
2. tools/k8s/render.mjs：`modelEgressEndpoint.address` 落在 RFC1918 私网段时向 stderr 输出一条英文警告（不报错、不改输出），指向文档章节。加对应测试（tools/k8s-render.test.mjs）。
3. `node --test tools/` 和 `tools/check.sh` 全过（沙箱不能开 socket 的既有测试写明）。

## 交付
report.md 追加：改动摘要、测试输出摘要。不要提交 git。

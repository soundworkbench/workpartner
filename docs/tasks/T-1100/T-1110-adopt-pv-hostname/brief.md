# T-1110 接管工具：本地 PV 节点亲和改用 hostname 标签

仓库：公开仓库 workpartner（本 worktree），基准 main。公开仓库，不得出现公司名、IP、域名、主机名、人名。

## 现象（真实两节点 k3s v1.37 集群）
`tools/k8s/adopt-user.mjs pv <slug> --node <控制节点> --apply` 建出的 local PV 节点亲和是
`nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [<node>] }] }]`（约第 294 行）。
随后 `switch --apply` 创建的 StatefulSet Pod 被调度器放到了**另一台**节点，kubelet 报
`MountVolume.NewMounter initialization failed ... path "<data-root>/next/<slug>" does not exist`，Pod 卡在 Init。
即该集群的卷绑定没有按 PV 的 matchFields 约束节点。local PV 的标准写法是 matchExpressions + `kubernetes.io/hostname`。

## 要做
1. pv 生成 PV 时改用 `nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [<node>] }] }]`。
   --node 校验节点存在时，同时读出该节点的 `metadata.labels['kubernetes.io/hostname']`；值必须存在，用它作为 values（通常等于节点名）。缺失时中文/英文报错停止，不写任何对象。
2. 所有读取 PV 节点的地方（约第 172 行 `terms[0].matchFields?.find(...)` 等，switch 预检、verify、status、「已有卷须与计划一致」的比较）改为识别新写法；对已存在的旧 matchFields 写法 PV：pv 不得静默当作一致——报错说明「旧版节点亲和，需人工删除该 PV/PVC 对象（Retain，不删数据）后重跑 pv」，switch 预检同样拒绝（避免再被调度到错误节点）。
3. 同步修改 docs/kubernetes.md K7 一节对 pv 阶段的描述，写明使用 hostname 标签、旧写法的处理方式。
4. 运行时（gateway/runtime/k8s.mjs）的 StatefulSet：PVC 已 Bound 时不加 nodeSelector，这点不改；但如果该 PV 有 hostname 亲和，可选地把同一 hostname 写进 Pod nodeSelector 作为双保险——如实现简单且现有测试能覆盖就做，否则在报告里说明不做的理由。
5. 离线测试：在现有 adopt 测试旁补用例——新建 PV 的亲和是 matchExpressions hostname；节点缺 hostname 标签时拒绝；已存在旧 matchFields PV 时 pv 和 switch 预检都拒绝且无写操作；新写法的已存在 PV 视为一致可重跑。
   `node --test tools/` 下与 adopt/k8s 相关的测试全过；tools/check.sh 尽量跑（沙箱限制写明）。

## 交付
report.md 追加：改动、测试输出摘要。不要提交 git。

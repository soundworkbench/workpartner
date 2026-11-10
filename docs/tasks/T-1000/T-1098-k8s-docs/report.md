# T-1098 / K9 交付报告

完成指定的四个交付文件：新增中文 [Kubernetes 运维文档](../../../kubernetes.md)，更新 organization/deployment 入口及必要说明，补齐 resolve.d.mts 的 runtime.kind、k8s、migration 类型。另按任务验证要求新增本报告；已有 brief.md 未修改。未修改逻辑、测试、check.sh、package 或规格，未联网、未连接真实 Docker/集群、未提交 Git。

## 配置项的源码核对

首先核对 `gateway/organization/resolve.mjs:8–14,28–37,100–131`：对象递归合并，数组替换，runtime 保留自定义字段；`gateway/organization/default.json` 没有 kind/k8s/migration。类型新增成员全部可选，保留旧 Docker 组织的兼容性；运行时必填条件由使用模块检查。文档明确区分 resolver 的有效值、模块缺省值和渲染器必填项，没有把这些字段误称为 resolver 自动注入。

以下路径相对仓库根；行号指本次核对的实现版本。每个新增配置字段都在主文档中列出，类型声明也有对应成员。k8s 的测试注入项 client/createK8sExec/createK8sFiles/now 不作为组织 JSON 配置公开。

| 配置项 | 核对源码位置 | 结论 |
| --- | --- | --- |
| runtime.kind | gateway/runtime/index.mjs:19–29 | 省略为 docker；仅 docker/k8s。 |
| runtime.k8s.namespace | gateway/runtime/k8s.mjs:26–27；tools/k8s/render.mjs:42,126 | 必填 DNS label。 |
| runtime.k8s.systemNamespace | gateway/runtime/k8s.mjs:57–60；gateway/runtime/kube-client.mjs:56–66；tools/k8s/render.mjs:18–32,127–128 | 客户端 namespace；离线渲染无 SA 时显式填，与用户 namespace 不同。 |
| runtime.k8s.systemContainer | gateway/runtime/k8s.mjs:29,337–339；tools/k8s/adopt-user.mjs:198–204 | 默认目标 Pod 名，K7 网关探针局部覆盖 gateway。 |
| runtime.k8s.clusterDomain | gateway/runtime/k8s.mjs:162 | cluster.local。 |
| runtime.k8s.apiTimeoutMs | gateway/runtime/k8s.mjs:54–56；gateway/runtime/kube-client.mjs:28–30,84–86 | 10000 ms，正有限数。 |
| runtime.k8s.inCluster | gateway/runtime/k8s.mjs:54–56；gateway/runtime/kube-client.mjs:38–77 | true；对象可覆盖连接参数；false 无 JSON 时失败。 |
| runtime.k8s.inCluster.server | gateway/runtime/kube-client.mjs:60–62 | 默认使用 KUBERNETES_SERVICE_HOST 及 HTTPS/普通端口环境变量，最终端口 443。 |
| runtime.k8s.inCluster.namespaceFile | gateway/runtime/kube-client.mjs:6,63 | 默认 SA 目录下 namespace。 |
| runtime.k8s.inCluster.tokenFile | gateway/runtime/kube-client.mjs:6,66 | 默认 SA 目录下 token，每次请求重读。 |
| runtime.k8s.inCluster.caFile | gateway/runtime/kube-client.mjs:6,67 | 默认 SA 目录下 ca.crt，每次请求重读。 |
| runtime.k8s.kubeconfigJson | gateway/runtime/k8s.mjs:55；gateway/runtime/kube-client.mjs:40–58 | 无缺省；展开 JSON 的字符串/对象，优先于 inCluster；非路径。 |
| runtime.k8s.storageClass | gateway/runtime/k8s.mjs:28,186–188；tools/k8s/render.mjs:44,129 | 必填，新 PVC 使用。 |
| runtime.k8s.dataVolumeSize | gateway/runtime/k8s.mjs:188；tools/k8s/adopt-user.mjs:243–250 | 20Gi；动态 PVC 请求及静态 PV/PVC 容量。 |
| runtime.k8s.newUserNodeSelector | gateway/runtime/k8s.mjs:163,209–215 | 未 Bound 且未指定 volumeName 才写入，默认 {}；重建模板时清理旧值。 |
| runtime.k8s.memoryRequest | gateway/runtime/k8s.mjs:170 | 512Mi。 |
| runtime.k8s.cpuRequest | gateway/runtime/k8s.mjs:170 | 100m。 |
| runtime.k8s.userResources | gateway/runtime/k8s.mjs:191–193 | 缺省无逐人覆盖。 |
| runtime.k8s.userResources[slug].memory | gateway/runtime/k8s.mjs:171,191–193 | 缺省保留全局内存 limit，显式值转字符串。 |
| runtime.k8s.userResources[slug].cpu | gateway/runtime/k8s.mjs:171,191–193 | 缺省保留全局 CPU limit，显式值转字符串；不改变 requests/维护 Pod。 |
| runtime.k8s.userPriorityClass | gateway/runtime/k8s.mjs:164,215 | 未提供不设置；渲染不创建用户 PriorityClass。 |
| runtime.k8s.gatewayResources.cpu | tools/k8s/render.mjs:143–155；deploy/k8s/gateway.yaml.tmpl | 500m，正 quantity 字符串，requests=limits。 |
| runtime.k8s.gatewayResources.memory | tools/k8s/render.mjs:143–155；deploy/k8s/gateway.yaml.tmpl | 512Mi，同上。 |
| runtime.k8s.imageConfigMap | gateway/runtime/k8s.mjs:113–128；tools/k8s/render.mjs:130 | workpartner-images，系统 namespace，images.json。 |
| runtime.k8s.governingService | gateway/runtime/k8s.mjs:201；tools/k8s/render.mjs:131 | workpartner-users。 |
| runtime.k8s.requiredPolicies | gateway/runtime/k8s.mjs:104–111；tools/k8s/render.mjs:174–176 | 三条固定用户策略；存在性检查，非网络验证。 |
| runtime.k8s.publishedDirectory | gateway/runtime/k8s.mjs:36,150,198；tools/k8s/adopt-user.mjs:8,118–119 | /run/workpartner/published；K7 校验规范绝对非根目录。 |
| runtime.k8s.publishedFiles | gateway/runtime/k8s.mjs:37；gateway/runtime/k8s-files.mjs:191–197；image/bin/wp-init-hooks.sh:3–35 | 三个默认发布文件；补链对自定义隐藏文件有限制。 |
| runtime.k8s.podStartTimeoutMs | gateway/runtime/k8s.mjs:38,82,237–249 | 120000 ms，生命周期轮询 200 ms。 |
| runtime.k8s.terminationGraceSeconds | gateway/runtime/k8s.mjs:39,160,276,282 | 10 秒。 |
| runtime.k8s.inspectCacheMs | gateway/runtime/k8s.mjs:40–41,220–235 | 2000 ms，非负有限数，0 禁用。 |
| runtime.k8s.keepRunningIntervalMs | gateway/gateway.mjs:66；gateway/aionui.mjs:305–335 | 300000 ms；启动立即巡检，0 关闭，仅已存在的自有零副本且无 paused 用户。 |
| runtime.k8s.loadGatewayExtension | gateway/gateway.mjs:58–62 | 未配置时 k8s 不加载；true 不恢复 Docker 接口。 |
| runtime.k8s.cacheMs | gateway/runtime/k8s.mjs:320–334；gateway/runtime/k8s-files.mjs:192,203–207 | 文件模块透传项，2000 ms，独立于 inspectCacheMs。 |
| runtime.k8s.leaseTtlMs | gateway/runtime/k8s.mjs:320–334；gateway/runtime/k8s-files.mjs:4,192–193,262 | 文件模块透传项，1800000 ms，正整数且 ≤2147483647。 |
| runtime.k8s.deploy.gatewayImage | tools/k8s/render.mjs:45,156,207 | 必填，无 runtime.gatewayImage 回退。 |
| runtime.k8s.deploy.gatewayNodeSelector | tools/k8s/render.mjs:132,135 | 默认 control-plane 标签值 "true"，不是假定任意控制面标签值都适用。 |
| runtime.k8s.deploy.entry.mode | tools/k8s/render.mjs:46,64–67,178–185 | 必填，hostPort/clusterIP 两种形状；类型使用联合。 |
| runtime.k8s.deploy.entry.hostIP | tools/k8s/render.mjs:65,180 | hostPort 必填，IPv4 回环地址。 |
| runtime.k8s.deploy.entry.hostPort | tools/k8s/render.mjs:66,181 | hostPort 必填，1–65535。 |
| runtime.k8s.deploy.entry.clusterIP | tools/k8s/render.mjs:67,183–185 | clusterIP 必填，合法 IPv4 且非 0/127 开头。 |
| runtime.k8s.deploy.hostPaths.organization | tools/k8s/render.mjs:47,161–162,213；deploy/k8s/gateway.yaml.tmpl | 必填绝对宿主目录，挂 /organization 只读。 |
| runtime.k8s.deploy.hostPaths.secure | tools/k8s/render.mjs:48,161–162,213；deploy/k8s/gateway.yaml.tmpl | 必填绝对宿主目录，挂 secureDirectory。 |
| runtime.k8s.deploy.hostPaths.state | tools/k8s/render.mjs:49,161–162,214；deploy/k8s/gateway.yaml.tmpl | 必填绝对宿主目录，挂 stateDirectory。 |
| runtime.k8s.deploy.hostPaths.usersFile | tools/k8s/render.mjs:50,161–162,214；deploy/k8s/gateway.yaml.tmpl | 必填绝对宿主文件，挂 usersFile。 |
| runtime.k8s.deploy.egressExceptCidrs | tools/k8s/render.mjs:13–14,51,160,218 | 必须显式提供，可 []；合并固定非公网 IPv4 排除集。 |
| runtime.k8s.deploy.modelEgressSelector | tools/k8s/render.mjs:52,136–141 | 必填，含 model-egress role，不能选网关。 |
| runtime.k8s.deploy.newUserStorage.provisioner | tools/k8s/render.mjs:53,157–158；deploy/k8s/storage.yaml.tmpl | 必填，工具不安装 provisioner。 |
| runtime.k8s.deploy.newUserStorage.parameters | tools/k8s/render.mjs:159,219；deploy/k8s/storage.yaml.tmpl | {}，字符串映射原样透传。 |
| runtime.migration.ownersFile | gateway/migration.mjs:11–40,73–87；tools/k8s/adopt-state.mjs:10–48；tools/k8s/render.mjs:85–102 | 无；未配置则全部归本端，配置后有缓存/故障保护；K7 原子写及锁。 |
| runtime.migration.peerOrigin | gateway/migration.mjs:44–70 | 无，不转发；仅内部 HTTP origin，一次转发、循环 502。 |

原有字段也按源码复核，主文档单列它们在 k8s 中的用途：

| 字段 | 缺省值来源 / 使用位置 |
| --- | --- |
| runtime.nextImage | gateway/organization/default.json:99；resolve.mjs:125；runtime/index.mjs:23 |
| runtime.nextContainerPrefix、nextUserLabel | default.json:102–103；runtime/index.mjs:23；runtime/k8s.mjs:30–32,44–52 |
| runtime.uid | default.json:82；runtime/index.mjs:24；runtime/k8s.mjs:34–35,137–139,165–168 |
| runtime.nextMemory、nanoCpus | default.json:106,84；runtime/index.mjs:27；runtime/k8s.mjs:170–171 |
| runtime.nextPidsLimit | default.json:107；runtime/index.mjs:22–28 与 Docker 分支第 38 行对照：k8s 不映射 |
| runtime.nextPort、nextDirectory、nextModelKeyFile | default.json:104–108；runtime/index.mjs:24；tools/k8s/adopt-user.mjs:223–227 |
| runtime.secureDirectory、stateDirectory、usersFile | default.json:97,116,93；tools/k8s/render.mjs:58–60,163,214–215 |
| runtime.sessionKeyFile、cookieFile、identity.appSecretFile | default.json:96,98,10；tools/k8s/render.mjs:85–102 |
| runtime.hostData、hostSecure、hostConfig | resolve.mjs:127–129；tools/k8s/adopt-user.mjs:82–83；CLI 优先级见该文件第 18–28 行 |
| model.keyPrefix、baseEnvironment | default.json:17,21；runtime/index.mjs:25–26；runtime/k8s.mjs:178,195 |
| model.baseUrl、nextBaseUrl | default.json:16,22；resolve.mjs:104–109,121；tools/k8s/render.mjs:34,112–124 |
| runtime.gatewayOrigin、internalOrigin | default.json:89–90；tools/k8s/render.mjs:117–124,166–173 |
| runtime.gatewayPort、internalPort、localAddress | default.json:86–87,91；tools/k8s/render.mjs:165–169,191–202 |

工具参数独立于组织 schema：node-guard 的 apply/status/remove、IP 族与 systemd 行为对照 `tools/k8s/node-guard.sh` 和 `deploy/k8s/node-guard.*`；分发所有选项、空间门槛、归档摘要、pin/unpin、登记顺序对照 `tools/k8s/distribute-image.sh`。K7 的公共参数和每阶段失败恢复对照 `adopt-user.mjs:11–65,79–450`、`adopt-state.mjs`。K8 的 CLI 缺省逐项对照 `tools/k8s/e2e/options.mjs:7–93`；清理/分发/结果对照 `controller.mjs`。特别按实际代码修正：未 --distribute 的 E2E 镜像 ID 默认来自本地 docker inspect，而非节点 CRI；--distribute 才采用 K6 登记摘要。

## K9 覆盖对照

| 规格 K9 / 任务要求 | 主文档内容与核对依据 |
| --- | --- |
| 全部配置与缺省值 | 「配置与缺省值」四组表及连接说明；包括规格外实际已支持的 systemContainer、userResources、gatewayResources、inCluster/kubeconfigJson、文件缓存/lease。上表逐项列来源。 |
| 名称、标签、注解 | 「名称、标签和生命周期」：namespace、STS/Pod/PVC/PV/Secret、维护 Pod、系统 Service/RBAC/PriorityClass；k8s.mjs:44–52,199–202,228–232，adopt-user.mjs:237–250，render.mjs 和模板。paused 按键存在判断，"false" 仍暂停；仅后台巡检，不是用户请求锁。 |
| Docker 已接受差异 | 「与 Docker 已接受的差异」覆盖规格九项（其中 restart 并入主机名条，镜像与缓存独立说明）：exec 身份/env/超时、detached、proc、文件属主、根目录、主机名、restart/IP、imageId、两种缓存。依据 k8s-exec.mjs、k8s-files.mjs、k8s.mjs；另说明 kubelet pids、默认 CPU、旧版扩展与 K4 钩子。 |
| 部署顺序 | 「部署顺序」七步：节点→guard→render→apply 基础对象→分发→Deployment 上线→初始化/确认归属；先留出 Deployment 保证分发后启动，首次空 ConfigMap 与后续 --only 排除区分清楚，迁移入口在归属确认后开放。 |
| 迁移与回滚 | 「单用户接管与回滚」：status→pv→inventory→switch→verify→status，逐阶段失败恢复；回滚 paused→等全部 Pod 消失→归属→清链接→restart policy→Docker；精确写出 --organization 不合并默认、dry-run 不等于离线、verify --apply 仍有 exec、锁中断恢复、三类 status 报警。依据 K7 源码。 |
| 探针怎么跑 | 「K8 端到端探针」：镜像准备、连续两次 k3d、真实临时 namespace；guard/distribute/output、节点适配器和 SSH 的区别、SKIP、API discovery 审计边界、原 output/state 清理；依据 e2e.sh、e2e-k3d.sh、options/controller/scenarios。 |
| 镜像分发和回收 | 「镜像分发与回收」：全部目标节点先预检，同一归档 import/pin/核验后登记；--replace，部分失败，unpin 不删镜像/登记、不回滚 tag；依据 K6 脚本。 |
| 常见故障 | 「常见故障」：Pending/卷/节点/资源、ErrImageNeverPull、Terminating 禁止强删和双机器人风险、归属损坏首次 503 vs 已有缓存、peer/循环、subPath 换钥匙。 |
| 两篇原文入口及 Docker 保留 | organization 链接完整配置和迁移语义；deployment 限定 Docker socket 前提，增加 k8s 入口，修正“总由 Docker 重启”“总加载扩展”的说法，原 Docker 构建/启动命令保留。 |
| 类型与实现一致 | resolve.d.mts 增加可选 kind/k8s/migration；部署 entry 为判别联合，选择器/parameters 为字符串映射，userResources 支持源码 String() 接受的数值，gatewayResources 按渲染器要求为字符串。 |
| 开源限制 | 新增示例只用通用 slug/资源名、变量、保留地址和 example.test；系统默认地址/cluster.local/docker.io 为源码固定值，明确区分于部署实例；不含真实部署信息或凭据。没有私有词表，不能代替协调者的私有标识审查。 |

## 验证与限制

- 已运行 `env -u WORKPARTNER_TEST_IMAGE -u WORKPARTNER_TEST_NFT_CHECK bash tools/check.sh`，退出码 1。在既有 `tools/wp-seed.test.py:36` 的 `HTTPServer(('127.0.0.1', 0), Endpoint)` 创建 socket 时被沙箱拒绝：`PermissionError: [Errno 1] Operation not permitted`。前面的 JS/Python/shell 语法检查已完成，后续测试未由该脚本执行。没有改脚本或弱化断言；需在允许回环 socket 的环境重跑完整检查。日志临时保存在 `/tmp/t1098-check.log`。
- 补充运行 `node --test tools/k8s-render.test.mjs tools/k8s-adopt.test.mjs tools/runtime-k8s.test.mjs tools/migration.test.mjs`，四个文件级测试全部通过，退出码 0；使用现有假客户端/临时文件测试，无真实集群或 Docker。日志 `/tmp/t1098-targeted.log`。没有新增测试。
- 主文档 13 个 shell/JSON 代码块通过 bash -n / JSON 解析；三篇文档的相对文件链接目标存在；`git diff --check` 通过。
- 本机 Node 为 v22.22.1，未安装 tsc；类型成员与源码逐项人工核对，未声称完成 TypeScript 编译或 Node 24 全量验证。
- 用户禁止真实集群/Docker 操作，因此未执行文档中的构建、apply、分发、迁移、回滚或 E2E。K9 要求的“按文档在 k3d 上走部署及一次迁移/回滚”仍需协调者在运行环境验收；离线检查不能替代它。

## 第 2 轮：文档细节修正

本轮只修改 `docs/kubernetes.md` 并追加本报告；保留工作区已有的其他文件改动。未改代码、测试、check.sh 或 package 文件，未联网、未连接真实集群或 Docker、未提交 Git。

1. **node-guard 模板与安装名。** 按 `deploy/k8s/node-guard.service.tmpl` 修正模板文件名，逐一说明必须替换的 `@SCRIPT_PATH@`、`@POD_CIDRS@`、`@TUNNEL_INTERFACE@`、`@NODE_IPS@`。明确安装为 `/etc/systemd/system/node-guard.service`，补充 daemon-reload 和 enable --now，与后文 reload 使用的服务名一致。
2. **隧道接口名限制。** 按 `tools/k8s/node-guard.sh` 的 Python 校验，补充不得为 `cni0`，且须完整匹配 `[a-zA-Z0-9_.:-]{1,15}`。
3. **镜像职责。** 网关镜像要求改为含 K1–K3；明确 K4 初始化钩子位于用户镜像，源码为 `image/bin/wp-init-hooks.sh`，由 `image/bin/start.sh` 加载。
4. **字面 IP 清理。** 删除探针参数表中的两个缺省字面地址，也将全文扫描发现的 localAddress 回环字面地址改为文字描述并指向 `gateway/organization/default.json`。主文档只保留允许的 IPv4/IPv6 文档示例地址。实际执行 `bash tools/k8s/e2e.sh --help` 后确认帮助只列出探针参数、不显示其缺省值，因此改为指向 `tools/k8s/e2e/options.mjs`，并说明在探针命令后追加 `--print-config` 可离线查看含缺省值的有效配置。
5. **PriorityClass 排障位置。** 从 Pod Pending 原因中移除缺 PriorityClass，单列 StatefulSet 未能创建 Pod，提示查看 StatefulSet 的 FailedCreate 事件并修复 PriorityClass 配置。
6. **真实集群探针镜像引用。** 在真实集群命令前说明 `--distribute` 的两种镜像都须使用 `docker.io/library/...` 形式的规范化完整引用，构建标签、分发与探针参数一致；与镜像分发章节及 K6 引用规范化、K8 按引用查询登记的实现一致。

本轮验证：

- 运行 `env -u WORKPARTNER_TEST_IMAGE -u WORKPARTNER_TEST_NFT_CHECK bash tools/check.sh`，退出码 1。JS/Python/shell 语法检查完成后，在既有 `tools/wp-seed.test.py:36` 创建 HTTPServer socket 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`；后续测试未执行。日志为 `/tmp/t1098-round2-check.log`。未改脚本或断言，需要在允许本地 socket 的环境重跑完整检查。
- 主文档 10 个 bash/JSON 代码块通过 `bash -n` / JSON 解析；模板四个占位符和接口正则与源码一致，Pending 行已无 PriorityClass。
- 全文 IP 扫描通过，仅保留允许的文档示例地址；`bash tools/k8s/e2e.sh --help` 离线执行成功；`git diff --check` 通过。

# Kubernetes 集群运行时

本文以当前实现为准，对应[运行时规格 K9](specs/2026-11-11-k8s-runtime.md)。Docker 部署继续使用[部署参考](deployment.md)，组织文件的加载方式见[组织配置](organization.md)。以下部署、迁移和探针命令供管理员在具备权限的运行环境执行；离线文档检查不需要连接集群或 Docker。示例中的节点名、路径和地址变量由部署方填写，不能把实际值、凭据或运行产物提交到公开仓库。

## 配置与缺省值

`gateway/organization/resolve.mjs` 将 `organization.json` 递归合并到 `gateway/organization/default.json`。默认 JSON **没有** `runtime.kind`、`runtime.k8s`、`runtime.migration`；下面的缺省值由使用它们的模块提供，不会被 resolver 自动写回。新增字段没有专用环境变量覆盖。`WORKPARTNER_ORG_DIR` 选择组织目录；原有 `NEXT_IMAGE`、`MODEL_BASE_URL` 等覆盖仍有效。渲染工具使用 `organizationData`，不应用 `resolveOrganization` 的部署环境覆盖，应把所需值写进组织 JSON。

### 运行时、连接与存储

下面除第一行外均以 `runtime.k8s.` 为前缀。「必填」指使用对应功能时必填；Docker 可以省略整个对象。

| 字段 | 缺省值 | 含义与约束 |
| --- | --- | --- |
| `runtime.kind` | `docker` | 仅接受 `docker`、`k8s`，其他值使启动失败。 |
| `namespace` | 无，必填 | 用户工作负载命名空间，DNS label，最长 63 字符。 |
| `systemNamespace` | 客户端命名空间 | 集群内取 ServiceAccount namespace；JSON kubeconfig 取当前 context namespace，未写则 `default`。离线渲染无 ServiceAccount 时必须显式配置；渲染要求与用户命名空间不同。 |
| `systemContainer` | `execNamed(name)` 的 `name` | 系统 Pod 中的目标容器名，非空 DNS label；部署网关容器名为 `gateway`，Pod 名由 Deployment 生成。K7 验证网关时局部覆盖为 `gateway`。 |
| `clusterDomain` | `cluster.local` | 用户 Pod DNS 搜索域追加 `<systemNamespace>.svc.<clusterDomain>`。 |
| `apiTimeoutMs` | `10000` | API 请求超时，毫秒，正有限数。 |
| `inCluster` | `true` | 使用挂载的 ServiceAccount；也接受 `{server, namespaceFile, tokenFile, caFile}`，各成员可省略。详见下文。 |
| `kubeconfigJson` | 无 | 已展开 JSON kubeconfig 的字符串或对象，不是文件路径。设置后运行时优先使用它。不要把含凭据的配置提交到仓库。 |
| `storageClass` | 无，必填 | 新用户 PVC 的 StorageClass；K7 静态卷使用空存储类。 |
| `dataVolumeSize` | `20Gi` | PVC 请求容量及 K7 静态 PV 声明容量；local-path 不提供硬配额保证。 |
| `newUserNodeSelector` | `{}` | 字符串映射；仅当 PVC 非 Bound 且没有 `spec.volumeName` 时加入模板。已绑定卷由卷的节点约束决定位置。 |
| `memoryRequest` | `512Mi` | 用户主容器内存 request，Kubernetes quantity 字符串。 |
| `cpuRequest` | `100m` | 用户主容器 CPU request。 |
| `userResources` | 无（各用户 `{}`） | `{slug: {memory?, cpu?}}`，覆盖用户主容器 limits；字符串或数值，写模板时转字符串；不覆盖 requests，也不覆盖一次性维护 Pod 的全局 limits。 |
| `userPriorityClass` | 无 | 可选的已有 PriorityClass；工具不会创建它。 |
| `imageConfigMap` | `workpartner-images` | 系统命名空间的镜像登记；`data["images.json"]` 是 `{镜像引用: config摘要}`。 |
| `governingService` | `workpartner-users` | 用户 StatefulSet 的 headless Service。 |
| `requiredPolicies` | 下述三条策略 | `workpartner-default-deny`、`workpartner-user-egress`、`workpartner-user-ingress`。create/start/restart/runOnce 检查存在性，不证明规则有效；渲染器只接受这些名称组成的数组。保留三条完整列表。 |
| `publishedDirectory` | `/run/workpartner/published` | 发布 Secret 的只读挂载路径，通过 `WORKPARTNER_PUBLISHED_DIR` 传入镜像；K7 要求规范的绝对路径且不能为 `/`。 |
| `publishedFiles` | 下述三个文件 | `.zp-market-token`、`.wp-feishu-cli.json`、`.zp-preview-relay-key`；文件名须为单层安全名称。默认三项由镜像建立链接；自定义隐藏文件不会被镜像通配扫描自动补链。 |
| `podStartTimeoutMs` | `120000` | Pod 启动及生命周期删除等待上限，毫秒；轮询间隔 200 ms。 |
| `terminationGraceSeconds` | `10` | Pod 优雅终止秒数。 |
| `inspectCacheMs` | `2000` | inspect 缓存毫秒，有限且非负；0 禁用。 |
| `keepRunningIntervalMs` | `300000` | 启动时立即巡检，此后按间隔巡检；0 关闭。只启动归自己所有、已存在、replicas=0、未运行、未 paused 的 AionUi 工作区，不创建缺失工作区。 |
| `loadGatewayExtension` | 未设置时不加载 | 推荐 `false`。`true` 允许加载组织扩展，但不会恢复 Docker 访问能力；旧版运行时仍不可用。 |
| `cacheMs` | `2000` | 经运行时透传给文件模块的发布 Secret 读取缓存毫秒，独立于 inspect 缓存。 |
| `leaseTtlMs` | `1800000` | 文件模块暂存清理 lease 的有效期，毫秒，正整数且不超过 2147483647。 |

ServiceAccount 默认目录为 `/var/run/secrets/kubernetes.io/serviceaccount`，使用其中的 `namespace`、`token`、`ca.crt`；每次请求重新读取令牌和 CA。API 地址取 `KUBERNETES_SERVICE_HOST`，端口依次取 `KUBERNETES_SERVICE_PORT_HTTPS`、`KUBERNETES_SERVICE_PORT`、443。`inCluster` 对象的四个成员可覆盖这些值；只写 `inCluster:false` 又不提供 JSON kubeconfig 会失败。JSON kubeconfig 必须内嵌 CA/客户端证书数据或 token；不支持外部证书文件、exec/auth-provider 或跳过 TLS 校验。工具的 `--kubeconfig` 才接受文件路径。

原有字段在 Kubernetes 中继续使用：

| 字段 | 仓库缺省值 | Kubernetes 用途 |
| --- | --- | --- |
| `runtime.nextImage` | `workpartner-next:0.4.2` | 用户及默认维护 Pod 镜像；部署前换成已分发引用。 |
| `runtime.nextContainerPrefix` / `nextUserLabel` | `workpartner-next-` / `workpartner.next-user` | 资源名称前缀和用户标签键。 |
| `runtime.uid` | `1001` | 必须为非 root 正整数，主容器 UID/GID。 |
| `runtime.nextMemory` / `nanoCpus` | `3221225472` / `2000000000` | 全局 limits 为 3 GiB、2 CPU；直接调用运行时未提供时也回退到这些值。 |
| `runtime.nextPidsLimit` | `1024` | Kubernetes 不映射该值；两节点均需核实 kubelet 的 `pod-max-pids`。 |
| `runtime.nextPort` | `25808` | 工作区主端口。 |
| `runtime.nextDirectory` | `/workspaces` | K7 定位旧宿主数据：`<data-root><nextDirectory>/<slug>`；新 Pod 的 `/data` 来自 PVC。 |
| `runtime.nextModelKeyFile` | `/etc/partner/model.key` | 模型钥匙 Secret 的 subPath 挂载。 |
| `runtime.secureDirectory` / `stateDirectory` / `usersFile` | `/secure` / `/state` / `/etc/partner/users.json` | 网关内凭据、状态目录、用户文件。 |
| `runtime.sessionKeyFile` / `cookieFile` | `/secure/gateway-session.key` / `/state/cookies.json` | 需持久化并在两网关间保持一致。 |
| `identity.appSecretFile` | `/secure/identity-app.secret` | 渲染器要求位于 secure 或 state 目录内。 |
| `runtime.hostData` / `hostSecure` / `hostConfig` | resolver 回退为 `""` | Docker 宿主路径；K7 钥匙目录优先 `--host-secure`，其次非空 hostSecure，再 secureDirectory；不代替 deploy.hostPaths。 |
| `model.keyPrefix` / `baseEnvironment` | `model-` / `MODEL_BASE_URL` | 网关从 `<secureDirectory>/<keyPrefix><slug>.key` 读取钥匙；通过指定环境变量传入模型 URL。 |
| `model.baseUrl` / `nextBaseUrl` | `""` / `""` | 部署必须设置模型地址；K5 用 baseUrl 建 Service，非空 nextBaseUrl 必须同主机同端口。 |
| `runtime.gatewayOrigin` / `internalOrigin` | `http://workpartner-gateway:3090` / `http://workpartner-gateway:3091` | 必须同一个短 Service 主机名，端口分别等于 gatewayPort、internalPort。 |
| `runtime.gatewayPort` / `internalPort` / `localAddress` | `3090` / `3091` / IPv4 回环地址的 3080 端口（具体值见 `gateway/organization/default.json`） | 入口及内部服务端口、宿主隧道目标。hostPort 配置与 localAddress 不一致时渲染器警告，不能忽略。 |

### 部署渲染配置

`runtime.k8s.gatewayResources.cpu`、`.memory` 默认分别为 `500m`、`512Mi`，接受正 quantity 字符串；网关 requests=limits，使用 Guaranteed QoS。以下字段前缀均为 `runtime.k8s.deploy.`，只有渲染工具读取。

| 字段 | 缺省值 | 含义与约束 |
| --- | --- | --- |
| `gatewayImage` | 无，必填 | 含 K1–K3 的网关镜像；不从原有 `runtime.gatewayImage` 回退。K4 初始化钩子位于用户镜像中，源码为 `image/bin/wp-init-hooks.sh`。 |
| `gatewayNodeSelector` | `{"node-role.kubernetes.io/control-plane":"true"}` | 非空标签映射；核实真实标签值，控制面标签可能为空字符串。模板容忍 control-plane/master 的 NoSchedule 污点。 |
| `entry.mode` | 无，必填 | `hostPort` 或 `clusterIP`。 |
| `entry.hostIP` / `entry.hostPort` | 无 | hostPort 模式必填；hostIP 只能为 IPv4 回环地址，端口 1–65535。只发布 gatewayPort，internalPort 不发布到宿主。 |
| `entry.clusterIP` | 无 | clusterIP 模式必填；集群 Service 网段内预留 IPv4，渲染器拒绝 0/127 开头地址；另建 `<gateway>-entry`。 |
| `hostPaths.organization` | 无，必填 | 节点组织目录 → `/organization`，只读。 |
| `hostPaths.secure` | 无，必填 | 节点凭据目录 → runtime.secureDirectory。 |
| `hostPaths.state` | 无，必填 | 节点状态目录 → runtime.stateDirectory。 |
| `hostPaths.usersFile` | 无，必填 | 节点已有用户文件 → runtime.usersFile。 |
| `egressExceptCidrs` | 无，必须显式提供，可为 `[]` | 补充禁止用户访问的 IPv4 CIDR，必须包括全部节点公网地址 `/32`；例如 `192.0.2.10/32`。自动合并链路本地、RFC1918、共享地址及回环网段，详见模板。 |
| `modelEgressSelector` | 无，必填 | 非空标签映射，必须含 `workpartner/role: model-egress`，不能选中网关 Pod；模型出口工作负载由部署方提供。 |
| `newUserStorage.provisioner` | 无，必填 | 已安装的 provisioner，例如 `rancher.io/local-path`；渲染器不安装 provisioner。 |
| `newUserStorage.parameters` | `{}` | 字符串映射，原样交给 provisioner；确认其实际支持。 |

所有 hostPaths 必须是非根绝对路径且事先存在。sessionKeyFile、cookieFile、identity.appSecretFile，以及配置 migration 时的 ownersFile，必须在网关 secureDirectory 或 stateDirectory 内。渲染器要求网关与模型 URL 使用短 Service 名，不能用节点 IP、外部域名或完整集群域名替代。生成的 StorageClass 固定为 `Retain`、`WaitForFirstConsumer`。当前网络清单的公网放行/排除使用 IPv4；node-guard 支持 IPv4/IPv6 地址（如 `2001:db8::10`），不能据此宣称整个方案已完成双栈验收。

### 迁移归属配置

| 字段 | 缺省值 | 行为 |
| --- | --- | --- |
| `runtime.migration.ownersFile` | 无，未配置则不启用归属过滤 | 网关只读、工具原子写；K7 要求绝对路径。两网关必须看到同一文件的替换。 |
| `runtime.migration.peerOrigin` | 无，不转发 | 对端内部 HTTP origin，例如 `http://192.0.2.10:3090`；禁止 HTTPS、认证信息、非根路径、query、fragment。两边分别指向另一边，内部网络必须可达。 |

初始归属文件（字段没有隐式缺省）：

```json
{"version":1,"default":"docker","users":{}}
```

`users` 的键为 slug，值为 `docker` 或 `k8s`；显式条目优先于 default。启用归属后，backend 非 `aionui` 的旧版用户始终归 Docker，即使文件把其写成 k8s。不配置 ownersFile 时，每套网关都认为所有用户归自己，不能用这种方式并行管理同一批用户。HTTP/WebSocket 可转发一次；重复的 `x-workpartner-delegated` 标记导致 502，防止循环。

共享 users、session key、cookie/授权状态及个人凭据；宿主映射可不同但内容和归属必须一致。归属文件随请求读取，以 mtime/ino/size 检测更新，无需重启。应挂载父目录以便看到 atomic rename，不能使用固定旧 inode 的单文件挂载或 subPath 挂载。K7 使用 `<ownersFile>.adopt.lock` 串行执行写操作，保留文件 UID/GID/mode，写临时文件并 fsync、rename、fsync 父目录。

## 名称、标签和生命周期

设 `<c> = runtime.nextContainerPrefix + slug`。slug 匹配 `^[a-z][a-z0-9-]{1,30}$`；`<c>` 必须为最长 52 字符的 DNS label，预留控制器修订 hash 和资源后缀。不要通过截断 slug 规避冲突。

| 对象 | 名称 / 位置 |
| --- | --- |
| StatefulSet / 主 Pod / 主容器 | 用户 namespace 中 `<c>` / `<c>-0` / `workspace`。 |
| 数据 PVC / 可选旧工作 PVC | `<c>-data`（RWO）/ `<c>-oldwork`（K7 为 ReadOnlyMany，挂到 `/data/old-work` 只读）。 |
| 静态 PV | `<namespace>-<c>-data`、`<namespace>-<c>-oldwork`；集群级，最长 253 字符，精确绑定 claim 和节点 metadata.name。动态 PV 名由 provisioner 决定。 |
| 模型钥匙 / 发布 Secret | `<c>-model-key`（键 `model.key`）/ `<c>-published`。 |
| 一次性维护 Pod | `<c>-<name>`，name 默认 `resetpass`，完整名称需为 DNS label。 |
| 网关 Deployment / ServiceAccount / headless Service | systemNamespace 中，名称取 gatewayOrigin 的短主机名；Pod 名由控制器生成，容器名为 `gateway`。 |
| 其他 Service | governingService 位于用户 namespace；模型 Service 名取 model.baseUrl；clusterIP 入口为 `<gateway>-entry`，原 headless Service 保留用于预览来源验证。 |
| RBAC / PriorityClass | Role 和 RoleBinding 分别为用户 namespace 的 `workpartner-users`、系统 namespace 的 `workpartner-system`；网关 PriorityClass 为 `<systemNamespace>-gateway`，值 1000000。 |

用户资源标签为 `app.kubernetes.io/part-of=workpartner`、`workpartner/role=user`、`<nextUserLabel>=<slug>`；一次性 Pod 的 role 为 `job`。网关 Pod 的 role 为 `gateway`，模型出口必须为 `model-egress`。nextUserLabel 必须为合法标签键，不能与上述两个固定键冲突。渲染对象带 part-of 标签，用户 Namespace 还带 PSA `enforce=baseline`、`warn=restricted`。镜像 ConfigMap 名可配置；NetworkPolicy 名固定为三条用户策略及系统 namespace 的 `workpartner-model-ingress`。

StatefulSet 注解 `workpartner/image-id` 保存创建/更新模板时的镜像登记摘要；`workpartner/paused` **只要键存在**就暂停常驻巡检，写 `"false"` 也仍暂停。维护时可先 annotate paused 再 scale 到 0；恢复要删除注解键。该注解不拦截用户触发的 start，维护窗口需同时暂停用户请求。

StatefulSet 只能有 0/1 副本，`OnDelete` 更新。重复 create 保留副本数并更新模板，删除配置时会清除旧 nodeSelector/priorityClass；已有 Pod 需重建才接收模板变化。模型钥匙使用 Secret subPath，更新后同样需重建 Pod。remove 删除 StatefulSet 并等待所有该用户 Pod 消失，保留 PVC 和 Secret；不删除数据。runOnce 仅在 StatefulSet 缺失或副本为 0 且该用户无任何 Pod 时执行，默认完成等待 60000 ms，输出最多 1 MiB，返回前等待维护 Pod 删除。

主容器不挂 ServiceAccount token，关闭 Service links，按 runtime.uid 运行，禁止提权、drop ALL、seccomp RuntimeDefault；init 容器仅以 root 加 CHOWN 执行非递归 `chown uid:uid /data`。已有子目录权限问题需单独核实，启动不会递归修复。网关用限定命名空间的 RBAC，不具备创建静态 PV 的集群权限，K7 由管理员执行。

## 与 Docker 已接受的差异

1. exec 不能切换身份，只接受当前 UID 或 `uid:uid`；env 通过 `env -- K=V ...` 前置，createTimeout 是建连/握手超时。默认执行 30000 ms、建连 10000 ms；Docker 的 0（无限）在这里映射为 24 小时。
2. detached exec 使用 setsid，立即返回 exitCode=null，不支持 stdin；镜像的 wait -n 只等待自己启动的主进程。
3. processes 读取容器 `/proc`，pid/ppid 为字符串，仅用于进程父子关系。
4. 普通文件经 exec 写入，属主固定为容器用户，owner:false/chown:false 无效；发布文件和模型钥匙来自 root:root、0444 的只读 Secret。
5. `/data` 根目录由 PVC 和 init 容器准备，directoryMode 不改变根目录；普通文件操作使用相对数据路径，依赖运行中的主 Pod，发布 Secret 可独立更新。
6. 主机名为 `<c>-0`。restart 删除旧 Pod 并等待新 UID 的 Pod 运行，IP 可能变化；后续请求重新 inspect。
7. imageId 查询镜像 ConfigMap，inspect.imageId 读取 StatefulSet 注解，表示模板登记值，并非实时读取节点镜像。
8. inspect 最长缓存 inspectCacheMs；镜像登记缓存最长 10 秒，本运行时生命周期操作清除这两类缓存。文件模块另有独立的发布 Secret 缓存。

没有 nanoCpus 时 Kubernetes 回退 2 CPU，Docker 可保持无限制；个人资源覆盖只作用于 Kubernetes。容器层补丁应放入 `/data/.zp-init.d/bin`（前置 PATH）或同目录 `.sh` 钩子。钩子按文件名字节排序执行，必须为本人拥有、组和其他人不可写的普通非符号链接文件；每个 60 秒超时，失败记录警告并继续。发布链接在钩子前准备。Kubernetes 默认不加载组织扩展，旧版 runtime 方法报 `LegacyRuntimeUnavailable`；旧版用户由 Docker 网关服务。

## 部署顺序

1. **节点准备。** 准备 Node 24 管理工具、kubectl、k3s/containerd、支持 NetworkPolicy 的 CNI 和已验证的存储 provisioner。检查所有可调度节点的镜像架构、磁盘、pod-max-pids、节点标签及已有数据权限。保留旧 Docker 容器、网络和原数据目录。网关节点准备 hostPaths 指向的目录及 users.json；模型出口 Pod 由部署方准备，标签必须匹配 selector。备份数据和状态。
2. **node-guard。** 在每个节点先预览再加载独立的 `inet workpartner_guard` 表：

   ```bash
   bash tools/k8s/node-guard.sh apply --pod-cidr "$POD_CIDRS" \
     --tunnel-interface "$TUNNEL_INTERFACE" --node-ips "$ALL_NODE_IPS" --dry-run
   bash tools/k8s/node-guard.sh apply --pod-cidr "$POD_CIDRS" \
     --tunnel-interface "$TUNNEL_INTERFACE" --node-ips "$ALL_NODE_IPS"
   bash tools/k8s/node-guard.sh status
   ```

   ALL_NODE_IPS 是全部节点地址，含公网和 IPv6，逗号分隔。TUNNEL_INTERFACE 不能是 `cni0`，须完整匹配脚本校验正则 `[a-zA-Z0-9_.:-]{1,15}`（1–15 个字符）。pod-cidr 仅记录注释；规则按 cni0、隧道接口和节点目的地址匹配，防来源伪造。保留 established/related、TCP 6443/10250、IPv6 邻居发现例外。脚本需 Python 3 和 nft 权限，保持与 deploy 模板的相对目录。首次正式加载须按规格取得授权；本步骤不修改 k3s 参数或现有防火墙表。

   替换 `deploy/k8s/node-guard.service.tmpl` 中的全部四个占位符：`@SCRIPT_PATH@` 为节点上 `tools/k8s/node-guard.sh` 的绝对路径，`@POD_CIDRS@` 为逗号分隔的 Pod CIDR 列表，`@TUNNEL_INTERFACE@` 为符合上述限制的隧道接口名，`@NODE_IPS@` 为上述全部节点地址列表。将替换后的文件安装为 `/etc/systemd/system/node-guard.service`，执行 `systemctl daemon-reload` 后用 `systemctl enable --now node-guard.service` 启用。更新用 `systemctl reload node-guard.service`；restart 先 remove 会出现空窗。nftables reload 可传播重新 apply，但两者不是一个原子事务。默认只有启动顺序，guard 失败仍可能启动 k3s；强依赖由运维另行配置。卸载只用 `node-guard.sh remove` 删除自己的表。
3. **渲染清单。** 配好上述组织字段，先离线输出到新目录：

   ```bash
   node tools/k8s/render.mjs --org "$ORG_DIR" --output "$MANIFEST_DIR"
   ```

   不指定 output 时输出到 stdout；JSON 文档也是合法 YAML。已有非空目录会拒绝，部分写失败保留文件，重跑换新空目录。检查 hostPort 与 localAddress 一致。模型出口只渲染 Service/网络规则，不生成其镜像、凭据和工作负载。
4. **apply 基础对象。** 先应用 namespace，再应用其他对象；首次可以包含空镜像 ConfigMap。为符合先分发后上线的顺序，先把 Deployment 文件留到第 6 步：

   ```bash
   export KUBECONFIG="$JSON_KUBECONFIG"
   for file in "$MANIFEST_DIR"/namespace_*.yaml; do kubectl apply -f "$file"; done
   for file in "$MANIFEST_DIR"/*.yaml; do
     case "${file##*/}" in namespace_*|deployment_*) continue ;; esac
     kubectl apply -f "$file"
   done
   ```

   后续重渲染使用 `--only Namespace,ServiceAccount,Role,RoleBinding,PriorityClass,Deployment,Service,NetworkPolicy,StorageClass`，排除 ConfigMap，避免清空已有镜像登记。即使 --only 也校验完整配置。
5. **镜像分发。** 将用户镜像导入全部可能运行用户/维护 Pod 的节点，网关镜像导入选定网关节点并核实 ID，步骤见下一节。任何节点失败都先处理，不切换用户。所有相关容器（包括 init）使用 imagePullPolicy=Never。
6. **网关上线。** 应用 Deployment 文件，检查 Pod、Service、RBAC、状态及凭据挂载。模板是单副本 Recreate、TCP liveness probe。迁移场景此时已配置 ownersFile 路径，尚无有效归属时请求 503 是预期保护；在完成第 7 步前不接入用户流量。Docker peer 仅在内部可达位置发布，验证跨 CNI/Docker 的 DNAT 路径，避免依赖会被 guard 阻止的宿主监听。
7. **归属文件与入口。** 在共享父目录原子放入 `version:1/default:docker/users:{}` 初始文件，两网关确认读取一致后再接流量；已有归属文件必须保留，不能重新清空。配置两端 peerOrigin，验证未迁移用户转发、旧版用户及 WebSocket。测试网关通过部署参考的登录、文件、模型、预览、技能上传、授权、重置口令、镜像重建检查，再按单用户步骤切换。网关 Pod 重启不应影响用户 Pod。

迁移先试点一人观察 48 小时，再按批准节奏每批约 10 人、逐人 verify、每批 status 无报警并观察。切换 default 到 k8s 前，为仍需 Docker 的 AionUi 用户保留显式条目，避免未迁移用户因缺省归属变化被错误接管；新用户之后由 newUserNodeSelector 和 StorageClass 落盘。正式入口切换及首批迁移遵循规格中的授权条件。

## 镜像分发与回收

分发端需本地 Docker 镜像、ssh、kubectl、Python 3；节点目标可非交互执行 k3s ctr/crictl 和 df。节点无需 Node/Python。使用明确且一致的镜像引用（例如 `docker.io/library/workpartner-user:release`），该字符串也应写入 nextImage，登记键使用传入引用。

```bash
bash tools/k8s/distribute-image.sh "$USER_IMAGE" \
  --node "$SERVER_SSH" --node "$AGENT_SSH" \
  --namespace "$SYSTEM_NAMESPACE" --configmap "$IMAGE_CONFIGMAP" \
  --kubeconfig "$JSON_KUBECONFIG"
bash tools/k8s/distribute-image.sh "$GATEWAY_IMAGE" \
  --node "$SERVER_SSH" --namespace "$SYSTEM_NAMESPACE" \
  --configmap "$IMAGE_CONFIGMAP" --kubeconfig "$JSON_KUBECONFIG"
```

默认 configmap 为 workpartner-images；默认远端磁盘路径 `--data-dir` 为 `/var/lib/rancher/k3s/agent/containerd`。默认空闲空间门槛为镜像 Size 的两倍加 1 GiB，可用 `--min-free-bytes` 指定正整数。本地 TMPDIR 需容纳完整归档。先检查所有节点磁盘、保存一次归档并计算 config SHA256，再检查同 tag 冲突；有不同 ID 必须显式 `--replace`。只接受单一 config 的镜像归档，目标节点使用匹配架构。

所有节点 import、添加 `io.cri-containerd.pinned=pinned`、crictl 核验通过后才更新 ConfigMap，并以 resourceVersion 防并发覆盖。不能用 Docker inspect 的 manifest/index ID 代替 config digest。中途失败会列出确认导入及可能部分改变的节点；修复后重跑，登记冲突时重新读取再试，不能把部分成功当完成。

旧版本仍可能回滚时保留 pin。确认无使用者且不再依赖该缓存后，对相应节点解除：

```bash
bash tools/k8s/distribute-image.sh --unpin "$OLD_IMAGE" \
  --node "$SERVER_SSH" --node "$AGENT_SSH"
```

没有独立 `--pin` 子命令，分发时自动 pin。unpin 仅去标签，允许 kubelet 后续回收，不删除镜像、不删除登记、不恢复旧 tag；替换回滚须重新分发原镜像。运行时看到登记不等于节点仍有镜像；回收后重新使用前应重新分发。

## 单用户接管与回滚（K7）

在原 Docker 宿主执行，能够读取原数据、钥匙和共享归属文件，并使用有 PV/节点权限的管理员 JSON kubeconfig。只支持已存在的 AionUi 用户。不搬数据，不删旧容器。每条命令默认 dry-run，**没有 `--dry-run` 参数**；省略 --apply 不做文件、Docker、Kubernetes 或 exec 写操作，但仍连接 Docker/集群读取状态。

推荐用 WORKPARTNER_ORG_DIR 加载并合并完整配置，公共参数保存为 Bash 数组：

```bash
export WORKPARTNER_ORG_DIR="$ORG_DIR"
adopt=(node tools/k8s/adopt-user.mjs)
common=(--kubeconfig "$JSON_KUBECONFIG" --users "$HOST_USERS_FILE"
  --host-secure "$HOST_SECURE_DIR" --owners-file "$HOST_OWNERS_FILE")
slug=fixture-user
"${adopt[@]}" status "${common[@]}"
"${adopt[@]}" pv "$slug" --node "$ORIGINAL_NODE" --data-root "$DATA_ROOT" "${common[@]}"
"${adopt[@]}" pv "$slug" --node "$ORIGINAL_NODE" --data-root "$DATA_ROOT" "${common[@]}" --apply
"${adopt[@]}" inventory "$slug" "${common[@]}"
"${adopt[@]}" inventory "$slug" "${common[@]}" --apply
"${adopt[@]}" switch "$slug" "${common[@]}"
# 进入该用户维护窗口，暂停请求并等待在途生命周期任务完成，再执行：
"${adopt[@]}" switch "$slug" "${common[@]}" --apply
"${adopt[@]}" verify "$slug" "${common[@]}" --apply
"${adopt[@]}" status "${common[@]}"
```

`--organization` 接受 **JSON 文件路径**，直接解析完整配置，不合并默认值，也不应用环境覆盖，不等于 render 的 --org 目录。若不用上述环境方式，应提供有效的完整解析结果。--users 默认取 runtime.usersFile；--owners-file 默认取 runtime.migration.ownersFile，均需按宿主可见路径覆盖。--host-secure 的最终选择必须为绝对路径，switch 先检查 `<目录>/<model.keyPrefix><slug>.key` 可读。

| 阶段 | 实际动作 | 失败处理 |
| --- | --- | --- |
| `pv` | 核对 Docker `/data` 的可写 bind mount 与 `<data-root><nextDirectory>/<slug>` 一致，节点存在；若 `<data-root>/users/<slug>/work` 存在，还核对旧只读 mount。创建 Retain 静态 local PV/PVC，空 storageClass，预绑定到原节点和原目录。 | 已有卷须与计划一致；冲突时核对 claim、路径、节点，不删数据或重绑别人的卷。部分创建可在修复后重复 pv；等待 PVC Bound 再 switch。 |
| `inventory` | docker diff；--apply 时仅从运行容器把 `/usr/local/bin` 下新增/修改且本人可读的普通可执行文件复制到 `/data/.zp-init.d/bin`，UID 为 runtime.uid。符号链接只报告目标，其他修改仅报告。 | 检查报告、手动转写支持的补丁，再重跑。需要 root 才能还原或涉及身份分流且不能用 PATH 覆盖的补丁按规格停止迁移。不会自动转换所有补丁。 |
| `switch` 预检 | Bound local PVC/PV、精确节点、可选 oldwork 同节点、镜像登记、钥匙、Docker/PV 同数据目录、无旧 k8s Pod。 | 修复预检再试，不能绕过检查；核实 status，镜像登记之外还须确认节点已导入。 |
| `switch` 停 Docker | 先 `restart=no`，再 stop 并复查确已停止。 | 不启动 Pod；修复 Docker 操作后重跑。 |
| `switch` 切换/预热 | 原子 owner→k8s，ensureIsolation、create、清除 paused、start；启动前再次核对归属和 Docker 已停。 | 保持 Docker 停止且 restart=no，修复后重跑 switch，或执行 rollback --apply。不存在独立 prewarm 子命令。 |
| `verify` | 仅一个 Running Pod、预期 local PV 节点；从网关访问 `/api/auth/status`；有配置则 cc-connect 存在；预览钥匙链接正确、非空可读；Docker 不活跃。switch --apply 自动执行它。 | 保持 Docker 停止，修复后重跑 verify --apply，或回滚。verify 无 --apply 仅被动检查并列出待 exec 项，不能称为完整验证。 |

如果检测到 Docker 与 Pod 并存，switch 会先 paused、停新的 Pod、确认副本 0 且无 Pod，再恢复 Docker 归属，并以失败退出要求检查。若清理不成功，不能继续切换。status 报警或疑似两份机器人时先停新实例，确认唯一实例后再报告处理。

回滚仍在该用户维护窗口执行：

```bash
"${adopt[@]}" rollback "$slug" "${common[@]}"
"${adopt[@]}" rollback "$slug" "${common[@]}" --apply
"${adopt[@]}" status "${common[@]}"
```

实际顺序为：设置 paused → stop StatefulSet 并等待该用户所有 Pod 对象消失 → 原子 owner→docker → 删除 `/data` 顶层指向 publishedDirectory 内的符号链接（保留普通文件及其他链接）→ `restart=unless-stopped` → 再确认副本 0/StatefulSet 缺失且无 Pod → 启动原 Docker 容器。paused 保留，后续 switch 才清除；不恢复迁移前的任意 restart policy，固定恢复 unless-stopped。

停 Pod 失败时保持 Docker 停止，修复节点/删除等待后重跑 rollback；归属写入或链接清理失败时也保持 Docker 停止并重跑；最后 Docker 启动失败则修复 Docker，再完整重跑 rollback 以重新核验单实例。进程中断先查 status，确认没有活动接管进程，才可移除陈旧 `.adopt.lock`；不要仅凭锁文件年龄判断。回滚后验证网页、口令、文件、预览、机器人及授权；K7 verify 专用于 Kubernetes，不是 Docker 回滚验证器。

status 是只读盘点，三类报警使退出码为 1：

| 报警 | 含义 |
| --- | --- |
| `k8s-owner-docker-running` | 归 k8s，但同名 Docker 状态为 running/restarting/paused，存在重复实例风险。 |
| `docker-owner-pod-exists` | 归 Docker，但仍有任意该用户 Pod，包括 Pending、已完成或 Terminating；不能仅看是否 Running。 |
| `multiple-pods` | 同一用户有多于一个 Pod 对象，也包括维护 Pod。 |

status 同时列归属、replicas、各 Pod 阶段/terminating、Docker 状态；非法 slug 标 `SKIP invalid-slug`，需人工复核。无这三类报警不代表服务健康，例如 k8s 归属但没有 Pod 仍需 verify/排障。

## K8 端到端探针

S1–S13 覆盖生命周期、exec、文件、口令重置、镜像登记、静态卷、缺策略拒绝、网络矩阵、预览来源、nft 独立兜底和常驻巡检。使用临时测试镜像和临时命名空间，不需要真实模型或身份凭据；这不替代真实业务网关验收。

准备 Node 24、Bash、kubectl、Docker、Python 3；k3d 路径另需 k3d。镜像构建上下文是仓库根：

```bash
docker build -f gateway/Dockerfile -t "$GATEWAY_BASE" .
docker build -f tools/k8s/fixtures/e2e-image/Dockerfile -t "$E2E_IMAGE" .
docker build -f tools/k8s/fixtures/e2e-image/gateway.Dockerfile \
  --build-arg GATEWAY_BASE="$GATEWAY_BASE" -t "$E2E_GATEWAY_IMAGE" .
```

### k3d 两节点

K3S_IMAGE 必填，选与目标集群同一小版本且含 nft 的节点镜像。up 建一个 server、一个 agent，关闭 traefik，导入两个已构建镜像，导出 JSON kubeconfig，不改默认 context，不覆盖已有 kubeconfig。使用新的随机前缀和仓库外目录：

```bash
run_dir=$(mktemp -d)
cluster="wp-e2e-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
export K3S_IMAGE
bash tools/k8s/e2e-k3d.sh up --prefix "$cluster" --image "$E2E_IMAGE" \
  --gateway-image "$E2E_GATEWAY_IMAGE" --kubeconfig "$run_dir/kubeconfig.json"
kubectl --kubeconfig "$run_dir/kubeconfig.json" get nodes -o wide
# 按输出设置 SERVER_NODE、AGENT_NODE，核实节点 hostname 标签及实际隧道接口。
cat > "$run_dir/node-command" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec docker exec -i "$@"
SH
chmod +x "$run_dir/node-command"
for iteration in 1 2; do
  prefix="wp-e2e-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
  bash tools/k8s/e2e.sh --kubeconfig "$run_dir/kubeconfig.json" --prefix "$prefix" \
    --image "$E2E_IMAGE" --gateway-image "$E2E_GATEWAY_IMAGE" \
    --server-node "$SERVER_NODE" --agent-node "$AGENT_NODE" \
    --guard --pod-cidrs "$POD_CIDRS" --tunnel-interface "$TUNNEL_INTERFACE" \
    --external-probe "$EXTERNAL_PROBE" --node-command "$run_dir/node-command" \
    --output "$run_dir/run-$iteration" || break
done
```

逐次确认结果和清理成功；如果失败，先按下文使用原输出目录恢复清理。完成后再单独删除此测试集群：

```bash
bash tools/k8s/e2e-k3d.sh down --prefix "$cluster"
```

POD_CIDRS 从节点 spec.podCIDR(s) 获取；EXTERNAL_PROBE 是部署方控制的可达外网 TCP 端点，如 `probe.example.test:443`（需替换为实际测试配置）。节点名与 Docker 容器名不同则加 `--ssh-node NODE=CONTAINER`。k3d 已导入镜像，此处不用 --distribute；自定义 node-command 接收 `NODE sh -s`，stdin 为脚本。循环失败时保留当前 prefix，恢复清理的 RESULT_DIRECTORY 为 `$run_dir/run-$iteration`；每次 prefix 也记录在对应 state.json 中。

### 真实集群临时命名空间

使用 `--distribute` 时，`E2E_IMAGE` 和 `E2E_GATEWAY_IMAGE` 都须使用规范化完整镜像引用，例如 `docker.io/library/workpartner-e2e:test`、`docker.io/library/workpartner-e2e-gateway:test`；本地构建标签、分发参数和探针参数须保持一致，避免短名称与 containerd 中的引用不匹配。

先取得规格要求的节点测试/首次 nft 加载授权，确认两节点 Ready、可调度、有 nft 和可用 provisioner。导出管理员凭据到仓库外权限受限文件：

```bash
(umask 077; set -o noclobber; kubectl --kubeconfig "$ADMIN_KUBECONFIG" \
  config view --raw --minify --flatten -o json > "$JSON_KUBECONFIG")
prefix="wp-e2e-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
bash tools/k8s/e2e.sh --kubeconfig "$JSON_KUBECONFIG" --prefix "$prefix" \
  --image "$E2E_IMAGE" --gateway-image "$E2E_GATEWAY_IMAGE" \
  --server-node "$SERVER_NODE" --agent-node "$AGENT_NODE" \
  --ssh-node "$SERVER_NODE=$SERVER_SSH" --ssh-node "$AGENT_NODE=$AGENT_SSH" \
  --node-ips "$ALL_NODE_IPV4" --distribute --guard \
  --pod-cidrs "$POD_CIDRS" --tunnel-interface "$TUNNEL_INTERFACE" \
  --external-probe "$EXTERNAL_PROBE" --output "$RESULT_DIRECTORY"
```

--distribute 在测试 namespace/ConfigMap 创建后调用 K6 分发两镜像，不自动 --replace；独立使用 SSH，不受 --node-command 覆盖，目标须能执行 k3s ctr/crictl/df。--guard 在两节点加载 nft 前保存原表，清理时恢复，期间不能有另一操作者修改该表。默认节点命令为 `ssh -o BatchMode=yes`。

完整参数可用 `bash tools/k8s/e2e.sh --help` 查看；向上述命令追加 `--print-config` 可离线校验参数并输出含缺省值的有效配置，不连集群。其他参数：

| 参数 | 行为 / 缺省 |
| --- | --- |
| `--prefix` | 必须为 wp-e2e- 开头的 DNS label，最长 30 字符；每次新运行用新值。 |
| `--node-ips` | 额外节点 IPv4，逗号分隔；还会收集所选两节点的 InternalIP/ExternalIP。 |
| `--static-pv-node` 与 `--static-pv-dir` | 一起提供，节点必须在所选两节点内；dir 为已存在且可写的测试父目录，只创建/删除其下本次 prefix 子目录。未提供时 S8 SKIP。 |
| `--external-probe` | 外网 host:port；未提供会使 S10 外网部分 SKIP，不能声称完整网络验收。 |
| `--guard` | 需同时提供 --pod-cidrs、--tunnel-interface；未启用时 S12 SKIP。 |
| `--api-probe` / `--private-probe` | 覆盖 API Service 和私网拒绝目标；缺省值见 `tools/k8s/e2e/options.mjs`，也可用上述 `--print-config` 查看，须按目标集群配置。 |
| `--sample-port` | 默认 18081；两节点 hostNetwork 探针在 S10/S12 期间监听所有 IPv4 接口，选未占用端口并由外层防火墙阻止外部访问。 |
| `--cluster-domain` | 默认 cluster.local。 |
| `--storage-provisioner` / `--storage-parameters` | 默认 rancher.io/local-path / `{}`；参数为 JSON 字符串映射。 |
| `--policy-timeout-ms` | 默认 60000，等待网络策略/兜底正反对照收敛。 |
| `--image-id` | 未 --distribute 时可显式指定已导入工作区镜像 ID；未提供则实际读取本地 `docker image inspect .Id`，不会查询节点 CRI。若该值是 manifest/index 摘要，应传入已核实的 config SHA256；--distribute 时以 K6 登记为准。 |
| `--output` | 默认 `/tmp/<prefix>-results-<随机UUID>`；必须在所有 Git 仓库/worktree 外，新运行拒绝已有 state.json。目录 0700、文件 0600。 |

验收检查 results.json 的 complete=true、S1–S13 的 PASS/FAIL/SKIP 与证据，不能把 SKIP 当 PASS；静态卷无条件时可按规格记录跳过。cleanup.json 需 PASS 且本前缀 residual 为空，仍须审阅 discoveryWarnings（不可用 API 组未被完整审计）、warnings 和 allPrefixesResidual（其他前缀只报告、不删除）。保存两次连续 k3d 和真实集群的结果；command 日志、guard 计数器、组织配置可能包含节点信息，仅私有归档。

### 中断后清理

正常退出、INT、TERM 会触发清理，SIGKILL/断电不会。**保留 state.json，用原 prefix 和原 --output 恢复**，不能只给 prefix 让脚本分配新输出目录：

```bash
bash tools/k8s/e2e.sh --cleanup --prefix "$prefix" --output "$RESULT_DIRECTORY"
# 若原 kubeconfig 路径已改变：
bash tools/k8s/e2e.sh --cleanup --prefix "$prefix" \
  --kubeconfig "$JSON_KUBECONFIG" --output "$RESULT_DIRECTORY"
```

清理删除带本次 workpartner-e2e 标签的测试命名空间，等 Delete PV 回收后再删 StorageClass 和剩余静态/Retain PV、PriorityClass，最后删除带本次标记的静态子目录；恢复各节点 nft 原表。失败尽量继续并记录，重复 cleanup 可恢复。只有本次 --distribute 记录的镜像才调用 --unpin，不主动删除缓存；unpin 失败记录后下次重试。

没有 state.json 只能按标签清 Kubernetes 对象，无法恢复 nft 快照或推断静态目录，不能宣称完整清理。清理成功前不要 down k3d、丢弃节点适配器或结果目录。残留审计遍历可发现且可 list 的 API 资源，不只是 kubectl get all。

## 常见故障

| 症状 | 排查与恢复 |
| --- | --- |
| StatefulSet 未能创建 Pod | 查看 StatefulSet 事件（如 `kubectl describe statefulset <c> -n <namespace>`）；引用的 PriorityClass 不存在通常导致 Pod 创建被拒，并出现 FailedCreate 事件。创建所需 PriorityClass 或修正配置后重试。 |
| Pod Pending | 看 Pod Events、PVC/PV 和节点事件：StorageClass/provisioner 不存在，WaitForFirstConsumer 等消费者，PVC/PV 路径或 claim 冲突，nodeSelector/静态 PV 节点不符、污点、资源不足、Secret 不存在。确认模型钥匙路径及镜像登记。init 只 chown 根目录，旧数据子目录权限需核实。先修根因，不靠反复重建碰运气。 |
| ErrImageNeverPull（含 init） | Never 不会自动拉取；检查调度节点是否真的导入了相同引用和架构，是否已被 GC，是否仅有 ConfigMap 登记。重新分发到所有目标节点并核验 config ID，勿改成 Always 绕过离线策略。 |
| Required NetworkPolicy is missing | 恢复缺失的三条用户策略后重试；存在性检查不代表隔离生效，运行网络矩阵复验。 |
| 节点失联，Pod 卡 Terminating | stop/remove 超时会列出剩余 Pod。**不要强删 Pod 或强行去 finalizer，也不要启动 Docker 或另一份 Pod**：API 对象被删不代表失联节点上的机器人已停止，可能产生两份连接。恢复节点通信并确认原进程停止，让正常删除完成；无法确认时保持停机、报告处理，不跨节点自动搬 local 数据。 |
| 归属文件缺失/损坏，503「工作区迁移中」 | 已配置 ownersFile 但本进程从未读到有效文件时，禁用请求及运行时写操作，防止错误接管。若已缓存有效归属则继续使用旧值并记录警告，其他新启动进程可能仍 503，不能误以为两边一致。核实实例实际状态，从可信记录恢复 version/default/users，用同目录原子替换，检查父目录挂载和权限，确认两端读取一致再恢复操作。不要删配置或临时把全部人设为本端来消除 503。 |
| 归属有效仍 503 / 502 | 非本端用户没有 peerOrigin 时 503；检查对端内部连通性、归属一致性。重复 delegated 标记是 502，检查是否两端互相认为对方负责。 |
| 模型钥匙已改但进程仍用旧值 | 模型 Secret 通过 subPath 挂载，需正常 restart 重建主 Pod；发布 Secret 的卷更新及短缓存也并非瞬时。 |

排障可先用管理员的 `kubectl describe pod`、`describe pvc`、`get events` 和 K7 status 读取状态。Secret 内容、真实节点地址和完整运行日志留在私有运维记录中。

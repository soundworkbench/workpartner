## 第 1 轮实现补记（第 3 轮补齐）

首轮未留下独立报告；本节按现有交付文件、保留的测试及原任务规格补记实现范围，不追认当时未留存的测试执行结果。第 2、3 轮的变更与验证分别记录在后文。

### 改动与规格对应

依据 `docs/specs/2026-11-11-k8s-runtime.md` 的 K5，以及「范围」第 5 项、「约束」中的安全、资源、镜像、名称与标签和「配置项」：

| 文件 / 实现 | 对应规格与行为 |
| --- | --- |
| `deploy/k8s/namespaces.yaml.tmpl` | K5 命名空间；系统与用户命名空间分离，用户 PSA 为 enforce=baseline、warn=restricted。 |
| `deploy/k8s/rbac.yaml.tmpl` | K5 网关部分及「安全」RBAC；系统 ServiceAccount，通过两个命名空间内的 Role/RoleBinding 提供运行时需要的权限，不授予集群级权限。 |
| `deploy/k8s/gateway.yaml.tmpl` | K5 网关 Deployment 与 PriorityClass；Recreate、单副本、requests=limits、控制面节点选择、TCP 存活探测；仅挂 organization（只读）、secure、state、usersFile；镜像使用 Never 拉取策略。 |
| `deploy/k8s/services.yaml.tmpl`、`gateway-entry.yaml.tmpl` | K5 网关同名 headless Service、用户 governing Service、模型出口 Service；从组织配置推导名称和端口，支持 hostPort 与 clusterIP 两种入口。 |
| `deploy/k8s/network-policies.yaml.tmpl` | K5 网络规则；用户默认全拒，按命名空间和角色放行 DNS、网关、模型出口与公网出站，排除规定私网/保留网段及组织额外 CIDR；用户入站仅放行网关访问 nextPort、3092，模型入站仅放行用户与网关。 |
| `deploy/k8s/storage.yaml.tmpl`、`images.yaml.tmpl` | K5 其他对象；新用户 StorageClass 为 Retain、WaitForFirstConsumer，provisioner/parameters 来自配置；系统命名空间的镜像登记 ConfigMap 初始为 `images.json: "{}"`。 |
| `tools/k8s/render.mjs` | K5 渲染工具；通过仓库组织配置解析器合并缺省与覆盖配置，离线输出 JSON 形式的合法 YAML 多文档或独立文件，支持 `--org`、`--output`、`--only`；必填缺失与非法字段集中报错，不读取钥匙内容、不连接集群。 |
| `tools/k8s-render.test.mjs` | K5 验收；以 `org/default` 加中性测试配置验证对象与 CLI，未修改 Docker 运行时代码或引入依赖。 |

规格「只用的 API 和对象」泛列 core/apps/networking 三类，但 K5 明确要求 RBAC、PriorityClass、StorageClass，因此这些模板使用各自的稳定 v1 API（rbac.authorization.k8s.io、scheduling.k8s.io、storage.k8s.io）。模型地址的后续优先级收紧见第 2 轮第 2 项；网关安全上下文按后续协调者决定处理，见第 3 轮。

### 首轮测试清单

保留的前 17 个顶层测试覆盖以下行为（非法配置另含 22 个子测试）：

1. 中性缺省配置一次列出全部缺失部署字段，不虚构组织配置。
2. 渲染确定性、配置不变性、K5 对象种类与数量、对象身份唯一性及禁止生成的对象。
3. 用户 PSA 标签与系统命名空间隔离。
4. 两套 RBAC 的完整资源、动词、ConfigMap 名称限制及绑定关系。
5. 网关 Recreate/单副本、Guaranteed 资源、调度、优先级、镜像、hostPort 与存活探测。
6. 四个 hostPath、容器内挂载目标、organization 只读及不挂 Docker socket。
7. Service 名称、端口、选择器及相关 NetworkPolicy 随配置变化。
8. clusterIP 入口保留 headless DNS，不暴露 internalPort 或 hostPort。
9. 默认拒绝策略覆盖 job；用户出站 DNS、网关、模型、CIDR 排除与去重。
10. 用户及模型入站来源、角色、命名空间与端口限制。
11. StorageClass Retain/延迟绑定、配置透传与空镜像登记。
12. 模板值安全编码、特殊字符不注入模板、无关身份配置和凭据路径不泄露。
13. 非法名称、地址、端口、标签、CIDR、路径、存储参数与策略名拒绝。
14. 两种入口各自的缺失字段校验。
15. `--only` 种类筛选及未知种类拒绝。
16. CLI 配置合并、stdout/目录输出、仓库外运行及组织目录环境变量。
17. CLI 写出前校验、错误不回显配置内容、参数错误与帮助入口。

上述用例在返工中按新契约调整期望，原有断言覆盖保留；首轮执行日志缺失，本次复跑证据见第 3 轮。

### 沙箱验证边界

离线渲染不能证明集群 API 接受清单、RBAC 实际授权、PSA 生效、控制面调度、资源 QoS、hostPath 属主与读写权限、hostPort 回环和隧道连通、DNS/Service 解析、NetworkPolicy/CNI 隔离、StorageClass 动态供应、镜像导入或网关重启后的行为。沙箱没有集群及实际组织凭据，这些交由 K8 在 k3d 和真实集群临时命名空间验证。此处不把文件解析成功作为上述场景通过的证据。

### 对其他 K 任务的接口假设

- **K1/K2a/K2b**：网关镜像包含集群客户端与 k8s 运行时；使用系统命名空间 ServiceAccount 及已授予的命名空间级权限。K2a 的用户标签、governingService、requiredPolicies、storageClass、imageConfigMap 与清单相同；镜像查询按名字 get。K2b/execNamed 的目标位于系统命名空间。K5 不创建用户 StatefulSet、PVC 或 Secret。
- **K3**：网关镜像包含归属与转发实现；迁移归属文件和持久凭据位于挂载目录，peerOrigin 由组织配置指定。K5 不实现迁移或替其他任务修改运行时代码。
- **K4**：用户镜像包含启动钩子和发布文件链接逻辑，镜像由后续运行时使用；K5 只提供部署基础对象。
- **K6**：负责节点镜像导入及登记 `images.json` 的 `{ref: imageId}`，负责节点 nft 兜底；组织提供完整的节点公网 /32 排除列表。NetworkPolicy 清单不替代节点兜底。
- **K7**：管理员凭据创建存量数据静态 PV/PVC；K5 的 StorageClass 仅供新用户，既有数据不搬迁。
- **K8/K9**：K8 提供集群实测与集群级对象清理；K9 汇总部署文档及配置类型。模型出口 Pod 的镜像、参数、凭据由组织私有部署提供，必须带配置选择器要求的 model-egress 标签；K5 仅渲染其 Service 与网络规则。网关镜像预先导入选定节点，宿主四个挂载源须已存在。

## 第 2 轮返工（2026-11-10）

在现有 `T-1093-k8s-manifests` worktree 上完成，未切换分支。实际修改 `tools/k8s/render.mjs`、`deploy/k8s/gateway.yaml.tmpl`、`tools/k8s-render.test.mjs` 和 `docs/organization.md` 的资源字段说明；按本轮验收要求写入本报告。开始时指定位置没有 report.md，因此本轮创建该文件。未改 check.sh、package 文件、rollout.py，未新增依赖。

### 逐项修改与测试

1. **模型出口选择器**：保留标签格式检查，新增必须包含 `workpartner/role: model-egress` 的检查，并拒绝网关标签的子集，避免模型 Service 和模型入站策略误选网关。模板继续共用经过校验的选择器。新增测试覆盖网关标签的两个单元素子集、完整网关标签、空选择器、缺少角色、自定义标签、错误角色，以及仅含正确角色的合法选择器；同时核对 Service 和 NetworkPolicy 的最终选择器。
2. **模型地址**：Service 名称、端口以及模型相关 NetworkPolicy 端口统一取 `model.baseUrl`。非空 `nextBaseUrl` 必须与其主机名、有效端口一致，否则错误同时指出两个字段。HTTP/HTTPS 缺省端口分别按 80/443 比较；路径可以不同。新增测试覆盖主机名不一致、显式端口不一致、协议导致缺省端口不一致、显式与缺省端口相等，以及只配 nextBaseUrl 仍缺少必填 baseUrl。原 Service 测试更新为两者端点一致，并保留完整 Service、端口和策略断言。此处按本轮明确要求收紧规格中“nextBaseUrl 或 baseUrl”的表述，与当前 runtime/index.mjs 向用户容器传递 baseUrl 的行为对齐。
3. **输出文件名**：改为 `kind_namespace_name.yaml`；集群级对象为 `kind_name.yaml`。下划线不会出现在这里允许的 Kubernetes 对象名称中。导出的目录写入函数 `writeManifests` 在创建目录和写入任何文件前检查全部文件名，重名直接失败。新增 CLI 测试构造旧连字符命名会碰撞的两组 namespace/name，确认分别保存且对象内容正确；另以重复对象验证报错前既不新建目标目录，也不写入已有空目录。
4. **非空输出目录**：`--output` 仅接受新目录或已有空目录。已有非空目录提示换空目录，不清理文件；实际写入采用 `wx`，不覆盖已有文件。帮助文本同步说明。原重复输出用例改为验证失败并保留所有文件内容，未删除原有内容断言；新增测试覆盖旧 YAML、隐藏文件、子目录、`--only` 输出也拒绝非空目录，以及已有空目录可以写入。
5. **持久文件路径**：`runtime.sessionKeyFile`、`runtime.cookieFile`、`identity.appSecretFile` 必须是 secureDirectory 或 stateDirectory 的严格子路径；配置非 null 的 runtime.migration 时也要求 ownersFile。使用规范化相对路径判断，拒绝同名目录本身、相似前缀目录和 `..` 越界。缺失项与非法项在同一次错误中列出。新增测试逐一覆盖四个文件字段的绝对路径、相对路径、缺失、空值、目录本身、前缀伪装、父级越界，以及两个挂载目录中的合法嵌套路径；CLI 测试确认缺失部署项与所有非法文件路径一起报告、输出目录不创建。原挂载测试同步配置文件的容器路径，仍保留四个卷及挂载点的完整断言。
6. **hostPort 提示**：有效配置中，入口 hostIP/hostPort 拼成的地址与 runtime.localAddress 不同时，仅向 stderr 提示隧道仍指向 runtime.localAddress，退出码保持成功。新增 CLI 测试分别覆盖 IP 不一致、端口不一致、完全一致和 clusterIP 模式；前两者仍输出可解析的完整清单，后两者不产生该提示。
7. **网关安全上下文**：容器增加 `allowPrivilegeEscalation: false`、`seccompProfile.type: RuntimeDefault`、`capabilities.drop: [ALL]`。不设置 runAsUser、Pod securityContext 或初始化容器，继续使用镜像用户，不改 hostPath 属主。新增测试核对完整 securityContext，并确认没有用户或卷属主覆盖；原挂载配置断言继续保留。
8. **网关资源**：新增可选 `runtime.k8s.gatewayResources.cpu`、`.memory`，各字段独立缺省为 `500m`、`512Mi`，requests 和 limits 始终相等。配置值采用正数 Kubernetes quantity 字符串，非法结构、空值、负值、零和无效单位报错。帮助及 docs/organization.md 字段表同步说明。新增测试覆盖不配置、空对象、只配 CPU、只配内存、同时配置，以及非法输入；原缺省资源断言仍保留。

原有 17 个顶层测试全部保留，并按本轮新行为更新期望；新增 10 个顶层测试。包含已有子测试共 49 项，未减少原断言覆盖。

### 联调和运维说明（本轮第 9 条）

- **clusterIP 入口**：此模式额外生成系统命名空间内的 `<gateway>-entry` Service，固定 clusterIP，只发布 gatewayPort。原 `<gateway>` headless Service 仍同时提供 gatewayPort/internalPort，用于网关名称解析及预览来源校验。hostPort 模式没有这个额外 Service。
- **K2a 镜像查询**：系统命名空间 Role 对 configmaps 只授予 `get`，且 resourceNames 限定为 `runtime.k8s.imageConfigMap`（缺省 `workpartner-images`）。K2a 必须按名字单对象 get，不能先 list ConfigMap，也不能修改登记内容；镜像登记由管理员分发工具负责。
- **K8 清理**：网关 PriorityClass 名称为 `<systemNamespace>-gateway`，是集群级对象，无 metadata.namespace。只删除测试命名空间不会删除该 PriorityClass，K8 必须把它列入集群级清理清单。StorageClass 也仍是集群级对象，遵循相应数据保留/清理策略。
- **环境变量覆盖**：本 K5 渲染器从组织配置读取部署参数，渲染出的网关只注入 `WORKPARTNER_ORG_DIR=/organization`，不会继承渲染进程或旧 Docker 网关的环境变量覆盖。通过此清单部署 k8s 网关时，这些覆盖不可用，模型地址、端口、路径等必须写入挂载的 organization.json，避免实际运行参数与 Service/NetworkPolicy 不一致。`--org` 和用于选择组织目录的 `WORKPARTNER_ORG_DIR` 仍有效。
- **重新 apply**：初次生成的镜像登记 ConfigMap 中 `images.json` 是空对象。后续重新 apply 部署对象必须用 `--only` 白名单排除 ConfigMap，保留线上已登记镜像。例如渲染到一个新的空目录：

  ```sh
  node tools/k8s/render.mjs --org /srv/workpartner/organization \
    --output /tmp/workpartner-reapply \
    --only Namespace,ServiceAccount,Role,RoleBinding,PriorityClass,Deployment,Service,NetworkPolicy,StorageClass
  ```

  不要重新 apply 初始完整清单里的空镜像 ConfigMap；也不要在此前包含它的非空目录中生成局部清单。

### 验证结果与限制

- `node --test tools/k8s-render.test.mjs`：退出码 0。
- `node tools/k8s-render.test.mjs`：49 tests，49 pass，0 fail，0 skipped。额外直接运行以取得逐项计数；当前环境的 `--test` 输出按文件汇总。
- `git diff --check`：通过；另对本轮实际修改的未跟踪文件做空白检查。相较本轮开始时保存的副本，所有修改均在授权范围内。
- `bash tools/check.sh`：前置语法检查完成，但在已有 `tools/wp-seed.test.py` 创建本地 HTTPServer 时遇到 `PermissionError: [Errno 1] Operation not permitted`，脚本退出 1；后续全仓测试未执行。没有修改测试或 check.sh 绕过该限制。
- 当前沙箱 Node 为 v22.22.1，未发现可用 Node 24；仍需在任务要求的 Node 24 环境重跑完整检查。
- 无集群，未验证实际 hostPort 回环入口、隧道连通、NetworkPolicy 效果、seccomp 启动和 hostPath 权限。路径校验是离线配置的词法检查，不读取凭据文件，也不能核实宿主符号链接及文件属主。镜像仍需包含 K1/K2/K3 实现并事先导入目标节点，模型出口 Pod 由组织部署并带 model-egress 角色；K8 负责集群实测。
- 开源卫生检查：新增域名示例仅使用 example.com 及其子域，外部 IP 示例使用 192.0.2.0/24 文档地址；回环、私网和保留网段仅用于入口校验、网络策略及其断言。没有新增真实组织、节点或凭据值。

## 第 3 轮返工（2026-11-10）

复用 `T-1093-k8s-manifests` worktree，未切换分支。本轮只修改 `deploy/k8s/gateway.yaml.tmpl`、`tools/k8s/render.mjs`、`tools/k8s-render.test.mjs` 和本报告；保留开始时已有的其他文件改动。未改 check.sh、package 文件、rollout.py，未新增依赖。

### 逐项修改

1. **网关能力修正**：保留 `allowPrivilegeEscalation: false`、`seccompProfile.type: RuntimeDefault`、`capabilities.drop: [ALL]`，显式增加且仅增加 `CHOWN`、`DAC_OVERRIDE`、`FOWNER`。完整 securityContext 断言同步更新，继续断言不设置 runAsUser、Pod securityContext 或 initContainers。
   - 网关镜像 `gateway/Dockerfile` 使用 Node 基础镜像且未声明 USER，按现有契约以 root 运行；它仍要操作 hostPath 中不同属主的文件。root 在 drop ALL 后也不能绕过这些权限检查。本次采用协调者明确决定，不把用户工作区主容器的非 root 约束套到网关。
   - `CHOWN`：`gateway/onboard.mjs:60` 和 `:71` 在钥匙池分配及新建钥匙后调用 chown，将钥匙交给 `runtime.uid`（默认 1001），需要该能力。
   - `DAC_OVERRIDE`：K2a 的 create 要读取上述属主 1001、权限 0400 的钥匙，再写入 Kubernetes Secret；网关 root 不是文件属主，读取需要绕过普通读权限。此能力也支持访问持久目录中受 DAC 限制的内容。K2a 尚待合并，这一项按其接口契约说明，未声称已经在本分支跑过完整 create。
   - `FOWNER`：用于需要文件属主身份的操作，例如 `gateway/feishu.mjs:19` 对已有 OAuth 状态目录执行 `chmodSync(stateDir, 0o700)`；当挂载目录中的该子目录由其他 UID 持有时，root 需要 FOWNER 才能修改其权限。DAC_OVERRIDE 不能替代这项属主检查；若该目录本来属于 root，此次 chmod 本身不需要 FOWNER。
2. **警告改由调用方输出**：`renderManifests` 返回 `{ objects, warnings }`，warnings 为消息字符串数组，无警告时为 `[]`。内部配置处理仅收集消息；渲染函数不写 stdout/stderr。CLI 为每条消息添加 `Warning: ` 前缀与换行并写到 stderr，stdout/目录继续只含对象。仓库内调用点全部适配，`writeManifests` 仍接收 objects 数组。原 CLI 的入口不一致提示、成功退出与输出可解析的断言保留。
3. **部分写入说明**：`--help` 明确说明目录写出不是原子操作；写到一半失败会留下部分文件，此时应换一个新的空目录重跑。此前的非空目录拒绝、文件排他创建及不自动清理行为保持不变。不要直接 apply 失败目录中的部分清单，也不要在该目录上重跑来补齐文件。
4. **报告补齐**：在第 2 轮记录之前补入首轮实现、规格对应、17 个顶层测试清单、沙箱验证边界和 K1–K9 接口假设。首轮历史执行结果没有留档，已明确区分补记和本轮实际验证。

### 测试与验证

- 测试先更新契约后运行：新增的库调用用例捕获到旧实现仍写 stderr，按预期失败；改完返回接口后仅安全上下文用例失败，差异恰为缺少三项 add 能力；补齐模板后全部通过。
- 原 27 个顶层测试及其断言覆盖全部保留，仅将对象数组读取适配为 `.objects`，并按本轮要求修改 securityContext 期望。新增 1 个顶层测试验证库调用 stdout/stderr 均无输出、返回入口不一致警告、`--only` 下警告仍可用、相同输入返回一致、后续匹配入口及 clusterIP 调用返回空 warnings，避免跨调用残留。
- `node --test tools/k8s-render.test.mjs`：退出码 0。当前环境按测试文件汇总为 1 pass、0 fail。
- `node tools/k8s-render.test.mjs`：28 个顶层测试，含子测试共 50 tests、50 pass、0 fail、0 skipped。
- `env -u WORKPARTNER_TEST_IMAGE bash tools/check.sh`：退出码 1。前置语法检查完成；`tools/wp-seed.test.py` 的 `ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 创建本地 HTTPServer 时，沙箱禁止创建 socket，报 `PermissionError: [Errno 1] Operation not permitted`。脚本在此停止，后续全仓测试未执行；未修改检查脚本或弱化测试绕过限制。
- `node --check tools/k8s/render.mjs`、`git diff --check` 及四个实际修改文件的空白检查通过（后者包含未跟踪文件）。与本轮开始时副本对比，原 27 个顶层测试名称均保留，assert 调用由 168 增至 179；逐项差异仅为返回结构适配、新增警告用例及获准的 securityContext 更新。
- 本轮环境为 Node v22.22.1；仍需在 Node 24 与集群环境重跑完整验证。未实测三项 capabilities 在真实网关镜像中的 chown、钥匙读取和 chmod；K8 应覆盖开通、新用户 create、已有状态目录启动及前述集群网络/存储场景。
- 本轮新增地址仅使用回环地址与文档保留地址，未新增真实组织、域名、主机名或凭据值。

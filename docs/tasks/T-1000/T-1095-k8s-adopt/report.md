# T-1095 K7 实现报告

## 交付范围

新增 `tools/k8s/adopt-user.mjs`、`tools/k8s/adopt-state.mjs`、`tools/k8s-adopt.test.mjs`。除本报告外没有改动其他文件；原有 brief 保留。没有新增依赖，没有改 check.sh、package 文件、rollout.py，也没有修改其他 worktree。

实现依据：`docs/specs/2026-11-11-k8s-runtime.md` 的 K7 全部子命令及验收项，关联「名称与标签」「配置项」「单实例」、K1、K2a、K3、K4 的固定接口。

| K7 条目 | 实现 |
| --- | --- |
| `pv` | 校验节点、现有数据目录及 Docker 实际挂载；创建静态 local PV，再创建 `<c>-data` PVC。PV 使用 Retain、claimRef、固定节点亲和；旧工作目录存在时创建 `<c>-oldwork`，ReadOnlyMany，并核对原 Docker 只读挂载。先核对全部已有对象，冲突即停止，不覆盖别人的绑定；重复执行保留匹配对象。 |
| `inventory` | 输出 docker diff 的逐项 JSON 报告。apply 时检查 `/usr/local/bin` 直属新增/修改文件；符号链接单列目标供人工判断，不复制。普通文件可读、可执行时以 runtime.uid 执行 install，复制到 `/data/.zp-init.d/bin/`，属主为该用户、模式 0755。其他改动只列入报告；停止的容器或不可读文件标为待检查，不自行启动容器。 |
| `switch` | 严格依次检查 Bound PVC、镜像登记和本人模型钥匙文件可读；Docker restart=no；Docker stop 并复核；原子写 owner=k8s；ensureIsolation；create；start；verify。数据 PV 与 Docker 必须指向同一目录。已经完成迁移的用户只复验。发现两端并存时停止新 Pod，确认 StatefulSet 不存在或 replicas=0 且没有任何 Pod 后原子写回 owner=docker，再次确认 k8s 已停止，保留 Docker 并报告。复查失败则报警并提示 rollback；正常收尾及 dry-run 的失败阶段为 duplicate instances detected。start 前重读归属且确认 Docker 不活跃。 |
| `rollback` | 给现有 StatefulSet 加 paused 注解以阻止 K3 后续常驻拉起；调用 stop，复核所有用户 Pod 对象已消失；原子写 owner=docker；扫描并删除指向发布目录的根目录符号链接；设置 restart=unless-stopped；再次确认 StatefulSet 不存在或 replicas=0，且没有任何 Pod 后启动 Docker。普通文件、用户其他链接保留。 |
| `verify` | 检查唯一工作区 Pod Running、预期节点；通过单独指定 systemContainer=gateway 的运行时从网关 Pod 请求 `/api/auth/status` 并要求 HTTP 200；存在 `.cc-connect/config.toml` 时要求 cc-connect 进程；预览密钥必须是指向发布目录的有效、非空可读链接；确认同名 Docker 不在运行。 |
| `status` | 合并用户清单、归属记录、StatefulSet、Pod、Docker 清单；显示归属、Pod 阶段/终止状态、副本数、Docker 状态。覆盖 k8s owner + Docker 运行、docker owner + Pod 存在、同人多个 Pod 三类报警；任一报警返回 1。状态查询始终只读，包括 --apply。处理 Kubernetes 分页、孤立 Pod 和旧版容器前缀。不合规代号单列为 SKIP/invalid-slug 和 report.skipped，继续检查其他用户；不纳入三类报警，也不单独导致非零退出码。 |

默认 dry-run：不创建锁或临时文件，不改归属，不调用 Docker 写命令或 exec，不调用 Kubernetes 写接口、runtime exec/processes 或生命周期写方法。`verify` 的 dry-run 做被动查询并明确列出未执行的检查，`verified=false`；`verify --apply` 才在网关和工作区中执行只读探测。inventory 的 dry-run 不执行可执行位检查，报告计划检查并复制的候选项。

归属更新使用同目录唯一临时文件、保留原文件 uid/gid/权限、文件 fsync、rename 原子替换、父目录 fsync，保留 default 和其他用户记录。修改类命令以 ownersFile 旁的 `.adopt.lock` 排斥其他工具进程。文件缺失、格式错误、锁已占用均拒绝写入。失败日志包含失败阶段和 `NEXT:` 恢复步骤，不输出上游异常正文、Secret 内容或命令输出。不会自动启动另一端补偿失败。

## 使用约定

```sh
node tools/k8s/adopt-user.mjs --help
node tools/k8s/adopt-user.mjs pv user1 --node node-a --data-root /srv/workspace-data
node tools/k8s/adopt-user.mjs inventory user1
node tools/k8s/adopt-user.mjs switch user1 --host-secure /srv/workspace-keys --owners-file /srv/workspace-state/owners.json --apply
node tools/k8s/adopt-user.mjs verify user1 --apply
node tools/k8s/adopt-user.mjs status
node tools/k8s/adopt-user.mjs rollback user1 --apply
```

以上路径、代号及节点名均为示例。`--data-root` 定义为 Docker 宿主数据根目录，数据路径为 `<root><runtime.nextDirectory>/<slug>`，旧工作路径为 `<root>/users/<slug>/work`。工具会核对 Docker inspect 中的真实 bind mount，以免把空目录或其他目录接管成用户数据。

默认通过仓库的 resolveOrganization 读取组织配置，可使用 WORKPARTNER_ORG_DIR。`--organization` 可直接读取完整、已经补齐默认项的组织 JSON；`--users` 可覆盖用户清单文件；`--kubeconfig` 接受 flattened JSON kubeconfig，否则使用 ServiceAccount。`--host-secure` 指定宿主钥匙目录，按 `--host-secure` → `runtime.hostSecure` → `runtime.secureDirectory` 顺序取值，空字符串按未配置跳过。最终目录必须是绝对路径；配置阶段在创建锁、装配运行时和任何写操作前拒绝相对路径、空值或缺失值。仅在工具本次运行时映射到 secureDirectory，不改组织配置。switch 的 apply 和 dry-run 均以只读方式打开 `<目录>/<keyPrefix><slug>.key`，确认是可读普通文件后才继续；keyPrefix 取 `model.keyPrefix`，缺省为 `model-`。缺失、不可读或目录冒充钥匙文件时，在修改 Docker restart、停止 Docker、改归属、建对象前失败，日志不输出钥匙内容。`--owners-file` 指定宿主归属文件，默认取 runtime.migration.ownersFile；读取、锁、原子更新和启动前复读均使用这个宿主路径。`--host-secure` 的非空值及 `--owners-file` 必须为绝对路径；所有后续子命令都应使用相同的归属文件路径。没有新增组织配置键。

工具应在原 Docker 宿主上运行，能够访问 Docker、归属文件目录、原数据目录和管理员 Kubernetes API。两套网关需要读取同一份可见原子替换的归属文件；不要用只固定单个文件 inode 的挂载隔离更新。迁移窗口需要暂缓该用户的请求并排空已开始的生命周期任务；本地工具锁不能锁住网关里已开始的任务。暂停注解只能阻止 K3 后续常驻保障，不能取消已经发出的启动请求。进程被强制终止留下锁时，先核对 status 和执行中的工具，再人工处理锁。

## 第 1 轮测试证据（历史记录）

环境：Node v22.22.1；完全离线，假 Docker 执行器、假 K1 客户端、通过 createRuntime 注入的假 K2a 运行时、真实临时归属文件和符号链接。

- `node --test tools/k8s-adopt.test.mjs`：退出码 0。此沙箱的测试父进程输出聚合为一个通过的测试文件。
- `node tools/k8s-adopt.test.mjs`：62 tests，62 pass，0 fail，0 skipped。直接运行保留各用例的 TAP 明细；执行记录在 `/tmp/T-1095-adopt-test.log`。
- `node --check tools/k8s/adopt-user.mjs`、CLI `--help`：通过。
- `git diff --check`：通过。
- `bash tools/check.sh`：退出码 1；前面的 JavaScript、Python 和 shell 语法检查通过，随后原有 `tools/wp-seed.test.py` 创建本地 HTTPServer 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`。没有修改或跳过该测试；本次总检查未到达后面的测试阶段。记录在 `/tmp/T-1095-check.log`。

用例与 K7 验收对应：

| 验收要求 | 用例覆盖 |
| --- | --- |
| 各子命令步骤顺序 | switch 的 PVC/镜像 → restart=no → stop → 原子归属 → isolation/create/start → verify；rollback 的 pause/stop/Pod 消失 → 归属 → 链接清理 → restart/start；pv 的 PV → PVC；inventory 的 diff → 可执行检查 → copy；verify 各项检查顺序；status 输出和报警。 |
| 失败安全与恢复日志 | switch 在镜像查询、restart 设置、停止、isolation、create、start、各验证步骤失败；远端 start 已成功但响应失败；rollback 在 pause、stop、原子归属、链接清理、restart/start 失败；未删除的 terminating/job Pod 阻止启动 Docker；pv 部分创建失败后可继续；inventory copy 失败即停止。断言状态快照不出现两端同时运行，日志有 NEXT，错误不泄漏测试 Secret。 |
| dry-run 无写操作 | 六个子命令逐一断言没有文件变更、锁、临时文件、Docker exec/write、runtime lifecycle/exec/processes、Kubernetes create/patch；已有发布链接保持。 |
| status 三类报警 | 三类报警各自独立用例，断言报警内容和返回码；通过 main 检查 CLI 返回码；健康状态为 0。 |
| 补充边界 | PV/PVC 已存在冲突、重复执行、旧工作只读卷、PVC 未绑定、镜像缺登记、数据目录不匹配、尚有副本；原子 rename inode 改变且权限和其他用户记录保留；锁冲突、归属缺失/损坏；回滚后再切换清除 pause；关闭期间新建的发布链接也被清理；未配置桥时跳过进程要求；错误节点/网关不可达/桥缺失/无效链接/Docker 并存；列表分页、孤立和终止中 Pod、旧版用户固定归 Docker、原型同名代号的默认归属。 |

## 与当前 main 接口的核对

- **K1**：使用固定 get/create/patch 接口，404 get 返回 null，409 create 的 reason 为 AlreadyExists；列表返回标准 items/metadata.continue。工具管理员凭据需要读取 Node/PV，并创建 PV/PVC、patch StatefulSet 注解和执行网关 Pod 命令。
- **K2a**：只通过 createRuntime(organization, overrides) 装配，传入 kind=k8s、client、inspectCacheMs=0；不导入或复制 k8s.mjs 实现。使用 create(user, {modelConfig})、ensureIsolation(slug)、imageId(ref)、inspect、start、stop、exec、execNamed、processes。inspect 提供规格字段及允许新增的 replicas/annotations；stop 返回时所有用户 Pod 已删除，工具仍独立复核。系统命名空间取 runtime.k8s.systemNamespace 或 client.namespace。
- **K3**：只读写固定 version/default/users 格式，已核对当前 gateway/migration.mjs 与 gateway/aionui.mjs，不调用其非公开实现。工具要求文件预先存在，防止缺失归属使两端都自认为负责。非 aionui 用户固定归 Docker，禁止迁移。常驻保障尊重 workpartner/paused 注解，但 resolveUpstream 请求路径不会因此停止启动用户实例，所以重复实例收尾必须写回 Docker 归属。
- **K5**：按规格直接组装名称和标签，不导入 render.mjs。PVC 为 `<c>-data` / `<c>-oldwork`；集群级 PV 名使用 `<namespace>-<PVC name>` 避免不同命名空间冲突。PV 节点亲和使用 matchFields metadata.name，verify 从此字段读取预期节点；已存在的外部卷必须符合这一工具生成格式。网关 Pod 通过 workpartner/role=gateway 标签发现；已核对 deploy/k8s/gateway.yaml.tmpl 中容器名固定为 gateway。
- **K4 与镜像**：已有启动钩子把 `.zp-init.d/bin` 加入 PATH，并创建发布链接；旧工作卷由 K2a 按规格只读挂载。镜像包含 sh、test、readlink、mkdir、install 和 node，Docker exec 使用配置中的非 root uid。复制补丁不能证明其业务行为完全等价，身份分流或不能非 root 恢复的剩余改动需按规格停止条件人工复核。

本 worktree 已同步当前 main，K2a/K3/K5/K6 已合入。已只读核对本分支 gateway/runtime/index.mjs、k8s.mjs、k8s-exec.mjs、docker.mjs、gateway/aionui.mjs 及 deploy/k8s 模板。runtime/index.mjs 已支持 kind=k8s；新增 verify 装配用例使用真实 createRuntime/K2a/K2b，仅替换 K1 客户端（Docker 仍为假命令执行器）。其余生命周期故障注入用例继续使用假运行时。未修改 gateway 或 deploy。

## 沙箱未验证项

没有联网、没有 Docker 和集群，未验证真实 local PV 绑定/节点调度、管理员 RBAC、跨进程网关任务竞态、Secret 投影、网关到 AionUi 的网络路径、实际镜像补丁执行与属主、cc-connect 在线状态以及完整 Docker → k8s → Docker 演练。部署端需在 Node 24 和当前 main 的 K2a/K3/K5 上执行真实集成验证；仓库总检查也需要允许本地监听的环境重新运行。

新增代码、测试和报告只使用通用标识、示例路径、合成节点名和 RFC 5737 地址；没有使用真实组织配置。协调者仓库外的私有词表检查不在本沙箱执行。


## 第 2 轮返工（2026-11-10，历史记录）

仅修改工具主模块、状态辅助模块、测试文件和本报告。没有新增依赖，没有改 gateway/、deploy/、check.sh 或 package 文件；没有联网、连接真实 Docker/集群或 git 提交。新增回归先确认原实现失败，再验证修复；保留原步骤顺序、dry-run 和失败恢复测试。另做了一次独立只读代码复核，未发现阻塞问题。

### 必改项及对应用例

| 审核项 | 修正及对应用例名 |
| --- | --- |
| 1. verify 网关容器名 | 网关探测单独装配带 `runtime.k8s.systemContainer: 'gateway'` 的运行时，不修改全局配置。假 execNamed 断言目标容器；真实装配穿过 createRuntime、K2a 和 K2b，只替换 K1，核对网关使用 gateway、工作区使用 workspace，并确认原 systemContainer 保留。用例：`verify uses real createRuntime and K2b with gateway container and workspace container through fake K1`。 |
| 2. PV 重跑误判 | 匹配时接受 API 省略的空字符串/空集合，对对象按请求字段递归比较，数组检查长度和各项请求字段；忽略 API 补充的 apiVersion/kind、claimRef.uid/kind 等额外字段。假 GET 省略空 storageClassName，补充类型、claimRef 绑定元数据和空 matchExpressions。用例：`pv retains matching PV/PVC on rerun after API omits empty storageClassName and adds binding metadata`；`pv partial failure rerun retains API-normalized PV and creates only the missing PVC`。另外 `pv normalization still rejects conflicting storageClassName without writes`、`pv normalization still rejects conflicting local path without writes`、`pv normalization still rejects conflicting claimRef without writes`、`pv normalization still rejects conflicting node affinity without writes` 确认真实冲突仍拒绝。 |
| 3. 重复实例收尾归属 | 按保留 Docker 处理：pause → stop → inspect 确认 StatefulSet 不存在或 replicas=0 → 全量确认无 Pod → 原子 owner=docker。完成后仍返回非零提示发现过重复，但 NEXT 明确 Docker 保留且 owner=docker；停止未确认时不写归属。用例：`duplicate found during switch confirms zero replicas and no Pods then restores Docker ownership`（还断言随后 status 正常）；`duplicate cleanup refuses ownership change when replicas reappears after stop`；`duplicate cleanup refuses ownership change when pod reappears after stop`。 |
| 4. 启动前再核对 | rollback 停止后及 docker start 前均要求 StatefulSet 不存在或 replicas 严格等于 0，并且无任何 Pod；switch 在 runtime.start 前重新读归属文件要求 k8s，再确认 Docker 不活跃。用例：`rollback refuses Docker start when StatefulSet replicas becomes 1 during docker update`；`rollback refuses Docker start when StatefulSet replicas becomes null during docker update`；`rollback refuses Docker start when a Pod reappears during docker update despite zero replicas`；`switch refuses runtime start when owner changes during create`；`switch refuses runtime start when docker changes during create`。 |

### 建议项及对应用例

| 审核项 | 修正及对应用例名 |
| --- | --- |
| 1. 宿主路径 | 增加 `--host-secure`、`--owners-file`，usage 解释宿主与网关路径映射；钥匙路径按 --host-secure、runtime.hostSecure、runtime.secureDirectory 顺序回退（空字符串处理与最终绝对路径校验见第 3 轮），归属文件统一用于读写和锁；不改变输入组织对象。用例：`host path options map secure directory and ownership file without changing organization config`；`host secure directory defaults to runtime.hostSecure for runtime create`。 |
| 2. 不合规代号的 status | status 允许读取不合规代号，输出 SKIP 和 invalid-slug 报警，并在 report.skipped 列出；跳过相应运行时操作，继续报告合法用户的重复实例。该轮不完整清单返回 1（第 3 轮已改为仅 SKIP、不报警、不单独导致非零退出码）；inventory 等写操作仍拒绝不合规用户清单或归属键。用例：`status skips and reports invalid legacy slugs while still detecting valid-user duplicate alarms`。 |
| 3. 失败阶段 | 获锁后、进入命令 action 前设置 stage=命令名；真实锁失败仍标 acquire operation lock。用例：`pv pre-step failure reports command stage instead of lock acquisition`；`inventory pre-step failure reports command stage instead of lock acquisition`（各自覆盖 apply 和 dry-run）。 |
| 4. bin 符号链接 | 先 test -L，readlink 输出原始目标；以 symlink-review 和 linkTarget 单列，交人工按停止条件 8 判断，不复制。复制普通文件前再次拒绝符号链接。用例：`inventory reports executable symlink target without copying it (real shell probe)`；`inventory reports broken symlink target without copying it (real shell probe)`，使用临时目录真实链接与本地 shell 执行探测，不调用 Docker。dry-run 保持不 exec，因此只列计划检查项，目标需 apply 后获取。 |
| 5. 归属目录 fsync | 临时文件 fsync、关闭、rename 后打开父目录 fsync，再关闭；目录同步错误传出并停止生命周期流程。用例：`atomic ownership rename syncs parent directory before reporting success`；`directory fsync failure stops switch after ownership rename and before runtime create or start`。 |
| 6. 模型环境一致性（报告项） | 工具的 resolveOrganization/nextModelConfig 使用工具进程环境。执行工具时必须与目标网关使用相同组织配置及相关环境覆盖，尤其 MODEL_BASE_URL、自定义 model.baseEnvironment 对应变量和模型配置；`--organization` 应提供与网关一致的已解析配置。否则工具 create 写入的模型地址可能不同，网关 stale 判断不会自动纠正这一项。verify 当前检查 AionUi 可达性等，不比对模型地址；部署前需人工核对，避免在公开日志输出钥匙或其他秘密。此条按要求仅报告，无新增测试。 |

### 第 2 轮验证结果

环境 Node v22.22.1，测试完全离线。修复后的最终结果：

- `node --test tools/k8s-adopt.test.mjs`：退出码 0；此沙箱父进程将结果汇总成一个通过的测试文件。
- `node tools/k8s-adopt.test.mjs`：83 tests、83 pass、0 fail、0 skipped；日志 `/tmp/T-1095-round2-adopt-test.log`。
- `bash tools/check.sh`：退出码 1。前面的 JavaScript、Python、shell 语法检查通过；在原有 `tools/wp-seed.test.py` 的 `test_model_permissions_are_read_with_an_identified_client` 创建本地 HTTPServer 时，沙箱拒绝 socket，报 `PermissionError: [Errno 1] Operation not permitted`。总检查未进入后续测试阶段，未修改或跳过该测试。日志 `/tmp/T-1095-round2-check.log`；请协调者在允许本地监听的环境完整重跑。

启动前读取能拦截用例模拟的并发修改，但 Kubernetes、Docker 与归属文件之间没有分布式事务；这些检查不能取代迁移窗口暂停用户请求、排空已发出的生命周期操作。真实集群、Docker、网络可达性和掉电持久性仍需部署端演练。

## 第 3 轮返工（2026-11-10）

本轮仅修改 `tools/k8s/adopt-user.mjs`、`tools/k8s/adopt-state.mjs`、`tools/k8s-adopt.test.mjs` 和本报告。没有新增依赖，没有修改 gateway/、deploy/、check.sh、package 文件，没有联网、连接真实集群或 Docker，也没有 git 提交。

### 必改：钥匙目录回退与 switch 前置检查

| 修改 | 对应用例 |
| --- | --- |
| 按 `--host-secure` → `runtime.hostSecure` → `runtime.secureDirectory` 回退，空字符串均按未配置处理；保留非空显式参数优先级，不修改输入组织配置。usage 和本报告使用约定已同步。 | `empty hostSecure falls back to secureDirectory for switch and runtime create` 覆盖无显式参数及显式空参数；保留 `host secure directory defaults to runtime.hostSecure for runtime create`、`host path options map secure directory and ownership file without changing organization config`。 |
| 配置阶段校验最终目录必须为绝对路径，在读取归属、装配运行时、创建锁或任何业务写操作之前拒绝。非空相对 hostSecure 不会静默退回其他目录。 | 六个子命令各有 `<command> rejects nonabsolute final key directory before any write or runtime construction`，覆盖相对 secureDirectory、相对 hostSecure、最终空值和缺失值；断言没有运行时装配、Docker/API 调用或写操作，归属内容/inode 不变，且不尝试创建锁。 |
| switch 前置检查只读打开本人钥匙并检查为普通文件，随后关闭，不读取或记录内容。文件路径与 K2a 一致，使用 `model.keyPrefix ?? 'model-'`。缺失、不可读及目录都在 Docker restart/stop 和归属更新前失败；apply 与 dry-run 均执行此只读检查。 | `switch rejects missing model key before stopping Docker in apply and dry-run`、对应 `unreadable` / `directory` 用例；`switch checks the configured model keyPrefix for the selected user`。断言其他用户的钥匙不能代替本人钥匙、Docker 保持运行及原 restart 策略、归属内容/inode 不变、没有生命周期或对象写入、日志不泄漏合成钥匙。EACCES 用故障注入覆盖，避免 root 可读 chmod 000 文件影响测试。 |

### 四条建议

| 建议 | 修改及对应用例 |
| --- | --- |
| 1. 重复实例日志阶段 | 正常清理完成及 dry-run 报告重复实例前，把 stage 设为 `duplicate instances detected`，不会误报 `FAILED at owner -> docker`；仍返回 1 提醒此次发现了重复实例。`duplicate found during switch confirms zero replicas and no Pods then restores Docker ownership` 增加阶段断言；`duplicate dry-run reports detection without claiming owner write failure or issuing writes` 检查日志、归属和实例保持原状、没有写操作或锁创建。 |
| 2. 不合规代号只跳过 | 仅加入 report.skipped 并输出 SKIP，不加入 report.alarms；合法用户的三类报警与退出码不变。`status lists invalid slugs only as skipped and exits zero when valid users are healthy` 同时验证 runAdopt/main 返回 0；`status skips and reports invalid legacy slugs while still detecting valid-user duplicate alarms` 确认合法用户重复实例仍报警并返回 1，非法代号不触发运行时 inspect，写命令仍拒绝非法用户清单。 |
| 3. 写回 Docker 后复查 k8s | owner=docker 原子写回成功后，再次要求 StatefulSet 不存在或 replicas===0，并确认无任何 Pod。失败阶段明确是写回后的复查，NEXT 指向 rollback --apply，不能误称清理成功。`duplicate cleanup alarms when replicas reappears after Docker ownership is restored`、对应 `pod` 用例模拟写回后在途启动，断言报警、最终 owner=docker、不启动新实例及恢复提示。 |
| 4. 容量规范化 | 仅对 PV 的 spec.capacity.storage 和 PVC 的 spec.resources.requests.storage 用 BigInt 有理数比较，支持二进制 SI、十进制 SI、小数和指数形式，避免浮点精度损失。非容量字段继续按原请求字段比较；无法解析的量不放宽比较。`pv rerun accepts API-normalized capacity and requests: 20480Mi equals 20Gi` 覆盖 data/oldwork 两组 PV/PVC 重跑零 create，并逐一确认 21Gi 真冲突仍拒绝。`storage quantities compare exactly without normalizing unrelated fields` 覆盖多种等价量、G/Gi 差异、超过浮点精度的相邻值、非法量和其他字段不被放宽。保留第 2 轮绑定、路径、节点和 storageClassName 冲突回归。 |

### 第 3 轮验证结果

- `node --test tools/k8s-adopt.test.mjs`：退出码 0；此沙箱父进程汇总为 1 个通过的测试文件。
- `node tools/k8s-adopt.test.mjs`：100 tests、100 pass、0 fail、0 skipped；日志 `/tmp/T-1095-round3-adopt-test.log`。
- 测试只使用假 Docker、假 K1、注入运行时及临时文件；保留真实 createRuntime/K2a/K2b 加假 K1 的网关容器装配用例。
- 本轮按要求运行专项测试，没有重跑 check.sh；第 2 轮记录的沙箱本地监听限制仍需协调者在允许的环境验证。

钥匙前置检查只能确认检查时可读，不能阻止检查后外部删除或权限变更；写回后复查也不能替代迁移窗口暂停请求和排空在途任务。真实集群、Docker 与网络行为仍未验证。

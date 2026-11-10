T-1096 已新增 K8 测试入口、两个镜像 Dockerfile、假工作区进程、S1–S13 场景、部署/清理编排和离线测试。没有修改 check.sh、package 文件、rollout.py 或其他任务的目录。第 2 轮已基于同步后的 main 核对 K2a/K3/K5/K6；没有复制这些组件的实现。

本次沙箱只能验证离线行为，不能声称通过集群验收。Dockerfile 已检查构建上下文、COPY 路径和入口，未构建镜像。完整验收仍需协调者于沙箱外完成两次 k3d 和一次真实集群运行，并保存结果。

**入口和结果**

`bash tools/k8s/e2e.sh --help` 列出完整参数。前缀必须是 `wp-e2e-` 开头、最长 30 字符的 DNS 标签。镜像、管理员 JSON kubeconfig、server/agent 节点名必须显式传入；两个节点必须不同且 Ready。`--node-ips` 补充节点地址，脚本同时从这两个已选节点的 Kubernetes 状态收集 InternalIP/ExternalIP，避免漏测。集群外地址示例仅使用 `192.0.2.10,192.0.2.11`；域名示例仅使用 `probe.test`。测试对象名称由前缀派生。

`e2e.sh` 用 EXIT/INT/TERM trap 调用清理；Node 控制器负责调用 kubectl、K5/K6 和网关中的场景 runner。所有场景通过 `createRuntime({ runtime: { kind: 'k8s', ... }, ... })` 工厂执行，使用网关 ServiceAccount；管理员凭证不会复制到 Pod。测试为网关额外添加了只针对探针 Pod 的 exec Role。S7、S9、S12 的管理员变更由外层执行。

默认输出目录为 `/tmp/<prefix>-results-<随机 UUID>`，执行时输出其路径；也可用 `--output` 指定仓库外路径。显式路径若在 git 仓库内（含 worktree、符号链接别名、尚未创建的子目录）直接拒绝。结果目录和子目录权限为 0700，文件为 0600；归档到仓库外，不提交运行生成的节点信息。恢复时必须传原来的 `--output`，否则会分配新目录。

- `results.json`：逐场景/阶段的 PASS、FAIL、SKIP、耗时和证据；只有完整执行到 S13 才有 `complete: true`。S9、S13 有多个阶段。
- `cleanup.json`：清理结果、失败步骤、诊断日志路径、API discovery 不可用组、当前前缀残留及不限前缀的 `allPrefixesResidual`。部分 discovery 失败时 PASS 只表示可发现资源的检查通过，仍须审阅 `discoveryWarnings`。
- `state.json`：恢复日志，包括 kubeconfig 路径、节点传输参数、原始 nft 表和静态目录所有权标记状态。清理成功前必须保留。
- `command-<随机值>.log`：失败命令的 stderr（包括允许非零退出的命令），报错只引用日志路径；可能含敏感集群数据，须留在私有归档中。
- `guard-<node>.txt`：恢复前的 nft 计数器。Secret 内容、随机口令行和完整运行时错误不写入报告；S6 仅记录是否匹配口令行。
- `organization/organization.json`：K5 的测试组织配置。

控制器遇到失败即停止后续场景并进入清理。S8 无静态目录权限、S10 无外网探针、S12 未传 `--guard` 时明确记 SKIP。要宣称完整网络/兜底验收，需要传 `--guard`，并为需要验收的外网路径提供探针；静态 PV 无权限时按规格允许 SKIP。

**协调者执行：构建和 k3d**

main 已合入 K2a/K3/K5/K6。宿主需要 Node 24、Bash、kubectl、Docker、k3d；K6 还需要 Python 3。使用与真实集群相同小版本的 `K3S_IMAGE`。这些变量由协调者赋值，镜像引用建议使用明确 tag、单平台构建；真实集群分发时必须使用 K6 登记后的规范化完整引用。

```bash
: "${K3S_IMAGE:?指定 k3s 镜像，与真实集群同一小版本}"
: "${E2E_IMAGE:?指定工作区测试镜像引用}"
: "${GATEWAY_BASE:?指定含 K1/K2/K3 的网关基础镜像引用}"
: "${E2E_GATEWAY_IMAGE:?指定 e2e 网关镜像引用}"

docker build -f gateway/Dockerfile -t "$GATEWAY_BASE" .
docker build -f tools/k8s/fixtures/e2e-image/Dockerfile -t "$E2E_IMAGE" .
docker build -f tools/k8s/fixtures/e2e-image/gateway.Dockerfile \
  --build-arg GATEWAY_BASE="$GATEWAY_BASE" -t "$E2E_GATEWAY_IMAGE" .

cluster="wp-e2e-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
run_dir=$(mktemp -d)
kubeconfig="$run_dir/kubeconfig.json"
bash tools/k8s/e2e-k3d.sh up --prefix "$cluster" \
  --image "$E2E_IMAGE" --gateway-image "$E2E_GATEWAY_IMAGE" --kubeconfig "$kubeconfig"
kubectl --kubeconfig "$kubeconfig" get nodes -o wide
```

`up` 创建 server + agent，关闭 traefik，不改默认 kubeconfig，不覆盖已有 kubeconfig 文件，导入两个镜像后输出 JSON kubeconfig。已成功创建的集群在后续导入/导出失败时会删除；已有同名集群不被接管。`down` 只删除显式指定的测试集群。

从上述节点列表设置 `SERVER_NODE` 和 `AGENT_NODE`，值必须匹配节点的 `kubernetes.io/hostname` 标签。全场景测试需要节点容器内已有 `nft`，宿主可调用 K6 的 Python 3；先检查，工具不替操作者安装节点软件。`TUNNEL_INTERFACE` 取集群实际 flannel 接口，不能凭空猜测。两台节点应允许用户 Pod 调度，StorageClass 的 provisioner 必须能使用所传参数；默认使用集群已有 local-path provisioner。

```bash
: "${SERVER_NODE:?从集群取得 server 节点名}"
: "${AGENT_NODE:?从集群取得 agent 节点名}"
: "${TUNNEL_INTERFACE:?指定实际隧道接口}"
: "${EXTERNAL_PROBE:?指定可达外网 TCP 探针 host:port}"

# k3d 节点名和 Docker 容器名通常相同；若不同，用 --ssh-node NODE=CONTAINER 映射。
cat >"$run_dir/node-command" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec docker exec -i "$@"
SH
chmod +x "$run_dir/node-command"
for node in "$SERVER_NODE" "$AGENT_NODE"; do
  docker exec "$node" nft --version
done
pod_cidrs=$(kubectl --kubeconfig "$kubeconfig" get nodes -o json |
  node -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>console.log(JSON.parse(s).items.map(n=>n.spec.podCIDR).join(",")))')

for iteration in 1 2; do
  prefix="wp-e2e-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
  bash tools/k8s/e2e.sh --kubeconfig "$kubeconfig" --prefix "$prefix" \
    --image "$E2E_IMAGE" --gateway-image "$E2E_GATEWAY_IMAGE" \
    --server-node "$SERVER_NODE" --agent-node "$AGENT_NODE" \
    --external-probe "$EXTERNAL_PROBE" --guard \
    --pod-cidrs "$pod_cidrs" --tunnel-interface "$TUNNEL_INTERFACE" \
    --node-command "$run_dir/node-command" --output "$run_dir/run-$iteration"
  node --input-type=module - "$run_dir/run-$iteration" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const dir = process.argv[2];
const results = JSON.parse(fs.readFileSync(`${dir}/results.json`));
const cleanup = JSON.parse(fs.readFileSync(`${dir}/cleanup.json`));
assert.equal(results.complete, true);
assert.equal(new Set(results.results.map(r => r.id)).size, 13);
assert.ok(results.results.every(r => r.status === 'PASS'));
assert.equal(cleanup.status, 'PASS');
assert.deepEqual(cleanup.residual, []);
JS
done
bash tools/k8s/e2e-k3d.sh down --prefix "$cluster"
```

两次使用新随机前缀，在同一个两节点集群中连续运行；两次结果及清理证据均归档。若要覆盖静态 PV，在两次命令中都增加 `--static-pv-node "$SERVER_NODE" --static-pv-dir "$STATIC_PARENT"`，父目录必须事先存在且节点命令可写。脚本只创建/删除其下本次前缀子目录。无需为测试向仓库提供任何真实数据。

若只想先验证基础路径，可不传 `--guard`、`--external-probe`，但这不满足完整兜底验收。k3d 节点镜像缺 nft 时应由协调者先准备同小版本、带 nft 的节点镜像。不要把 SKIP 当成 PASS。

**协调者执行：真实集群临时命名空间**

管理员 JSON kubeconfig 用以下方式导出到权限受限的仓库外文件。先由协调者按规格取得首次加载 nft 的授权；本任务没有连接真实集群，也没有申请或使用新身份/模型凭据。测试模型钥匙是 Pod 中临时生成的随机数据，模型出口是本地假服务。

```bash
: "${ADMIN_KUBECONFIG:?原管理员 kubeconfig 路径}"
: "${JSON_KUBECONFIG:?新 JSON kubeconfig 路径}"
(umask 077; set -o noclobber; kubectl --kubeconfig "$ADMIN_KUBECONFIG" \
  config view --raw --minify --flatten -o json >"$JSON_KUBECONFIG")

: "${SERVER_NODE:?控制面节点名}"
: "${AGENT_NODE:?另一个可调度节点名}"
: "${SERVER_SSH:?server 的 SSH 目标}"
: "${AGENT_SSH:?agent 的 SSH 目标}"
: "${NODE_IPS:?所有节点公网及其他额外地址，逗号分隔}"
: "${POD_CIDRS:?Pod 网段，逗号分隔}"
: "${TUNNEL_INTERFACE:?实际隧道接口}"
: "${EXTERNAL_PROBE:?外网 TCP 探针}"
: "${RESULT_DIRECTORY:?仓库外新结果目录}"
prefix="wp-e2e-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"

bash tools/k8s/e2e.sh --kubeconfig "$JSON_KUBECONFIG" --prefix "$prefix" \
  --image "$E2E_IMAGE" --gateway-image "$E2E_GATEWAY_IMAGE" \
  --server-node "$SERVER_NODE" --agent-node "$AGENT_NODE" \
  --ssh-node "$SERVER_NODE=$SERVER_SSH" --ssh-node "$AGENT_NODE=$AGENT_SSH" \
  --node-ips "$NODE_IPS" --distribute --external-probe "$EXTERNAL_PROBE" \
  --guard --pod-cidrs "$POD_CIDRS" --tunnel-interface "$TUNNEL_INTERFACE" \
  --output "$RESULT_DIRECTORY"
```

`--distribute` 在 K5 建好测试系统命名空间和镜像 ConfigMap 后，对两个镜像分别调用 K6 `distribute-image.sh IMAGE --node TARGET ... --namespace ... --configmap ... --kubeconfig ...`，不自动使用 `--replace`。SSH 目标必须可非交互执行 K6 所需的 k3s、crictl、df，以及 `--guard` 所需的 nft。E2E 默认节点命令为 `ssh -o BatchMode=yes TARGET sh -s`；自定义适配器仍收到 `TARGET sh -s`。`--node-command` 只用于 E2E 的 nft/静态目录操作，不会改变 K6 自身的 SSH 传输；K6 目标须独立满足其权限要求，凭据不进入参数或仓库。

真实集群的 API Service 地址不是规格默认 `10.43.0.1:443` 时传 `--api-probe "$API_SERVICE_IP:443"`；私网抽样地址可用 `--private-probe "$PRIVATE_SAMPLE_IP:$PRIVATE_SAMPLE_PORT"` 覆盖。这些默认值仅用于规格明确要求的隔离目的地，不是节点地址。`--cluster-domain`、`--storage-provisioner`、`--storage-parameters '{"key":"value"}'` 和 `--sample-port` 支持集群差异。测试在两节点各起一个 hostNetwork 假监听 Pod，绑定 `0.0.0.0:sample-port`，会在节点所有 IPv4 接口（包括公网接口）监听。该端口须未被占用、已获测试授权，并由节点外层防火墙阻止外部访问。探针分别在 S10、S12 前创建并验证监听，每个场景的 finally 立即删除，不跨 S11/S13 存活；中断时还有命名空间清理兜底。

**场景判定**

| 场景 | 必须满足的断言 / 证据 |
| --- | --- |
| S1 | create 后存在、未运行、replicas=0；start/stop/start/restart；stop 后 Pod 对象为空，restart UID 改变；remove 后 StatefulSet 不存在、PVC 存在；重建后原文件内容相同。 |
| S2 | start/stop/restart/runOnce 各 10 次按固定乱序并发提交，约每 200 ms 轮询；包括 terminating 在内的未完成 Pod 数 ≤1；runOnce 只允许明确的主 Pod 存在拒绝，其余异常失败；记录采样数、最大数量、40 次结果。发现重叠时尝试删除一次性 Pod，随后停主用户并失败。 |
| S3 | 退出码 0/7，stdout/stderr 分离，logs 为按发送次序拼接；stdin 原样回显；env 保留空格和 shell 字符；输出超限和超时必须抛出对应错误；user=0 拒绝；detached 返回 null，子进程仍活、restartCount 不变。 |
| S4 | processes 返回字符串 pid/ppid，找到假 cc-connect 和其真实子进程的父子关系。 |
| S5 | 三种发布文件首次写入和更新均在各自 90 秒窗口内经 /data 链接读取；轮换后重启真实 relay；ENOENT 正确；租约清理仍指向被重命名的原暂存目录，保留替代目录；拒绝非法路径和符号链接父目录，读取不跟随链接，原子替换链接不改目标。 |
| S6 | 主 Pod 在跑时拒绝 runOnce；停后假 resetpass 退出 0 且含随机口令行；job 访问网关失败；独立检查退出 17；返回时 job Pod 已删除。 |
| S7 | 外层修改登记 ID，inspect 仍保存创建 ID，imageId 返回新 ID，二者不同；未登记镜像 create 拒绝且未生成 StatefulSet；finally 恢复登记。 |
| S8 | 新用户分别用 server/agent nodeSelector 创建并检查 nodeName；预绑定静态 local PV 时检查 Pod 位于指定节点，无节点目录访问参数则静态子项 SKIP。 |
| S9 | 停用户，外层按 K2a 必需策略名称选一条删除，不依赖 K5 输出顺序；start 必须拒绝且没有 Pod；恢复策略后正常运行。 |
| S10 | 两节点用户分别检查网关 DNS=网关 Pod IP；网关两端口、模型和可选外网通；真实监听的网关其他端口、另一用户两端口、所有节点 22/6443/10250/抽样端口、本节点默认路由网关、API Service、metadata 和私网样本不通；网关到用户 25808/3092 通，独立探针命名空间到用户不通；两节点绑定卷上的 job 对网关 DNS/IP、模型、节点、另一用户、API 和可选外网均不通。 |
| S11 | 仅此场景临时添加“probe namespace → 用户 3092”策略，使请求能到达真实 relay；网关持相同密钥返回 200，探针 Pod 返回明确 HTTP 403（超时不算通过）；两个节点均测，探针异常或状态未达到正反对照时重试；finally 删除放行策略。 |
| S12 | 仅 --guard 时，在测试用户命名空间移除测试 NetworkPolicy；两节点用户访问宿主和 cni0 的 22/实际监听抽样端口仍拒绝；重试直到网关其他监听端口可通且宿主拒绝同时成立，证明策略已去除；6443/10250 只记录观察结果，明确标为 nft 例外，不误判为必须阻断；finally 恢复策略。 |
| S13 | 记录既有用户 Pod UID/restartCount，另建 replicas=0 的 takeover 用户；删除网关 Pod 并等新 UID 就绪；既有用户 UID/restartCount 都不变，新网关中的真实 K3 keepRunning 将 takeover 拉起。 |

S11/S12 每个节点的策略收敛重试默认 60 秒，间隔 200 ms，可用 `--policy-timeout-ms` 调整；到期仍不符合时失败，单次探针另有自身超时。负向 TCP 探针记录超时或连接错误，不能单靠“拒绝连接”证明某个本来没有服务的端口被防火墙阻断。因此网关其他端口及节点抽样端口都有真实监听正对照；6443/10250 等端口仍应结合实际集群服务和 nft 计数器审阅。S10 任一不符合即终止，不继续 S11/S12。

**清理与重试**

测试自身创建的对象和 Pod 模板统一带 `workpartner-e2e=<prefix>`；通过 runtime 注入 K1 客户端给创建/merge patch 的对象加标签，不改运行时生命周期逻辑或 StatefulSet selector。动态 PV 由 provisioner 创建后，控制器在场景后及清理前按带所有权标签的用户命名空间补标签。此类控制器生成对象无法由调用方在创建瞬间附标签；命名空间删除提供兜底。

清理顺序：两个业务测试命名空间和第三个 probe 命名空间（按精确标签筛选并等消失）；等 Delete reclaimPolicy 动态 PV 回收完成；删除测试 StorageClass；删除剩余 Retain/static PV；删除 K5 测试 PriorityClass。动态 PV 等待失败时保留 StorageClass 和 PV，供 provisioner 继续回收，其他清理仍继续。仅在前面的删除均成功后，删除带本次标记的静态子目录。nft 表按节点原始快照恢复，原先没有表时删除本次表。恢复失败保留日志，清理返回非零。

所有清理步骤尽量继续执行并汇总错误，失败不能被后续成功掩盖；当前前缀残留审计失败或发现对象时不算清理通过；另查 `-l workpartner-e2e` 的所有前缀，只报告、不改变退出状态、不删除其他前缀对象。审计通过 API discovery 遍历全部可 list 的命名空间和集群资源，而不是只检查 `kubectl get all`。管理员需要相应读取权限。`api-resources` 非零退出但有 stdout 时继续检查已发现资源，不可用 API 组和原始 stderr 日志路径写入 `cleanup.json`；完全无可用输出、命令启动失败、已发现资源的 get 失败仍按错误处理。

```bash
# 使用同一输出目录恢复 kubeconfig 路径、节点命令及 nft 快照，可重复运行。
bash tools/k8s/e2e.sh --cleanup --prefix "$prefix" --output "$RESULT_DIRECTORY"
# 也可明确覆盖 kubeconfig 路径。
bash tools/k8s/e2e.sh --cleanup --prefix "$prefix" \
  --kubeconfig "$JSON_KUBECONFIG" --output "$RESULT_DIRECTORY"
```

没有 state.json 时，`--cleanup --prefix` 仍能按标签删除 Kubernetes 对象，可显式传 kubeconfig 或使用 kubectl 当前配置；但不能恢复丢失的 nft 快照或推断静态目录。不得丢弃 state.json 后宣称完整清理。SIGKILL/宿主断电不能执行 trap，此时也按上述命令恢复。默认拒绝复用已有 state.json 的结果目录和已有同名对象；前置检查未通过时自动 trap 不会删除其他运行的对象。

本次使用 `--distribute` 时，分发前先将镜像意图写入 `state.distributedImages`，清理逐一调用 K6 `--unpin`，成功后记为已解除，失败只记录且下次清理重试；未使用 `--distribute` 不解除 pin。旧版 state 没有镜像清单时，使用其 config 中记录的两个镜像作为恢复清单。解除 pin 让 kubelet 可以回收镜像，不主动删除缓存；失败时手动执行：

```bash
# IMAGE 和节点目标取自原 state.json；对两个记录的镜像分别执行。
bash tools/k8s/distribute-image.sh --unpin "$IMAGE" \
  --node "$SERVER_SSH" --node "$AGENT_SSH"
```

unpin 警告不会覆盖原场景错误，trap 也保留原非零退出码。镜像缓存不计作 Kubernetes 对象残留；脚本不删除宿主已有镜像、正式防火墙表、用户数据或任何正式命名空间。

**接口假设及本次验证**

- K2a：`createRuntime(organization, {client, ...runtimeOverrides})` 同步返回运行时；create 接收用户对象及可选 modelConfig；inspect 有 exists/running/imageId/address/replicas/annotations；readFile 为 UTF-8 字符串；runOnce 使用 name/entrypoint/cmd/timeoutMs，返回 exitCode/logs；客户端为 K1 get/create/patch/remove/exec/waitFor 形状，404 返回 null。create 从 secureDirectory 下 `${model.keyPrefix}${slug}.key` 读取模型钥匙。名称和 paused/image-id 注解遵循规格。
- K3：复用 `createMigration(organization).owns` 及 `createAionui({runtime,kind:'k8s',owns}).keepRunning(usersFunction)`。测试网关用空目录内的 version=1/default=k8s 归属文件；仅 S13 的 takeover 加入常驻名单，避免常驻保障干扰 S1/S2 的 stop。网关为测试 HTTP 监听器加真实运行时/K3 组件，不涉及真实登录、机器人、外部凭据或 R2 的业务网关验收。
- K5：CLI `node tools/k8s/render.mjs --org DIR` 输出 `---` 分隔的 JSON-form YAML；命名规则已对照当前 main 实现。K5 原样生成 RBAC、Service、NetworkPolicy 等；测试仅将 SC 改为 Delete，将 Deployment 入口替为 e2e 程序、hostPath 改为 ConfigMap/emptyDir、移除 hostPort，增加 readiness 和所有权标签。不会触碰真实组织挂载、入口或 StorageClass。
- K6：真实集群调用 distribute-image.sh 原 CLI；`node-guard.sh apply --pod-cidr ... --tunnel-interface ... --node-ips ... --dry-run` 本地生成规则，然后通过参数指定的节点命令执行 nft 的检查和原子加载，加载前保存独立表。恢复不能简单调用 remove，否则会丢失运行前已有规则；使用保存的 nft 表定义恢复。现场必须保证测试期间没有另一操作者同时修改同一 guard 表。
- 本轮离线编排测试直接调用当前 main 的 K5 CLI 渲染组织配置，检查用户策略名称匹配 K2a 三条必需策略；K5 网关 Service 仍为 headless，符合 S10 的 DNS 判定。这不替代集群验证。
- `node --test tools/k8s-e2e.test.mjs` 已通过；测试覆盖脚本 bash -n、帮助/参数验证、全部场景模块无副作用加载、标签保留 selector、假 kubectl 的重复清理清单/残留审计/失败继续、恢复状态和未授权清理保护。
- `bash tools/check.sh` 已尝试，执行到现有 `tools/wp-seed.test.py` 时失败：`HTTPServer(('127.0.0.1', 0), ...)` 创建 socket 被沙箱拒绝，`PermissionError: [Errno 1] Operation not permitted`。没有修改或弱化该测试；完整检查需协调者在允许回环 socket 的环境重跑。
- 两个入口脚本及镜像 start.sh 的 `bash -n` 通过。沙箱 Node 为 v22.22.1，集群镜像按要求使用 Node 24。
- 本任务没有 Docker、k3d、kubectl 集群或 nft 实跑证据；k3d 两次及真实集群一次仍由协调者按上述命令补齐。镜像拉取、构建、节点防火墙加载均未在沙箱尝试。

**第 2 轮返工：端到端测试加固（2026-11-10）**

本轮按 `review-1.md` 建议 1–11 实施，建议 12 留作后续。基于已同步的 main 只读核对 K2a 必需策略、K3 `createMigration`/`keepRunning`、K5 headless Service/策略渲染以及 K6 unpin/SSH 接口；正文中“依赖尚未合入”“参考其他分支”“结果默认落在仓库内”等过时说法已更新。仅修改本任务新增路径，没有修改 gateway、deploy、K6、check.sh、package，也没有增加依赖。

| 建议 | 本轮修改 | 对应离线用例（`tools/k8s-e2e.test.mjs`） |
| --- | --- | --- |
| 1 | 分发前保存每个镜像意图；仅本次 `--distribute` 的 state 执行 K6 `--unpin IMAGE --node ...`，使用保存的节点映射。成功记录 `unpinned`，失败写 cleanup warnings/log 并继续，下次只重试未成功项。旧 state 可用 config 镜像恢复；正文给出手动命令。 | `unpin uses journaled images...`：两个镜像、两节点映射、一个失败后继续、再次清理只重试失败项、未 distribute 不调用、原 FAIL 结果保留。 |
| 2 | 默认结果在仓库外 `/tmp` 随机目录；参数解析及控制器都检查输出路径，拒绝仓库/worktree 内路径及其符号链接别名。目录/子目录 0700，原子替换后的结果文件和命令日志 0600。 | `output defaults outside git...`：默认路径、当前仓库、其他仓库、worktree、未创建子目录及符号链接拒绝；`artifacts and command stderr logs...`：已有宽权限文件/目录收紧；cleanup 用例验证真实产物模式。 |
| 3 | 去掉 S11/S12 固定 sleep；按节点重试完整正反对照，默认 60000 ms，`--policy-timeout-ms` 可覆盖。S11 同时要求 200/403；S12 同一次尝试要求网关端口可通且节点抽样端口拒绝。 | `S11 retries probe errors...`：探针进程异常、错误 HTTP 状态后收敛、永不收敛时失败；`S12 retries positive and negative controls...`：正对照延迟、负对照曾开放、最终收敛及超时失败。 |
| 4 | `api-resources` 使用 acceptFailure，非零但有 stdout 时仍遍历已有资源，记录 `discoveryWarnings[].unavailableApiGroups` 和 stderr 日志路径；无输出/启动失败仍报错。预检发现的警告在未 arm 时也写入 cleanup.json。 | `partial API discovery continues in preflight and cleanup...`：模拟 metrics API 部分失败，预检继续到节点检查，清理 PASS，可用资源仍逐项 get，缺失组和日志可读。 |
| 5 | 删除命名空间并等待消失后，先等待 Delete PV 回收，再删 StorageClass 和剩余 PV；回收等待失败时保留后两者。 | `cleanup waits for Delete PV reclamation...`：第一次查询仍有 Delete PV，第二次已消失；验证两次查询都先于 StorageClass/PV 删除。 |
| 6 | S9 按 K2a 必需策略名称查找待删策略，缺少匹配项直接失败；不使用数组第一项。 | `S9 chooses a K2a required policy...`：打乱顺序且首项为无关策略，仍选中必需名称；编排用例直接校验 main K5 实际渲染的三条策略。 |
| 7 | 控制器所有失败命令（含 acceptFailure、超时、启动失败）将 stderr 保存为独立命令日志；错误/场景记录只引用路径。 | `artifacts and command stderr logs...`：严格失败和接受失败均保存 stderr、0600、终端错误仅含路径；编排用例注入 runner stderr，验证 results/state 日志引用且终端不泄露内容。 |
| 8 | 默认节点调用增加 `-o BatchMode=yes`；自定义适配器保留原 NODE sh -s 接口。正文说明 K6 使用自己的 SSH，不受适配器参数影响。 | `S9 chooses a K2a required policy...` 同时校验默认 SSH 和自定义适配器参数；guard 恢复用例继续验证适配器执行。 |
| 9 | 报告明确 `0.0.0.0:sample-port` 覆盖节点全部 IPv4 接口，需外层防火墙挡住外部访问；探针仅分别在 S10/S12 前创建、检查 Ready 和本机监听，每段 finally 立即删除。 | `host probes exist only during network scenarios...`：完整假集群编排验证 S9 后才创建、S10 后且 S11 前删除、S12 后且 S13 前再次删除；S10 失败也先删除探针再进入全局清理。 |
| 10 | finally 读取每个节点 nft 计数器经 `recordOnly` 的 try/catch 单独记录到 state warnings，继续处理下一节点，不覆盖原场景错误。 | `finally diagnostic failure...` 验证保留同一个错误对象；host probes 编排用例实际注入两节点计数器命令失败，同时验证正常场景仍成功、S10 原 FAIL 及退出码仍保留。 |
| 11 | 结束时追加 `-l workpartner-e2e` 存在性查询，`allPrefixesResidual` 只报告；查询失败也只记录 warnings。不改变当前前缀审计结论或删除范围。 | `partial API discovery continues...`：本前缀为空、全前缀有残留仍 PASS，并确认执行了不限前缀 selector；原残留用例继续证明本前缀残留判 FAIL。 |

验证结果：

- `node --test tools/k8s-e2e.test.mjs`：通过，退出码 0。为展开本沙箱默认仅显示的文件级 TAP 汇总，另以 `--experimental-test-isolation=none` 运行同一套件，19/19 通过、无跳过；包含两个 shell 入口和镜像入口的 `bash -n`。
- 本轮补充编排用例实际使用当前 main 的 K5 CLI 渲染，以及 K6 `node-guard.sh ... --dry-run` 本地生成规则；kubectl、节点命令和 unpin 调用全部由假命令接管。没有真实集群、SSH、nft 加载、镜像构建或网络访问。
- `bash tools/check.sh`：已重跑，现有 `tools/wp-seed.test.py` 在 `HTTPServer(('127.0.0.1', 0), ...)` 创建 socket 时被沙箱拒绝，`PermissionError: [Errno 1] Operation not permitted`，退出码 1，未执行后续测试。未更改该测试或降低检查要求。
- 未执行 git 提交。k3d 连续两次与真实集群一次的验收仍需协调者在沙箱外执行；API discovery 警告、unpin 警告和不限前缀残留须随结果一起审阅，不能将部分审计 PASS 解释为不可用 API 组也已检查。

后续：建议 12 本轮不做。S7 仍比较 `inspect.imageId` 与 `runtime.imageId` 判断过期，后续再评估复用网关实际过期判断路径。

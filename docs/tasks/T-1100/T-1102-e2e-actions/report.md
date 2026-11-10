# T-1102 交付报告

已新增手动 GitHub Actions 集群测试入口、四个 CI 适配脚本，并只在 `docs/kubernetes.md` 的 K8 探针一节补充操作说明和宿主风险提示。没有修改 gateway、check.sh、package 文件、adopt 或原有 K8 入口；保留任务目录原有 brief.md。未联网、未提交、未执行真实 Docker/k3d。

## 交付行为

- `.github/workflows/e2e-k3d.yml` 只有 `workflow_dispatch`，顶层权限仅 `contents: read`，使用 `ubuntu-24.04`、90 分钟 job 超时。checkout 禁止持久化凭据；三个 action 都固定 40 位提交 SHA，无 secrets 引用。
- 输入 `k3s_image` 默认按任务要求保留 `rancher/k3s:v1.37.2-k3s1`；额外必填 `external_probe`，提供操作者控制、无凭据的公网 TCP 端点，避免默认跳过 S10 外网子项。用户输入通过环境变量传递，不拼进 workflow 的 shell 源码。示例仅使用保留测试域名和文档地址。
- Node 24 使用与 tests.yml 相同的 setup-node action。kubectl 固定 `v1.37.2`，k3d 固定 `v5.8.3`；下载对应版本的官方 SHA256 文件，严格检查后安装到本次私有目录。校验和来自同版本发布附件，未编造或硬编码未经联网核实的摘要。
- 三个测试镜像按 T-1096 报告构建，固定 `linux/amd64`，均用 `docker.io/library/...:<随机前缀>` 完整引用。节点镜像以输入镜像为最终 FROM，保留 k3s 版本和入口；从 `alpine:3.21.3` 安装 nft，复制到独立 `/opt/e2e-nft`，包装器显式调用独立 musl loader/library path，不要求 k3s 镜像有 apk，也不覆盖其原有动态库。
- 一个 server、一个 agent，启动后实际核验两节点名与 hostname 标签、Ready 状态、Pod CIDR、`flannel.1` 和 nft。创建节点内静态卷父目录。两轮分别使用随机集群前缀加 `-1` / `-2`，同一集群连续执行全部场景，包含 `--guard`、`--distribute`、静态卷及外网探针参数。第一轮失败则第二轮不继续，最终明确报告缺失项。
- `ci-node-command.sh` 实现 E2E 的 `NODE sh -s`；`ci-ssh.sh` 只在调度脚本子进程 PATH 中冒充 K6 所需的 ssh，将单个已引用命令串传给 `docker exec -i NODE sh -c COMMAND`。两者只允许本次两个节点；不连接 SSH，不配置钥匙；镜像导入保留二进制 stdin，原样返回退出码。K6 的 pin/unpin 也走同一适配器。
- 每轮显式 cleanup 和最终 down 分别为 `if: always()` 步骤，互不因前一个失败而跳过。早期安装/构建失败、没有 kubeconfig 时有无集群状态处理；up 部分创建失败由原入口清理，最后仍调用 down（已安装 k3d 时）。清理保留同一 prefix、output 和 kubeconfig，SSH 适配器一直保留到解除 pin 完成。
- `ci-results.mjs` 要求完整 S1–S13 及 S9 的三个阶段、S13 的两个阶段，拒绝重复、缺失、无效状态、`complete != true`、顶层 FAIL/SKIP，以及 evidence 中对象、数组或字符串形式的 FAIL/SKIP。清理须 PASS，errors、warnings、discoveryWarnings、当前和其他前缀残留均为空。每轮正常返回后先检查一次，最后 always 再统一生成两轮 summary 并判定。
- init 先写 `complete:false` 的空 results.json，前置失败不会误报通过。summary 明确逐场景/阶段列 PASS、FAIL、SKIP 或 MISSING/INVALID；artifact 白名单上传两轮结果、清理报告、运行/构建/失败命令日志和 guard 计数器，保留 7 天，不上传 kubeconfig、state.json、组织配置。job 硬终止仍可能来不及清理或归档，托管虚拟机回收提供最终隔离。

## 参数与步骤核对来源

| workflow 步骤 / 参数 | 核对位置及结论 |
| --- | --- |
| checkout、Node 24、权限、runner | `.github/workflows/tests.yml`：复用 checkout v4.2.2、setup-node v4.4.0 的 SHA 和 node-version 24；新增 workflow 仅保留手动触发与只读 contents。upload-artifact 使用固定 v4.6.2 SHA，未联网解析远端提交。 |
| init 的 prefix、output、输入 | `tools/k8s/e2e/options.mjs:parseArgs/endpoint`、`artifacts.mjs:outsideRepository`：最长 30 字符的 wp-e2e 前缀、仓库外输出、host:port；随机前缀加轮次仍符合长度限制。所有运行目录/日志位于 runner.temp。 |
| 工具安装 | `ci-k3d.sh:install`：kubectl `/release/<version>/bin/linux/amd64/kubectl[.sha256]`，k3d `/releases/download/<version>/{k3d-linux-amd64,checksums.txt}`；只选精确文件名对应的一行，`sha256sum --check --strict` 成功后 install。不使用 latest、远程安装脚本或未验证的二进制。 |
| 三个 Docker build | `docs/tasks/T-1000/T-1096-k8s-e2e/report.md` 的“协调者执行：构建和 k3d”；逐一读取 `gateway/Dockerfile`、fixtures 下两个 Dockerfile，核对仓库根上下文和 `GATEWAY_BASE` build arg。 |
| 同版本 nft 节点镜像 | T-1096 报告“节点镜像缺 nft”说明；`controller.mjs` 的 `remote()` 在节点执行 nft；`ci-k3d.sh:build` 保持输入为最终 FROM，仅添加独立工具目录和 PATH。 |
| `e2e-k3d.sh up` | 原脚本 usage、参数解析及 up 分支：K3S_IMAGE 环境变量；`--prefix --image --gateway-image --kubeconfig`；原入口负责 1 server + 1 agent、禁 traefik、导入镜像和 JSON kubeconfig。没有给原入口添加不存在的参数。 |
| 节点、Pod CIDR、隧道、静态目录 | `controller.mjs` 节点预检要求 metadata.name 与 hostname 标签相等；`options.mjs` 要求静态节点属于所选两节点；`node-guard.sh` 要求 Pod CIDR、实际隧道和节点地址。适配脚本按 k3d 默认节点名称核验实际 API 数据，不盲用未检查的名称；flannel.1 在两节点均用 ip link 核验。 |
| `e2e.sh` 全场景参数 | `options.mjs:parseArgs`、`controller.mjs` 的 scenario 调度和静态 PV 创建：传镜像、节点、输出、静态卷、外网、guard、distribute；`--pod-cidrs` 是 E2E 参数，其内部才转成 guard 的 `--pod-cidr`。已用 `--print-config` 离线校验完整参数组合。 |
| `--node-command` 与 K6 SSH | `controller.mjs:nodeArguments/remote` 发 `NODE sh -s`；`distribute-image.sh:remote` 固定发 `ssh -o BatchMode=yes -- TARGET COMMAND`，command 内各词已 shell quote，镜像 archive 通过 stdin。两个协议分别适配，未误认为 node-command 会改变 K6。 |
| `--distribute` 与完整镜像引用 | `controller.mjs` 分发分支创建 namespace/ConfigMap 后，对两镜像调用 K6，并从登记表取 config ID；`distribute-image.sh` 的 reference/archive/inspect/registration 校验规范化引用及 config SHA256。build、up、run 一律传相同完整引用，不依赖 Docker inspect 的 manifest/index ID。 |
| 两轮及全部阶段 | K8 规格末尾要求 k3d 连续两次通过；`controller.mjs` 明确 S9 prepare/missing/restored、S13 prepare/restored；`runner.mjs` 顶层 status，`scenarios.mjs` 的 S8/S10/S12 有不同形式的 SKIP，结果检查覆盖这些形式。 |
| `e2e.sh --cleanup` | 原 `e2e.sh` trap、`options.mjs` cleanup 分支、`controller.mjs` 清理分支和 T-1096 的恢复示例：显式同 prefix/output/kubeconfig；恢复 nft、移除静态子目录、调用 K6 unpin、审计残留。adapter PATH 和节点变量在每次 cleanup 时重新设置。 |
| `e2e-k3d.sh down` | 原 down 分支只接受指定测试 prefix；workflow 独立 always 步骤，不受 cleanup 失败影响。 |
| summary、artifact | `controller.mjs` 的 results.json/cleanup.json 格式与 `artifacts.mjs` 私有文件约定；检查精确阶段、complete、嵌套状态和清理审计。artifact 路径逐项白名单，无整个输出目录上传。 |

## 验证结果与边界

1. 使用沙箱已有 Node `v24.22.1` 执行 `bash tools/check.sh`，并取消 `WORKPARTNER_TEST_IMAGE`，保证不进入可选 Docker 测试。前置 JS/Python/Shell 语法检查完成；随后既有 `tools/wp-seed.test.py` 在创建本地 HTTPServer 时因禁止 socket 返回 `PermissionError: [Errno 1] Operation not permitted`，退出 1，未继续全套检查。日志 `/tmp/T-1102-check.log`。未修改检查脚本或以跳过测试冒充全通过。
2. `node --test tools/k8s-e2e.test.mjs tools/k8s-tools.test.mjs tools/k8s-render.test.mjs`：三个测试文件通过，退出 0、无失败/跳过，包含现有控制器、K6、guard、渲染的离线替身测试。日志 `/tmp/T-1102-k8s-tests.log`。
3. 新增脚本 `bash -n`、`node --check` 均通过。PyYAML BaseLoader 解析 workflow，通过触发器、权限、runner 和三个 40 位 action SHA 检查；逐个 run block 用 `bash -n` 检查。沙箱 PATH 没有 actionlint，无法执行其 GitHub Actions 专用语义检查，未联网安装。已按上表逐项人工核对字段与参数。
4. 临时离线验证脚本 `/tmp/T-1102-offline.mjs` 共 56 项断言通过：完整报告通过；顶层/嵌套 FAIL/SKIP、缺阶段、重复项、不完整结果、清理异常拒绝；损坏 JSON 返回失败且仍生成逐项 summary；两适配器 argv、二进制 stdin、退出码、未知节点/选项拒绝；init 权限/防复用/非法镜像、无集群清理；模拟发布文件的 SHA256 成功与两种不匹配拒绝；四个构建命令的完整引用、单平台与基础镜像。curl 和 docker 都是本地替身，没有网络请求或 Docker 调用。
5. 实际调用 `e2e.sh --print-config`，包含本 workflow 全部 probe 参数，通过；调用 `node-guard.sh apply ... --dry-run`，确认 CIDR/接口/节点地址组合可渲染，无内核或集群操作。仅使用保留文档网段和测试域名。
6. `git diff --check` 通过；人工复核修改范围：只新增指定 workflow、四个 e2e 适配脚本、本报告，文档 diff 只在探针一节。

这次交付不声称集群端到端已通过。按“不联网”限制，未核实 kubectl/k3d 下载、action 提交和 k3s/Alpine 镜像在远端的当前可用性，也未构建节点镜像或执行 nft。尤其任务指定的 k3s 默认值及匹配 kubectl 版本须在首次托管运行中验证；任何不存在的发布、SHA256 不匹配、基础镜像不兼容、接口缺失、超时或外网探针不可达都会使 job 失败，不回退版本、不降低场景要求。首次手动运行需提供可公开的外网 TCP 探针，并审阅两轮 summary、清理结果和 artifact；这不能替代真实集群验收。

## 第 2 轮返工

本节更新前文中工具摘要来源、SSH 命令转发、接口检查与超时的描述。两条必改及五条建议均已落实；本轮仅修改指定 workflow、`ci-k3d.sh`、`ci-ssh.sh`、文档 CI 一节、本报告，并新增 `tools/k8s/e2e/tests/ci-adapters.test.mjs`。未修改 K6、gateway、check.sh、package 文件或共享探针解析器；未联网、未 git 提交、未运行真实 Docker/k3d。

### 修改与核对

- 依据 `distribute-image.sh:remote()` 和全部调用点，CI SSH 适配器只识别三个带单引号、空格的精确前缀：`'k3s' 'crictl' ` 改为 `'crictl' `，`'k3s' 'ctr' ` 改为 `'ctr' `，`'df' ` 原样放行；其他前缀返回 2。后续参数、引用和二进制 stdin 保持原样，节点限制与退出码透传保留，K6 本身不变。
- `ci-k3d.sh up` 在两个节点分别执行一次 `crictl images -o json` 和 `ctr -n k8s.io images ls -q`；任何失败立即终止 up。隧道检查改成 `docker exec "$node" test -d /sys/class/net/flannel.1`，不再依赖节点内的 ip 命令。
- up 最后等待 kube-system 全部 deployment Available，再等待全部 APIService Available，分别使用 `--all --timeout=180s`。等待失败仍让 up 失败，不忽略 discoveryWarnings。
- 两轮显式 cleanup 的超时均从 3 分钟改成 10 分钟；up 从 5 分钟改为 10 分钟，容纳新增的两次等待。安装 5、构建 10、up 10、两轮运行各 15、两轮清理各 10、down 2，显式步骤预算合计 77 分钟，因此 job 改为 90 分钟，剩余 13 分钟供 checkout、Node 安装、初始化、summary 与 artifact 使用。75 分钟不足以覆盖这组预算；硬终止的限制仍同前文。
- init 使用 Node 内置 `isIP` / `BlockList` 拒绝 RFC1918、IPv4 回环、链路本地、CGNAT，以及 IPv6 `::1`、`fe80::/10`、`fc00::/7`，包含 IPv4 映射 IPv6。校验在创建运行目录前完成，不做 DNS 查询。共享 endpoint 只支持 IPv4/主机名，因此其他 IPv6 探针也继续被拒绝，未扩展不在本轮范围内的探针协议。
- 文档 CI 一节补充：本地示例使用 up 已导入的镜像，不启用分发；CI 显式 `--distribute` 是为覆盖 K6 的导入、ID 校验、登记和 pin/unpin，并说明上述精确前缀改写、输入校验和启动检查。

### 固定 SHA256 来源

以下值由协调者提供；协调者已从官方发布取得并与另一来源交叉核对。本轮按“不联网”要求直接采用，未声称自行在线复核：

| workflow env | 固定值 | 官方来源 |
| --- | --- | --- |
| `KUBECTL_SHA256`（v1.37.2，linux/amd64） | `c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4` | [kubectl.sha256](https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl.sha256) |
| `K3D_SHA256`（v5.8.3，linux/amd64） | `dbaa79a76ace7f4ca230a1ff41dc7d8a5036a8ad0309e9c54f9bf3836dbe853e` | [checksums.txt](https://github.com/k3d-io/k3d/releases/download/v5.8.3/checksums.txt) 中 `k3d-linux-amd64` 行 |

install 要求两个固定摘要存在且格式正确，保留下载官方摘要文件做交叉比对，不一致立即失败。实际二进制以 workflow 固定摘要生成校验行，执行 `sha256sum --check --strict -`；两个校验都成功才安装。在线文件不再作为唯一信任来源。

### 本轮验证

1. 使用环境已有 Node `v24.22.1` 执行 `node --test tools/k8s/e2e/tests/ci-adapters.test.mjs`，退出 0。再用 `--test-isolation=none` 展开逐例证据：18/18 通过，0 失败、0 跳过。覆盖两个前缀改写、df 引用保留、二进制 stdin、未知前缀/节点/调用格式拒绝、退出码透传、IP 拒绝、固定摘要缺失/格式错误、发布摘要不一致、二进制损坏、两节点检查与 readiness 失败提前退出。curl、docker、kubectl、k3d 均为本地替身。日志 `/tmp/T-1102-r2-offline.log`、`/tmp/T-1102-r2-offline-detailed.log`。新增用例可单独运行，不需要修改 check.sh。
2. `env -u WORKPARTNER_TEST_IMAGE bash tools/check.sh`：前置 JS/Python/Shell 语法检查通过；既有 `tools/wp-seed.test.py` 创建本地 HTTPServer 时被沙箱禁止 socket，报 `PermissionError: [Errno 1] Operation not permitted`，整体退出 1。日志 `/tmp/T-1102-r2-check.log`。没有执行可选 Docker 检查，也没有将此结果称为全套通过。
3. 单独补跑相关 `node --test tools/k8s-e2e.test.mjs tools/k8s-tools.test.mjs tools/k8s-render.test.mjs`，三个文件均通过、无失败/跳过。日志 `/tmp/T-1102-r2-k8s-tests.log`。其余五个 Python 测试文件（image/tests 三个、hooks 两个）共 44 项通过，日志 `/tmp/T-1102-r2-python-tests.log`；未声称全部其他 Node 测试已执行。
4. `ci-*.sh` 的 `bash -n`、`ci-results.mjs` 与新增用例的 `node --check` 通过。PyYAML BaseLoader 解析 workflow 并核对手动触发、只读权限、runner、40 位 action SHA、cleanup 的 always/10 分钟配置、77/90 分钟预算；每个 run block 的 `bash -n` 通过。环境没有 actionlint，未联网安装。
5. `git diff --check` 通过；本轮文件范围按上文核对。真实发布文件可用性、节点镜像工具与 API 就绪情况仍需首次托管 Actions 运行验证，离线替身测试不替代真实集群验收。

## 第 3 轮返工

本轮仅修改 `.github/workflows/e2e-k3d.yml`、`tools/k8s/e2e/ci-k3d.sh`、`tools/k8s/e2e/tests/ci-adapters.test.mjs` 和本报告。未联网、未 git 提交、未运行真实 Docker/k3d。

- 从 job 级 `env` 移除 `CI_E2E_DIR`；在 checkout 之后、init 之前新增步骤，将 `CI_E2E_DIR=$RUNNER_TEMP/k3d-e2e` 写入 `$GITHUB_ENV`。后续脚本继续使用 `$CI_E2E_DIR`，artifact 的 step `with.path` 保留合法的 `${{ runner.temp }}`。全文复查确认唯一 job 的 `env` 仅使用 `inputs` 上下文，没有 job 级 `if`，没有其他 job 级 `runner`、`env`、`steps` 引用。
- 新增离线用例读取 workflow 文本，提取 job 级 `env` 段并断言不包含 `runner.`，同时确认确实找到了待检查的段。
- external_probe 拒绝列表新增 `0.0.0.0/8`，含 IPv4 映射 IPv6；非标准 IP 的全数字、纯十六进制、点分数字/十六进制及带 `0x` 前缀标签的主机名一律拒绝，含大小写与尾随点形式。新增用例覆盖 `2130706433`、`0x7f.1`、八进制外形等输入，确认在创建运行目录之前拒绝且不调用外部工具；普通测试域名和文档 IPv4 仍通过。
- 前文交付行为中的 job 超时直接修正为 90 分钟。

### 本轮验证

1. 使用当前环境 Node `v22.22.1` 执行指定命令 `node --test tools/k8s/e2e/tests/ci-adapters.test.mjs`，退出 0；另用 `--experimental-test-isolation=none` 展开逐例结果：20/20 通过，0 失败、0 跳过。所有外部工具均使用本地替身，无网络或真实集群操作。
2. `bash -n tools/k8s/e2e/ci-k3d.sh`、测试文件的 `node --check` 通过；PyYAML BaseLoader 解析 workflow，检查全部 job 的 `env` / `if` 无上述不允许的上下文，并核对目录环境变量写入内容和 checkout / 设置目录 / init 的顺序；所有 run block 的 `bash -n` 通过。环境无 actionlint，未联网安装，未声称已通过 GitHub 托管执行验证。
3. `git diff --check` 通过。本轮修改范围如上；未重跑前轮已记录受沙箱 socket 限制的全库检查。

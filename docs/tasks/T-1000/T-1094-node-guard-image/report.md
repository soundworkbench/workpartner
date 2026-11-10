## 第 2 轮返工：K6 节点兜底与镜像分发

本轮在原 worktree、原分支继续修改指定的五个实现/测试文件，另按要求写入本报告。工作区此前没有 `report.md`，因此本次创建该文件；未改动任务说明、规格、check.sh、package 文件或 rollout.py，未新增依赖。未执行真实 nft/ctr 写操作。

### 规则和服务

- input 链在 cni0 drop 前放行 IPv6 NS、NA、RS、RA，保留已建立连接和 TCP 6443/10250 例外。IPv4 ARP 属于二层协议，不经过这个 inet 表，无需另加 ARP 放行规则。
- 某地址族没有节点地址时，保留带类型的空集合和引用规则，但不生成 `elements` 行；纯 IPv4、纯 IPv6 和双栈均可渲染。纯 IPv4 是本次重点回归场景。
- forward 链的第一条规则为 `ct state established,related counter accept`，其后保留节点目的地址的端口例外及丢弃规则。
- systemd 模板增加 `After=nftables.service`、`PartOf=nftables.service`，并增加 `ReloadPropagatedFrom=nftables.service`。`PartOf` 只传播 stop/restart，reload 需要后一项；保留 `ExecReload=... apply`，让已启动的 guard 在 nftables 服务 reload 后重新 apply。
- 运维更新规则应使用 `systemctl reload node-guard.service`。restart 会先执行 `ExecStop=remove`，再 apply，存在短暂无规则窗口；nftables 的 restart 经 PartOf 传播时同样需要注意。宿主 nftables reload 若自身清空整套规则，到 guard 重新 apply 之间也可能有间隔，不能将两个服务的 reload 宣称为一个原子事务。直接执行 nft 命令不会触发 systemd reload 传播。
- 默认仅配置启动顺序，不配置 k3s 对 guard 的强依赖：apply 失败时 k3s 仍可能启动，即 fail-open。是否添加 `RequiredBy=k3s.service k3s-agent.service` 并重新 enable 建立依赖，由运维决定。
- Python 依赖采用本轮允许的兜底方案：保留现有标准库 `ipaddress` 的完整 IPv4/IPv6、严格 CIDR 主机位和作用域校验，未替换为手写 awk 地址解析器。在 apply 入口检测 python3，不存在时立即说明用途并报错，早于渲染及任何 nft 调用；用法中仍明确列出依赖。

### 镜像分发

- `docker image inspect` 只提供 Size 用于节点磁盘预检，不再读取 `.Id` 作为期望 ID。所有节点磁盘检查通过后，执行一次 `docker save`，把同一份归档暂存到本机 TMPDIR，后续各节点均导入这份归档。
- Docker 格式通过 `manifest.json` 的 `Config` 定位配置内容，计算其 SHA256；OCI 格式沿 index → manifest → config 读取，并核验 blob 摘要，支持嵌套 index。登记和 `crictl inspecti` 比较的都是 config 摘要。因此 Docker inspect 返回 manifest/index 摘要时也不会误报不一致。
- 归档中有多个不同 config 时，在任何节点写操作前拒绝并提示导出单平台镜像。当前没有新增平台选择参数，目标节点需使用同一配置的镜像。本机 TMPDIR 必须容纳完整镜像归档；成功和失败均清理暂存目录。
- 在取得归档 config ID 后检查所有节点现有 tag；有冲突时仍须显式 `--replace`，全部预检通过才开始导入。与规格中的直接管道相比，此处先固定归档，再通过 SSH stdin 分发，以保证期望摘要与所有节点实际接收的字节一致。
- 中途失败时列出已经确认导入的节点，以及已改动或可能部分改动的节点（包含失败的当前节点）；导入、pin、核验、登记失败和 unpin 部分失败均有覆盖。提示用 `--unpin` 去掉 pin，或重跑分发，必要时使用 `--replace`。`--unpin` 不恢复旧 tag、不删除已导入内容，也不删除登记；要回滚替换，必须重新分发原镜像。未在失败路径自动回滚节点。
- 仍须所有目标节点核验成功后才更新 ConfigMap，并保留 resourceVersion 前置条件及其他登记。K2a 继续读取 `images.json` 的 `{ref: configDigest}`；无其他跨任务接口变更。

### 验证与断言

保留原测试场景和行为检查，增加：IPv6 ND 位于 cni0 drop 之前、forward established 位于首条、ARP 无需 inet 规则、单地址族不生成空 elements、缺少 Python 的明确错误、Pod CIDR 只出现在注释、systemd reload 关联及 fail-open 用法、Docker/OCI/嵌套 OCI 的真实 tar 和摘要、不同 Docker inspect ID、损坏/多配置归档拒绝、第二节点各写入阶段失败的恢复提示、登记/unpin 部分失败、暂存文件清理。

原 input 链连续匹配断言扩展为包含新增 ND 规则，仍检查完整先后次序。原“tag 冲突时尚未执行 docker save”的断言因现在必须从 save 读取 config ID，改为“tag 冲突时没有任何节点 import/label”；仍检查所有节点预检先于导入，且新增每次只 save 一次、各节点接收完全相同归档的断言。低磁盘场景仍断言不会执行 save。没有删除原测试场景。

本轮验证结果：

- `node --test tools/k8s-tools.test.mjs`：退出码 0。
- `node tools/k8s-tools.test.mjs`：为核对逐用例结果补跑，36 项中 35 通过、0 失败、1 跳过（真实 nft 检查），约 88 秒。
- `bash -n tools/k8s/node-guard.sh tools/k8s/distribute-image.sh`：退出码 0。
- 指定文件的空白检查通过；新示例仅使用文档保留地址和 example.com，无组织参数。当前五个实现文件原本处于未跟踪状态，因此另与修改前的本地副本比对，未依赖空的 git diff 判断修改范围。
- 本机 Node 为 v22.22.1；规格目标环境 Node 24 的检查及真实集群验证由协调者完成。本轮未运行全仓 check.sh。

真实 nft 检查保留为协调者显式启用的测试：

```sh
WORKPARTNER_TEST_NFT_CHECK=1 node --test tools/k8s-tools.test.mjs
```

该用例覆盖纯 IPv4、纯 IPv6、双栈，仅调用 `nft -c -f`；缺少 nft 或 netlink 权限时明确 skip。本轮默认测试全部 nft/ctr 行为由假命令实现。

systemd 模板的依赖关系通过文本断言验证。本机尝试 `systemd-analyze verify` 时，沙箱拒绝 SO_PASSRIGHTS/SO_PASSCRED socket 操作，命令返回 1，不能据此确认实际 systemd 加载与 reload 联动；留待协调者在宿主验证。

### K8 / S12 待实测

`--pod-cidr` 只记录在规则注释中，不参与任何匹配。规则按 cni0/隧道接口及节点目的地址工作，不以来源 CIDR 过滤，因此改 Pod 网段不会缩小规则作用范围；伪造来源地址仍受接口规则约束。

Pod 对节点本机地址的新连接，除 TCP 6443/10250 和 ND 等既定例外外，会在 input 被丢弃，已有 established/related 连接保留。模型出口不能依赖节点本机地址上的 SOCKS5 监听。k8s 网关访问 Docker 网关依赖 Docker iptables 在进入 input 前完成 DNAT，使流量以 Docker 容器地址走 forward；若走宿主监听/userland proxy，可能被 input 丢弃。由 K8 的 S12 在实际 CNI、Docker 和宿主规则组合下确认上述路径，以及去掉 NetworkPolicy 后兜底独立生效、双节点返回流量、IPv6 ND 与例外端口行为；本轮假命令测试不替代网络实测。

# T-1100 交付报告

已完成迁移前盘点、逐项对照表、switch 写入前门禁和 verify 核对。未联网，未连接真实 Docker 或集群，未执行 git 提交。

## 1. 扩展 inventory（JSON + 可读文本）

新增 `tools/k8s/adopt-inventory.mjs`，由 `adopt-user.mjs` 调用只读容器探针：

- 每个 passwd 用户的 crontab，以及 `/etc/crontab`、`/etc/cron.d`、`/var/spool/cron` 和 crontabs 子目录；逐条记录任务与环境设置，保留时间规则及 SHA-256 摘要。
- `/srv`、`/opt` 一级目录的名称、路径、KiB 大小、属主和 UID/GID。
- 进程可执行文件、PID、脱敏命令；TCP/UDP、IPv4/IPv6 监听端口。
- 各用户默认 tmux/screen 端点的会话名。
- passwd 家目录、运行时 HOME 和 `/data` 下指定点文件/目录的存在性及 lstat 大小，不打开凭据内容。
- 常见机器人配置命名及进程配置参数指向的文件路径，不打开配置内容。

进程和 cron 命令参数统一隐藏，环境变量值隐藏，原始命令不会离开容器。cron 文件拒绝末级符号链接。采集错误记录 issues 并阻止切换。保留原有 docker diff 与以 runtime.uid 复制普通可执行文件的行为。

`--apply` 在 `<ownersFile>.adopt/` 写 `<slug>.inventory.json` 与 `<slug>.inventory.txt`；新目录模式 0700，新文件模式 0600。dry-run 仅显示盘点计划和 docker diff，不执行新增探针或写报告。

## 2. 逐项对照表

生成同目录 `<slug>.decisions.json`。每项有 ID、说明用 source、decision、method、reason、target。`carried` 必须说明恢复方式，`dropped` 必须说明放弃原因；默认全部为空，自动复制的文件也须人工确认。

允许映射新目录/点文件路径、用户、端口、进程和会话等目标。每次有效启动新盘点都会先作废旧表，重新生成报告后使用新 inventoryId，清空决策，避免失败或中断后复用旧审批。

## 3. switch 强制核对

在创建操作锁之前验证表存在、JSON/版本有效、用户和 inventoryId 一致、表修改时间不早于报告、无采集异常、条目完整且不重复、决策和说明完整。拿锁后再次验证，随后才进入原切换流程。

缺表、旧表、空决策、缺少说明等均提示完成最新对照表。测试断言没有文件写入（含锁）、Docker update/stop、归属修改或 Kubernetes 生命周期写入。原有重复实例清理路径同样受此门禁约束。

## 4. verify 逐项核验

`verify --apply` 读取同一最新完整表，仅对 carried 项在 Pod 中执行只读检查：cron 条目摘要、目录类型、监听端口、点文件存在性、配置文件存在性、进程可执行文件、会话名，以及 docker diff 对应文件的存在/删除状态。

支持目标路径和端口等映射；当前用户 cron 使用 `crontab -l`，其他用户使用指定用户查询。缺失、不一致或无法读取都逐项输出 ALARM 并非零退出。cron 的可编辑文件目标仅允许标准 cron 路径，不能借此读取任意凭据文件。switch 成功启动 Pod 后仍自动调用 verify。

## 5. 测试与验证

新增 17 个用例，现有 100 个用例保留并适配完整表前置条件，总计 117 个。

覆盖报告持久化、多条 cron、`/srv` 服务和 `.gitconfig`、重盘点作废旧决策、十类不完整/过期表的零写入拒绝、锁内复查、采集失败阻断、carried 项逐项报警，以及实际序列化探针的脱敏/禁止读取凭据断言、目录与点文件映射、cron 摘要和 TCP/UDP 监听匹配。探针通过隔离 Node VM 和模拟文件/命令运行，无真实 Docker/集群调用。

验证结果：

- `node --test tools/k8s-adopt.test.mjs`：通过。
- `node tools/k8s-adopt.test.mjs`：117/117 通过（用于展开当前测试环境汇总隐藏的逐项结果）。
- 修改的两个实现模块 `node --check`：通过；`git diff --check`：通过。
- `env -u WORKPARTNER_TEST_IMAGE bash tools/check.sh`：未能完成。清除可选镜像变量以确保不执行真实 Docker；脚本通过前置语法检查后，在现有 `tools/wp-seed.test.py` 创建本地 HTTP socket 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`。失败与本次实现无关；没有更改 check.sh 或绕过其测试。日志位于 `/tmp/T-1100-check.log`。

## 6. 文档与 usage

已更新 `docs/kubernetes.md` K7 迁移步骤和阶段表，并同步 CLI usage：报告路径、填写示例、target 映射、重盘点作废规则、零写入门禁、verify 报警及权限要求。

文档明确检查边界：凭据不验证内容或登录有效性，目录大小不是数据完整性校验；机器人配置按常见命名和配置参数发现，自定义命名需人工补查；tmux/screen 自定义 socket 需人工补查；Pod 运行用户无权读取的 carried 项会报警。

## 改动范围

仅修改 `tools/k8s/adopt-user.mjs`、新增 `tools/k8s/adopt-inventory.mjs`、修改 `tools/k8s-adopt.test.mjs`、`docs/kubernetes.md` 和本报告。`adopt-state.mjs` 无需修改；未改 gateway、deploy、check.sh、package 文件，未添加依赖。保留任务目录原有 brief.md。

## 第 2 轮返工

已完成本轮 1 条必改及 7 条建议。以下内容更新前文对应行为；未联网、未执行 git 提交、未连接真实 Docker 或 Kubernetes 集群。

1. **缺表时允许继续验证（必改）**：`readDecisions` 增加仅针对对照表不存在的可选分支。verify 在缺表时跳过逐项检查，输出一条 `missing-pre-migration-inventory` ALARM，明确迁移前无对照表，要求人工核对 cron、服务目录、进程、监听端口、会话、凭据点文件、机器人配置及容器层补丁；其他检查照常运行，通过时退出码为 0，`inventoryVerified: false`。switch 仅在 k8s 归属、工作负载运行且 Docker 不活跃的幂等路径允许缺表，锁内及分支选择前重新确认；正常迁移及重复实例处理仍要求完整表。已有但损坏、过期、未填完的表继续失败，已有表但缺报告或悬空符号链接也继续失败。
   - 对应用例：`migrated verify/switch without inventory warns and completes remaining checks`，覆盖 dry-run/--apply、仅缺对照表/整个报告目录缺失共 8 个组合；`migrated verify/switch still rejects existing ... table` 共 12 个用例，每个同时验证 dry-run/--apply；`missing table does not hide passive verification failures`；`k8s ownership with stopped-pod/duplicate still requires a table before switch writes`。保留原正常 switch 缺表零写入用例。
2. **扫描范围、超时和 issue 确认（建议 1）**：配置发现从根深度 0 最多检查至第 4 层，不再列出边界目录内容；跳过 `/data/old-work`、`/proc`、`/sys`、`/dev`。`du -sk` 单次超时由 10 秒改为 60 秒。对照表新增 `issues: [{ issue, acknowledged: false, reason: "" }]`；每个报告 issue 必须逐条确认且理由非空，缺项、重复项、未知项、未确认或缺理由均不放行。inventory 有 issue 仍返回非零；人工确认完整后可继续 switch，重盘点清空确认。
   - 对应用例：`container config walk is bounded and excludes old-work, virtual filesystems and system homes`；两种 crontab 模式的 `container probe enumerates ...` 均断言 du 超时 60000；`inventory issue acknowledgment unacknowledged/no-reason/missing/duplicate/unknown/valid ... switch` 六个用例覆盖阻断、确认后完整切换及重新生成表时清空确认。
3. **单一用户 cron 来源（建议 2）**：有 crontab 工具时只查询用户 crontab，不读用户 spool；无工具时只读 spool，同一用户在两种 spool 目录布局中只选一份。系统 `/etc/crontab` 和 `/etc/cron.d` 继续独立盘点，verify 按记录来源核对。
   - 对应用例：`container probe enumerates ... (crontab tool: true/false)`，同时布置两份同用户 spool，断言工具模式完全不读取 spool、无工具模式仅读取一个文件；`verification probe compares every cron fingerprint and TCP/UDP listener, collecting all mismatches` 同时核对用户工具、用户 spool 和系统 cron。
4. **固定验证脚本与 stdin 最小数据（建议 3）**：verify 使用不随核对数据改变的 Node 脚本，从 stdin 读取 JSON；按种类仅发送 id、kind 及检查所需字段，映射目标在宿主端投影，原始报告、脱敏说明、method/reason 等不传入 Pod。启用 `strictOutput`。
   - 对应用例：`verification uses a fixed script and only required fields on stdin` 断言固定三段 argv、字段白名单及说明内容不泄漏；两个序列化验证脚本用例实际从模拟 fd 0 读取，覆盖映射、凭据元数据、cron 指纹和端口匹配。
5. **root 探针环境（建议 4）**：Docker root exec 增加 `--env NODE_OPTIONS=` 和 `--env PATH=/usr/sbin:/usr/bin:/sbin:/bin`。
   - 对应用例：共享 Docker fixture 对每次 inventory root 探针严格断言完整用户及环境参数；原可执行文件/符号链接用例继续验证复制探针使用 runtime.uid。
6. **权限和原子报告写入（建议 5）**：创建或复用报告目录后通过不跟随符号链接的目录句柄显式 chmod 0700；三个报告各用随机临时文件、`wx`、写入、显式 chmod 0600、sync、rename 发布并清理临时文件。已有报告符号链接被替换而不跟随，目录为符号链接时在作废旧表和容器探针之前拒绝。
   - 对应用例：`inventory publication tightens existing modes and replaces symlinks without touching their targets`；`inventory rejects a symlinked report directory before invalidating decisions or probing Docker`；`interrupted report publication keeps the previous file intact and removes temporary files`。覆盖已有宽权限、链接目标内容和模式保持、写入中断及临时文件清理。
7. **家目录过滤（建议 6）**：passwd 用户点文件仅在 UID≥1000 或家目录实际存在且为目录时盘点；配置 walk 的用户家目录根仅来自 UID≥1000 用户，系统用户家目录不作为 walk 根。运行时 HOME 和 `/data` 保留原有存在性条件。
   - 对应用例：`container config walk is bounded ...` 覆盖存在的 root/系统家目录元数据、无家目录的系统用户被跳过、普通用户不存在家目录仍记录点文件缺失，以及 `/root`、`/usr/sbin` 不进入配置 walk。
8. **锁内断言与文档（建议 7）**：`switch rechecks decisions under lock before lifecycle mutations` 增加 `failedStage === 'switch preflight: inventory decisions'` 断言。`docs/kubernetes.md` 明确 cron 原文只存整行 SHA-256 指纹（去除首尾空白），并同步以上缺表行为、issue 确认示例、扫描边界、权限、stdin 和环境约束；CLI usage 同步缺表例外与确认要求。

验证结果：

- `node --test tools/k8s-adopt.test.mjs`：通过。
- `node tools/k8s-adopt.test.mjs`：152/152 通过，较上一轮新增 35 个用例，并加强已有用例。展开日志为 `/tmp/T-1100-round2-tests.log`。
- `node --check tools/k8s/adopt-user.mjs`、`node --check tools/k8s/adopt-inventory.mjs`、`git diff --check`：通过。
- 本轮按指定验证范围执行，未重跑第一轮已记录沙箱限制的 `tools/check.sh`。

本轮仅修改两个 adopt 实现模块、`tools/k8s-adopt.test.mjs`、`docs/kubernetes.md` 和本报告；`adopt-state.mjs` 无需修改，未改 gateway/、deploy/、check.sh、package 文件，未增加依赖。

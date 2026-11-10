# T-1090 K2b 实施报告

## 第 2 轮返工（2026-11-10）

本 worktree 中没有上一轮 report.md，因此在指定路径新建本轮记录；没有修改已有 brief.md 或 r2.md。继续使用 T-1090-k8s-exec-files 分支。代码及测试只修改本轮指定的三个文件，另按验收要求写入本报告；没有更改依赖、check.sh、rollout.py 或其他 K 任务的实现。

### 改动与规格对应

对应执行规格 K2b 的 exec 参数映射、普通文件读取、cleanup 租约和路径安全要求，落实本轮八项意见：

1. `createK8sFiles` 新增可注入的 `leaseTtlMs`，缺省 30 分钟；只接受 1 至 2147483647 的整数毫秒值，避免零值、非有限值和 Node 定时器溢出。持有进程每 200ms 检查释放信号，到期通过保留的目录描述符清理暂存内容，删除控制目录，关闭描述符并退出。SIGTERM / SIGINT 同样清理控制目录。
2. 租约释放失败后，另发固定脚本请求，按原 cleanup 中的普通文件路径删除暂存内容，并在 finally 删除控制目录。路径仍逐段校验，不跟随符号链接；父目录已经不存在视为清理完成。补救失败也不会覆盖技能安装结果；租约最终标记为已释放，重复释放不再请求。
3. `timeout: 0` 和 `createTimeout: 0` 分别转换成 24 小时（86400000ms），常量注明其用途。非零参数及原缺省值保持原语义，符合 K1 只接受正 duration 的契约。
4. `removeFiles` 用 try/finally 将 Secret patch 与租约释放连接，即使 Secret 删除失败也释放暂存内容。`putFiles` 发布失败后的 release 及路径补救均不会覆盖原始错误；选择丢弃补救错误。
5. 保留主容器缺省名称 `workspace`，增加缺省路由用例。
6. 测试中的示例服务地址改为 `gateway.test` 和 `workspace.test`，现有发布配置断言同步更新。
7. Docker 的 `readFile` 直接读取文件，没有现成大小上限。本实现将普通文件读取的 `maxOutputBytes` 设为 16 MiB，范围包含 base64、JSON 和其他 exec 输出，实际可读原始文件略小于 12 MiB；超限由 K1 拒绝，错误原样传播。此上限保护网关接收输出，不限制容器内 Node 读取文件时的内存占用。
8. 普通文件读取遇到目录返回 `EISDIR`；其他非普通文件仍返回 `EINVAL`。原目录读取断言改为检查 `EISDIR`，保持 Docker 兼容性。

### 测试

原 18 条用例保留，新增 9 条，共 27 条；没有删除原断言。域名和目录错误码断言按本轮要求更新。

新增覆盖：

- exec / execNamed 的两个零超时选项分别及同时映射为 24 小时，注入客户端检查正整数契约。
- 缺省用户 Pod 路由使用 `workspace` 主容器。
- 普通文件小内容可读、16 MiB 输出参数传递、真实大文件编码输出超限，以及 K1 错误对象保留。
- 租约缺省 30 分钟，以及无效、无限和溢出存活时间的拒绝。
- 无网关释放时实际持有进程自动到期，暂存父目录改名后仍清理原文件，删除控制目录并退出；到期后调用 removeFiles 仍成功。
- 实际 SIGKILL 持有进程后，技能安装结果仍成功、暂存文件及控制目录被删除，重复释放没有请求。
- 释放传输失败后路径补救拒绝符号链接父目录，外部哨兵文件保留，控制目录删除；补救失败不抛出，仍存活的持有进程最终按 TTL 清理原暂存内容。
- Secret 删除失败仍清理租约，保留原始错误并标记已释放。
- Secret 发布失败，随后 release 和路径补救都失败时，仍抛出原始发布错误对象。

验证结果：

- `node --test tools/runtime-k8s-files.test.mjs`：退出码 0。当前环境报告器汇总为一个通过的测试文件。
- 为确认逐例结果，执行 `node tools/runtime-k8s-files.test.mjs`：27 tests / 27 pass / 0 fail / 0 skipped，退出码 0；日志 `/tmp/T-1090-focused-r2.log`。
- `env -u WORKPARTNER_TEST_IMAGE bash tools/check.sh`：退出码 1。此前 JavaScript 语法、Python AST 和 shell 语法阶段完成；既有 `tools/wp-seed.test.py` 创建本地 HTTPServer 套接字时遇到 `PermissionError: [Errno 1] Operation not permitted`，后续阶段未执行。日志 `/tmp/T-1090-check-r2.log`。需要协调者在允许本地套接字的环境补跑完整检查。
- `gateway/node_modules/ws` 已存在，本轮目标用例无需因缺失 ws 拆分到沙箱外执行。
- 本机 Node 为 v22.22.1；规格目标 Node 24 仍需在协调者环境验证。

### 对其他 K 任务的接口假设

- K1：继续调用规格中的 `client.exec(ns, pod, container, cmd, { stdin, timeoutMs, connectTimeoutMs, maxOutputBytes })`。duration 必须为正值，输出超限抛错；本 worktree 未包含 kube-client.mjs，使用注入客户端验证契约，没有修改或实际联调 K1。
- K2a：用户 Pod 名为 `<containerPrefix><slug>-0`，主容器为 `workspace`，与本轮说明中的 k8s.mjs 一致。`execNamed` 继续使用系统命名空间和可选 systemContainer。
- K2a：`leaseTtlMs` 是 `createK8sFiles` 工厂的可选参数，现有装配不传时使用 30 分钟。本轮不扩展组织配置 schema；需要定制时由装配方传入。
- K4 / 运行镜像：容器提供 Node、Linux `/proc/self/fd`、`/data` 和可写 `/tmp`，进程以工作区用户执行；正常退出的孤儿进程由容器 PID 1 回收。

### 验证边界与剩余限制

未访问真实 Kubernetes 集群，未验证 WebSocket exec、容器 PID 1 回收或跨 Pod 生命周期；这些仍由集成验收覆盖。SIGKILL 后原目录描述符无法恢复，补救只能清理现路径；如果父目录改名、被替换为符号链接，或 Pod 不可达，可能残留原暂存内容。补救采取尽力清理，不覆盖安装结果；存活持有进程仍有 TTL 兜底。

开源卫生检查覆盖本轮代码、测试和报告：测试服务地址仅使用 `.test`，沿用的测试地址为 RFC 5737 保留值，没有添加组织身份、真实地址或节点名称。元数据中的 Kubernetes 标准标签键按规格保留；私有词表检查仍由协调者在仓库外执行。

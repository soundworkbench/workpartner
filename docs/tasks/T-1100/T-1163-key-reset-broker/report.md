# T-1163 完成报告

## 1. 文件变更

- 新增 `tools/key-reset-broker.mjs`：实现配置校验、固定 bootstrap 传输、串行轮询、独立策略与限额、PID 锁、持久化状态、恢复、结果重试、审计及命令行接口。
- 新增 `tools/key-reset/gateway-host.py`：实现主机时钟心跳、请求认领、策略复查、密钥暂存、摘要检查和幂等结果交付，并检查文件类型、符号链接、权限及属主。
- 新增 `tools/key-reset/key-store.py`：实现只读存储探测和摘要定位，仅通过配置的命令轮换，之后读取存储确认结果及字段变化。
- 新增 `tools/key-reset-broker.test.mjs`：使用真实 bootstrap、两个真实 helper、本地临时目录和虚构轮换程序，提供 27 项测试。
- 新增 `docs/key-reset.md`：提供配置说明、完整共享协议、故障含义、恢复操作、策略开关、SSH 连接复用及加固 systemd 示例。
- 修改 `docs/organization.md`：仅在 `myKey` 说明末尾增加一行运维文档链接。
- 新增本报告：记录验证结果、环境限制和实现取舍。

未修改 `gateway/`、`image/`、`feishu/`、工作流、`tools/check.sh` 或其他工具及测试；未安装依赖，未使用网络或 SSH，未执行分支切换、提交、stash 或历史修改。

## 2. 验证方法与实际结果

环境实际提供 Node `v22.22.1` 和 Python `3.14.4`。

| 命令或检查 | 实际结果 |
|---|---|
| `node --test tools/key-reset-broker.test.mjs` | 退出 0；当前沙箱的测试子进程输出按文件汇总，显示 `tests 1 / pass 1 / fail 0`。 |
| `node tools/key-reset-broker.test.mjs` | 退出 0；详细 TAP 输出为 `tests 27 / pass 27 / fail 0 / skipped 0`。 |
| `node --check tools/key-reset-broker.mjs` | 退出 0，无输出。 |
| `python3 -I -B` 配合 `ast.parse` 遍历 `tools/**/*.py` | 退出 0，输出 `All tools Python files parsed successfully`。 |
| `git diff --check` | 退出 0，无空白错误。 |
| 本地虚构配置下运行 `--check`、`--once`，再启动常驻进程并发送 SIGTERM | 三次退出码均为 0；`--check` 输出 `ok`；心跳存在；停止后 PID 文件消失；常驻进程 stdout/stderr 均为空。 |
| `git diff --numstat -- docs/organization.md` | 仅增加 1 行，删除 0 行。 |

覆盖范围包括：完整成功流程与字段保留、62 字符随机新值、属主与权限、密钥和子进程 argv 保密、策略全部拒绝分支及实时变化、持久化日限额与 started 上限、主机时钟的双向时间窗口、重放、恶意名称和大文件、缺失/重复/符号链接密钥、失败及不明确轮换、认领后和轮换后重启、交付重试、已交付但响应丢失、stuck 节流与恢复、请求撤回、存储不可用、目录创建、两人串行、进程锁、配置错误、传输超时和输出限制、检查模式、清理范围及停止行为。每个 helper 操作均通过 bootstrap 直接调用过。

沙箱限制与处理：

- 在 Node 内再次启动 Node 的诊断调用得到 `spawnSync /usr/bin/node EPERM`，因此进程锁测试改用真实存活的 Python 子进程，并从 shell 独立完成 Node CLI 与 SIGTERM 验证；没有跳过进程锁断言。
- 首次 CLI 冒烟脚本因包含 `rm -rf` 风格清理命令而被工具拒绝，整个脚本未执行；改为 Python 仅清理本次创建的临时目录后，完整冒烟检查成功。
- 属主设置和权限断言在本环境成功，未出现 `chown` 拒绝。
- 本环境没有运行 Node 24 或 Python 3.11 的版本矩阵，也没有运行需要其他系统工具的完整 `tools/check.sh`；未声称完成真实 SSH、上游服务或网关并行任务的集成部署。

## 3. 协调者需处理的事项与实现取舍

没有需要本任务修改范围外代码的阻塞项。请协调者提交这些变更，并在 CI 或对应运行环境补充 Node 24 / Python 3.11 版本验证；实际部署和网关半边的集成由相应任务处理。合并并行任务时，保留 `docs/organization.md` 的单一链接，避免重复。

现有 `.git/info/exclude` 排除了 `docs/tasks/`，所以本中文报告已写入工作区，但不会出现在普通 `git status` 中；协调者可直接读取，是否纳入提交按仓库约定处理。

本次对说明留有余地之处作了以下决定，并已在运维文档说明：

1. 与现有 `gateway/my-key.mjs` 的 `admitted()` 一致，`allow: ["*"]` 也要求用户记录具有非空 `unionId`；仅有 slug 的目录记录不能重置。
2. 存储不可用时，在写入 `seen` 之前暂停新请求处理；否则说明中的先写 seen、后保留未认领请求，会使连接恢复后的同一请求被错误判为 replay。
3. 日计数归属于开始调用 rotate 的 broker UTC 日期；该时间写入 inflight，重启后仍按同一天去重计数。
4. 存储查询或 inspect 失败时保持尝试未完成，不把无法证明安全的状态写成 `ok:false`；已知成功的结果不会被后续失败降级。
5. 若 finish 已删除远端 claimed，但响应丢失，仍扫描本地 inflight 恢复并确认交付，避免遗留本地状态。
6. 限定 `model.keyPrefix` 为安全的文件名前缀；组织文件损坏或前缀变化后，仍可按合法 slug/id 查找已有暂存文件以恢复或清理；运维期间应保持密钥路径和前缀稳定。
7. 轮换命令 stdout/stderr 直接丢弃到空设备，避免其打印的新值进入日志、临时文件或无界缓冲；审计只保留普通标识符形式的 drift 字段名及 `entries:false`，不保存字段值。
8. inflight 使用独占创建并在 rotate 前 fsync，使两个摘要只落在指定的 `inflight/<id>.json` 中；日计数使用原子替换，审计追加后 fsync。

运行假设是同一网关只有一个 broker，并持续使用同一本地状态目录；PID 锁防止共享该目录的第二进程启动。请勿通过另一份状态目录启动第二个 broker，也不要在未完成尝试存在时删除状态或暂存文件。

# T-1092 K4 第 2 轮返工报告

日期：2026-11-10。继续使用 `T-1092-init-hooks` 分支的现有 worktree，保留上一轮实现。本轮只修改三个获准的代码/测试文件，并按返工要求新增此报告；当前 worktree 原先没有 `report.md`。

## 本轮修改

1. **后台进程不阻塞启动（K4 要点 3）**：`wp-init-hooks.sh` 把每个钩子的 stdout/stderr 写入独立临时文件。钩子退出或超时后，读取文件当时的字节数，仅回放该长度的输出并添加原有前缀，然后删除文件。既不等待后台进程关闭输出描述符，也不无限追随后台进程的新输出。保留不带换行的输出、退出状态告警和后续钩子的执行。
   - `timeout --foreground --kill-after=5s 60s` 只向钩子 shell 发信号，避免终止用户留下的后台服务；60 秒限时及不响应 TERM 时的 5 秒强杀宽限保持不变。
   - 日志在钩子退出后回放；后台进程在快照之后写出的内容不再回放，长期运行的服务需要自行管理日志。
2. **发布文件集合（K4 要点 1）**：集合改为三个缺省名加发布目录中实际存在的安全、非隐藏普通文件。允许 Secret 投影中指向普通文件的符号链接；跳过额外隐藏文件、投影元数据、目录、FIFO、断链以及不安全文件名。三个缺省名即使尚无 Secret 内容也先建立链接。
3. **链接失败后继续启动（K4 要点 1、3、4）**：创建临时目录或建立/替换单个链接失败时，向 stderr 输出带文件名的告警，清理已创建的临时链接和目录，继续处理其他文件。替换仍使用临时链接加 `mv -fT`，失败时保留原目标目录及其内容。`start.sh` 不再因 `wp_init_hooks` 的返回值执行 `exit 1`。
4. **保留钩子环境（K4 要点 3）**：移除函数内的 `local LC_ALL=C`，仅对 `sort -z` 设置 `LC_ALL=C`。使用 NUL 分隔排序结果，钩子和调用方仍收到原来的 locale。

未设置或设置空的 `WORKPARTNER_PUBLISHED_DIR` 时不操作发布链接；没有 `.zp-init.d` 时直接返回，保持 PATH、shell 选项和已有文件不变。原有服务 PID 监督逻辑保持，辅助进程退出不会终止入口。

## 测试

保留原有 12 条测试的行为覆盖；按本轮要求调整额外隐藏文件、链接失败返回值的预期。超时测试保留原来的终止输出、124/137 状态、后续执行及未执行尾部代码的断言；后台进程改为由测试清理，不由钩子执行器终止。

新增 7 条测试，总计 19 条：

- `test_extra_published_names_are_safe_and_projected_regular_files_are_linked`：安全文件名、非法字符、隐藏文件、Secret 投影链接、断链和 FIFO 的筛选。
- `test_temporary_link_directory_failure_warns_and_continues`：临时目录创建失败时带文件名告警，保留原文件并继续其余链接及启动。
- `test_inherited_background_output_does_not_delay_later_hooks`：`sleep 30 &` 继承输出，限时替身设置为 1 秒；整个调用 4 秒内返回，后续钩子执行，后台进程仍存活，输出临时文件已删除。
- `test_nohup_background_service_does_not_delay_later_hooks`：`nohup sleep 30 >/dev/null 2>&1 &`，同样检查及时返回、后续执行、后台存活和临时文件清理。
- `test_timeout_preserves_background_service_and_continues`：钩子忽略 TERM 并被强杀后，后台 `sleep` 仍存活，后续钩子及启动继续。
- `test_hook_locale_is_preserved_while_sorting_in_c_order`：外部 `LC_ALL=C.UTF-8` 原样传给钩子并保留在调用方，钩子按 C 字典序执行。
- `test_startup_continues_after_published_link_failure`：通过完整入口的离线替身验证链接冲突告警、原目录保留、临时链接清理、其余链接成功，以及 AionUi、bridge、relay 全部启动。

测试为调用 shell 创建独立进程组；无论断言失败、超时还是成功，清理阶段都会终止测试留下的后台进程。

验证结果：

- `python3 -I -B image/tests/init-hooks.test.py`：19 条通过，6.028 秒。
- `python3 -I -B image/tests/image-inputs.test.py`：4 条通过，0.172 秒。
- `bash -n image/bin/*.sh`：通过；另逐一对 `image/bin/*.sh` 执行 `bash -n`，全部通过（单次调用不会检查作为额外参数传入的所有脚本）。
- `git diff --check`：通过。
- 未新增依赖，未修改 `tools/check.sh`、package 文件或 `tools/rollout.py`；本轮新增内容只使用临时路径和通用测试值。

按本轮安排，完整 `bash tools/check.sh` 留给协调者在沙箱外执行；沙箱内 wp-seed socket 权限失败为已知限制，本轮未重跑整套。真实集群挂载、Pod 启动及服务行为仍需集群验收。

## 对 K2a 的接口假设

- K2a 将发布 Secret 作为目录只读挂载，并把挂载目录的绝对路径写入 `WORKPARTNER_PUBLISHED_DIR`，对应 `runtime.k8s.publishedDirectory`。不通过 subPath 挂载单个发布文件，以便既有链接跟随 Secret 轮换。
- 镜像不读取组织配置中的 `runtime.k8s.publishedFiles`；额外文件靠启动时扫描该发布目录发现。新增名字在下一次启动时创建链接，已链接的名字随后随投影更新读取新内容。
- 三个固定缺省名为 `.zp-market-token`、`.wp-feishu-cli.json`、`.zp-preview-relay-key`，允许以点开头并在内容尚未发布时预建链接。
- 额外发布文件名必须匹配 `[A-Za-z0-9._-]+`，不得以点开头，不含 `/`，不能是 `.` 或 `..`。只有普通文件或解析为普通文件的投影符号链接参与链接；额外隐藏文件即使列在组织配置中也不会自动链接。
- Secret 目录中可以包含 `..data`、时间戳目录等以点开头的投影元数据，扫描会排除这些条目。
- `/data` 由 K2a 的卷和属主初始化提供。若某个目标与现有目录冲突或不能替换，镜像保留原内容、告警并继续启动，不因该项链接失败退出。

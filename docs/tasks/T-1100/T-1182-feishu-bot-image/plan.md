# T-1182 实施计划

目标：按任务消息中的 JSON 契约提供机器人信息、局部重启与自动拉起，不改网关、不提交 git。

实现选择：新增 Python 标准库脚本同时承载 info、restart 和内部 supervise 入口；start.sh 启动守护进程且不加入 service_pids。FIFO 接收重启（无读端即 no_supervisor），子进程独立进程组便于 TERM 清理；日志原样转发，状态仅存枚举和时间。默认目录 /data/.cc-connect，WP_CC_CONNECT_DIR 可重定向到测试临时目录。多 projects 共用一个 cc-connect 进程及其连接事件，本次不推断每个机器人的独立连接。

- [x] 先写并运行 info 调用级测试：字段、空配置、坏配置、多 projects、缓存/刷新、错误、头像大小、期限、在线分支及无密钥输出。
- [x] 实现 info：tomllib、urllib、原子 600 缓存、10 分钟有效期、总时限。
- [x] 先写并运行守护测试：迟到配置、事件白名单、PID 变化、崩溃退避、TERM 清理、无守护时 restart 失败。
- [x] 实现 supervise 并接入 start.sh：3 秒配置轮询，2/4/8…60 秒退避，稳定 300 秒重置，首次启动标记。
- [ ] 完整检查尚受 socket 禁令阻断；语法/权限/敏感字段审查、独立审查及重要问题修复已完成，结果已追加 report.md。

重点检查：损坏缓存/状态不能泄漏原文；超慢 HTTP 仍在 8 秒内输出；新一轮启动不能复用旧 connected；restart 在退避中也立即生效；TERM 收掉桥及其子进程。

# agent-baseline：助理基线钩子

这一套放 Claude Code 助理都该装的 PreToolUse 钩子，目前三个：

- `no-long-sleep.py`：拦会话里的长 sleep（单次超 60 秒、同一回合累计超 300 秒）。
- `no-blocking-foreground.py`：把会阻塞会话的前台调用自动转成后台，不再拒绝。Bash 的 timeout 超过 180000 毫秒、或命中顶部 `SLOW_PATTERNS` 表里的长命令（docker build、go test、npm install、pytest、ffmpeg、codex exec 等）、或 Agent/Task 明确写 `run_in_background: false`，在 `bypassPermissions` 模式下钩子返回 `permissionDecision=allow` 加 `updatedInput`（原输入加 `run_in_background: true`），并在 `additionalContext` 告诉模型已转后台、完成会通知、先回复用户。Claude Code 2.1.319 实测 Bash 与 Agent 都会真的变成后台。命令自带 `timeout N`（N 不超过 120 秒）视为有上限，不动。其他权限模式不改写，直接拒绝并提示加 `run_in_background: true`，避免悄悄跳过确认。钩子自己出错时放行。注意同一工具上若有别的钩子给出拒绝，拒绝优先。
- `no-repeat-poll.py`：防反复查进度。同一回合（自最近一条真正的用户消息起）里，对同一个后台任务的读取已有 2 次，第 3 次起拒绝，提示“完成会自动通知，先回复用户，不要再查”。读取包括 `TaskOutput`/`BashOutput` 工具，以及 Read 或 Bash（cat、tail 等）访问 `.../tasks/<任务号>.output`。transcript 里已有该任务的完成通知后，读取不拦。

原因：助理通过聊天与用户对话时，一轮里前台跑长命令、前台等子代理或反复查后台任务，用户这段时间收不到回复。改长命令规则只需改 `no-blocking-foreground.py` 顶部的表，并跑 `python3 hooks/test_no_blocking_foreground.py` 与 `python3 hooks/test_no_repeat_poll.py`。

安装：`./install.sh <目标 .claude 目录> <钩子目录在目标环境里的路径>`。脚本把钩子复制到 `<目标>/hooks/`，并在 `<目标>/settings.json` 里补 PreToolUse 条目；重复运行会跳过，改配置前备份为 `settings.json.bak-<日期>-noblock`，只增不改其他键。钩子在新回合自动生效，不用重启。

装进容器镜像：在 Dockerfile 或启动脚本里，对容器用户的 `~/.claude` 执行一次，例如 `install.sh /home/claude/.claude /home/claude/.claude/hooks`（路径写容器内看到的路径）。如果 `~/.claude` 是挂载卷，在宿主上对挂载目录执行，路径参数仍写容器内路径。镜像需要有 python3。


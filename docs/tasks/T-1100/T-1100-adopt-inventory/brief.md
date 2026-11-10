# T-1100 迁移前自动盘点：K7 inventory 扩展 + switch 前强制核对

## 背景
公开仓库，执行规格 docs/specs/2026-11-11-k8s-runtime.md（K7）。K7 已合入 tools/k8s/adopt-user.mjs、tools/k8s/adopt-state.mjs、测试 tools/k8s-adopt.test.mjs，用法见 docs/kubernetes.md。现在 inventory 只看 `docker diff` 和 /usr/local/bin 下的可执行文件。之前一次迁移只搬了工作目录，漏掉了容器里的定时任务、/srv 下自建的服务、git 推送登录等，旧容器停掉后服务中断，事后才发现。

## 要做的
1. inventory 子命令对旧容器增加盘点并写入报告（JSON + 可读文本）：
   - 每个用户的 crontab（含 /etc/cron.d、/var/spool/cron）；
   - /srv、/opt 下的一级目录（名称、大小、属主）；
   - 在跑进程（命令行脱敏：去掉形如密钥的参数值）和监听端口；
   - tmux / screen 会话名；
   - 家目录点文件是否存在：.gitconfig、.git-credentials、.config/gh、.ssh、.netrc（只记存在与否和大小，绝不读出内容）；
   - 机器人配置文件位置（只记路径）。
2. 生成对照表文件（放 adopt 状态目录下，按代号命名），每一项有 decision 字段：`carried`（已搬，写怎么搬的）/ `dropped`（不搬，必须写原因）/ 空。
3. switch 的前置检查：对照表不存在、比最近一次 inventory 旧、或有任何一项 decision 为空 → 在停 Docker 和任何写操作之前拒绝，提示先补完对照表。
4. verify 子命令增加逐项核对：对 decision=carried 的项，在新 Pod 里检查对应 crontab 条目、目录、端口监听、点文件存在；不一致列为报警。
5. 补用例：盘点能列出 /srv 服务、多条定时任务和 .gitconfig；对照表未标完时 switch 拒绝且没有任何写操作（不停 Docker）；carried 项在新 Pod 缺失时 verify 报警。
6. 同步更新 docs/kubernetes.md 迁移一节和 usage。

## 限制
- 只改 tools/k8s/adopt-user.mjs、tools/k8s/adopt-state.mjs（必要时新建 tools/k8s/adopt-inventory.mjs）、tools/k8s-adopt.test.mjs、docs/kubernetes.md 和任务目录 report.md。不改 gateway/、deploy/、check.sh、package 文件，不加依赖。
- 公开仓库：不写公司名、真实 IP、域名、主机名、人名；示例用 example.test、192.0.2.0/24。
- 盘点绝不读取或输出凭据内容。
- 不联网、不 git 提交、不真连集群或 Docker。

## 验证
node --test tools/k8s-adopt.test.mjs 全过；bash tools/check.sh 通过（跑不动写明原因）。任务目录 report.md 写交付报告，逐条对应上面 1–6。

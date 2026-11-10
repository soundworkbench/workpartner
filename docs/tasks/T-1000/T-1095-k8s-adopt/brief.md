## T-1095 K7 存量用户接管、切换、回滚和核对工具

仓库 soundworkbench/workpartner（本机 /root/build/notes/zp-gh/wp-src），分支 T-1095-k8s-adopt，基于 main。Node 24 环境（沙箱里是 Node 22，测试要兼容），不联网、没有集群和 Docker。
执行规格：docs/specs/2026-11-11-k8s-runtime.md，按「K7 存量用户接管、切换、回滚和核对工具」一节实现（子命令、步骤顺序、验收逐条照做）。名称规则、归属文件格式、配置项、K2a 运行时接口都以规格为准。

### 并行开发说明
- main 上已有：K1 gateway/runtime/kube-client.mjs、K2b gateway/runtime/k8s-exec.mjs 和 k8s-files.mjs、K4 镜像启动钩子。
- K2a（gateway/runtime/k8s.mjs，runtime/index.mjs 的 kind=k8s）、K3（gateway/migration.mjs 归属文件）、K5（tools/k8s/render.mjs 名称规则）还在别的分支返工，尚未合入。可以只读参考它们的 worktree：/root/build/notes/zp-gh/wp-src/.worktrees/T-1088-k8s-lifecycle、T-1091-migration-owner、T-1093-k8s-manifests（不要改那些目录）。
- 本工具只经规格里固定的接口调用 k8s 运行时和归属文件（运行时通过 createRuntime 注入，测试用假实现），不要复制那些模块的代码。K2a 的 inspect 在规格之外新增了 `replicas`（无则 null）和 `annotations`（无则 {}）两个字段，可以使用。
- 归属文件写入用临时文件 + rename 原子替换。

### 约束
- 只新增 tools/k8s/adopt-user.mjs、tools/k8s-adopt.test.mjs（需要的话可加 tools/k8s/adopt-*.mjs 辅助模块）；不改其他文件，不改 check.sh、package 文件、rollout.py，不新增依赖。
- 默认 dry-run，`--apply` 才写；dry-run 不发任何写操作。docker 调用经可注入的命令执行器，测试用假 docker。
- 公开仓库：不得出现公司名、人名、真实 IP、域名、主机名；测试域名用 *.test，地址用 192.0.2.0/24。

### 验收
- 规格 K7 节「验收」逐条有用例：步骤顺序（断言调用序列）、中途失败停在安全状态并在日志说明下一步、dry-run 无写操作、status 三类报警及非零退出码。
- `node --test tools/k8s-adopt.test.mjs` 全过。
- 报告写到 docs/tasks/T-1000/T-1095-k8s-adopt/report.md：实现了什么、对应规格哪几条、测试清单、沙箱无法验证的点、对 K2a/K3/K5 接口的假设。

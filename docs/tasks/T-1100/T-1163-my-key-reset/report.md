# T-1163 我的钥匙重置报告

## 1. 修改文件

- `gateway/runtime/k8s.mjs`：新增受 `exclusive` 保护的 `rekey(slug)`，仅更新已有模型 Secret，Secret 不存在时不创建，不修改 StatefulSet 或 Pod。
- `gateway/migration.mjs`：将 `rekey` 加入 runtime 写操作的归属检查集合。
- `tools/runtime-k8s.test.mjs`：验证 Secret 内容按文件原始字节更新、缺失时不创建以及没有其他资源写入。
- `gateway/my-key-reset.mjs`：实现文件协议、实时策略、每日计数、请求排他创建、跨进程驱动锁、启动恢复、原 inode 安装、无限重试、审计及过期文件清理。
- `gateway/my-key.mjs`：复用身份、策略及上游访问逻辑，增加重置状态和 POST/GET 路由，并接受 runtime、钥匙文件、回调及计时依赖。
- `gateway/gateway.mjs`：仅调整依赖接线，传入现有 runtime、钥匙文件路径以及重启后的缓存清理回调。
- `gateway/tests/my-key-reset.test.mjs`：新增 17 项测试，覆盖门禁、策略、协议、失效旧钥匙、同 inode 安装、计数、并发、恢复、重试和保密，并用两个独立 Node 进程验证恢复排他性。
- `gateway/tests/my-key.test.mjs`：增加既有 GET 返回 `reset: null` 和完整顶层字段集合的断言。
- `gateway/my-key-client.mjs`：增加危险样式按钮、内联确认、禁用原因、轮询、成功和失败文案、关闭与恢复行为，以及中英文注意事项。
- `tools/browser-tests/lib/harness.mjs`：增加按测试运行隔离的文件协议 broker 替身、可轮换的模型服务及幂等关闭，支持成功、失败、离线和不领取请求。
- `tools/browser-tests/my-key.e2e.mjs`：增加真实网关重置流程、取消、双击、错误状态、语言、轮询生命周期、窄屏布局与指定截图用例，并保留原有用量字段保护断言。
- `gateway/organization/default.json`：增加默认关闭的 `myKey.reset` 配置。
- `tools/organization-resolve.test.mjs`：仅调整受新增默认值影响的两处完整配置比较。
- `docs/organization.md`：说明配置、文件协议、计数、恢复和运维边界。
- `docs/tasks/T-1100/T-1163-my-key-reset/report.md`：记录本次实现、验证结果和协调事项。

未修改 Docker runtime、其他网关模块、工作流、依赖或镜像文件；未创建真实 broker 或 `tools/key-reset/` 下的文件；未提交或改变分支历史。

## 2. 验证

- 对所有 12 个新增或修改的 `.mjs` 文件执行 `node --check <文件>`：全部通过；默认配置也通过 `JSON.parse` 检查。
- `node --test gateway/tests/my-key-reset.test.mjs tools/runtime-k8s.test.mjs`：两个文件全部通过，共 17 项重置测试和 34 项 runtime 测试。
- `node --test gateway/tests/my-key.test.mjs gateway/tests/my-key-reset.test.mjs tools/runtime-k8s.test.mjs`：重置及 runtime 文件通过，原有 My key 文件失败；单独执行原有文件确认 13 项需要监听 HTTP 的测试均报 `listen EPERM: operation not permitted 127.0.0.1`，其余 11 项通过。
- `node gateway/tests/my-key-reset.test.mjs`：实现过程中直接运行通过；测试直接调用公开 handler，以内存 HTTP 流模拟上游，并直接写入 broker 协议文件，因此不需要监听端口；测试等待均使用短间隔。
- `node --test --test-name-pattern='my key defaults' tools/organization-resolve.test.mjs`：新增默认值相关断言通过。
- 额外执行 `node tools/organization-resolve.test.mjs`：9 项通过，既有的启动脚本环境导出测试失败，子进程返回码为 0 但 stdout 为空，未得到期望的虚构模型名称；独立复现亦得到空 stdout/stderr，未改动该测试或启动脚本，原因尚未确定。
- `git diff --check`：通过。

遵守环境约束，未安装依赖、未访问网络、未启动浏览器、未运行整个 `tools/check.sh`。浏览器断言和截图仅已编写，尚未执行或生成。新增单元测试验证了旧钥匙在模拟上游返回 401、新钥匙可用、审计不包含钥匙以及重启回调顺序；真实 HTTP 和浏览器端结果仍需沙箱外确认。

## 3. 协调者需要处理的事项与实现决策

1. 在允许监听端口的环境重跑上述三个文件的联合测试，并执行 `node tools/browser-tests/run.mjs my-key`；该组包含要求的五个截图名称，截图调用前均保持遮罩状态。请同时复查原有启动脚本环境导出测试的空输出问题。
2. 合并并部署另一任务提供的真实 broker 后，验证其运行身份、目录所有者及共享协议；本任务没有上游轮换凭据，浏览器 harness 中的 broker 仅是测试替身。
3. 需求的 3.3 明确要求 `GET /_wp/api/my-key/reset` 返回状态，但验收列表又提到“GET on POST route 405”；实现选择遵循 3.3，GET reset 为状态接口，其他不支持的方法返回 405，GET reveal 仍返回 405。
4. 每 UTC 日最多接受 10 次尝试；第 11 次拒绝。完成次数独立按 ID 去重，最多 3 次。失败不消耗完成额度，接受后的准备失败仍保留尝试计数，以免失败路径绕过尝试限制。
5. `R/last` 按需求保存最近结果；额外的 gateway 私有目录 `R/days`、`R/progress`、`R/locks` 分别保存计数、安装进度及驱动锁，不改变双方共享的请求或结果结构，也不保存钥匙。清理在启动、接受请求前及每分钟执行，目录和记录沿用 0700/0600 权限。
6. 跨进程锁通过发布非空目录及唯一进程所有者文件实现，并在 Linux 上核对进程启动时间，避免 PID 重用；共享状态目录的多个网关进程必须位于同一主机 PID 命名空间。测试包含两个独立进程同时恢复以及遗留死进程锁的回收。
7. 正常完成、并发处理和同进程重试只重启一次，持久化进度也避免已记录阶段重复执行；但现有 `restart(slug)` 无幂等操作 ID，若进程恰好在重启成功之后、进度持久化之前崩溃，恢复可能再次重启。跨该崩溃窗口严格保证“恰好一次”需要扩展 runtime 的幂等重启或可核验重启代次，超出本任务允许仅增加 `rekey` 的范围；当前优先保证上游轮换成功后持续完成安装，不回滚、不遗失新钥匙。
8. 计时参数通过 `timing` 对象注入，定时器通过 `timers.setTimeout/clearTimeout` 注入；生产值沿用需求默认值。额外的 `handle.close()` 用于测试回收后台任务，不删除待恢复的协议文件。

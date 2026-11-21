# T-1360（网关部分）档位 ConfigMap 以 organization.json 当前内容为准，不再被网关用启动时的旧配置覆盖

## 目标
外部程序（自动升降档 wp-autoscale）把某人的 `tier` 写进生产 `organization.json` 并更新 `<container>-tier` ConfigMap 后，网关下一次 ensure 不会再把它改回网关启动时读到的旧档位；不需要重启网关。

## 背景
- T-1351（PR #131，已合并到 main，未上线）给每人加了 `<container>-tier` ConfigMap：`gateway/runtime/k8s.mjs` 的 `syncTier()` 用 `taskTier(o.userResources?.[slug])` 渲染 `tier.json`，`ensureTier(slug)` 在 `gateway/aionui.mjs` 的 `resolveUpstream()` 里每次请求/后台巡检都会调用。
- `o.userResources` 来自网关启动时 `gateway/organization/resolve.mjs` 的 `organizationData()` 读到的 `organization.json`（目录 `WORKPARTNER_ORG_DIR`），之后不再重读。
- 自动升降档程序（另一个仓库 it-agents 的 `ops/wp-autoscale`）升档时会先把 `runtime.k8s.userResources[slug].tier` 写进同一份 `organization.json`（原子写、canonical JSON），再直接改这个 ConfigMap。结果网关很快又按启动时的旧值把 ConfigMap 改回去，档位不生效。`docs/organization.md` 里现在写的是「外部控制器必须和网关加载的配置一致，否则下次 ensure 会恢复」，这正是要消除的问题。
- 定下来的做法：`organization.json` 是档位唯一来源，两边都从它派生 ConfigMap；网关只对档位三项（`tier`、`tasks`、`taskMemoryMiB`）做热读取，内存/处理器等其他配置仍然只在启动时读取（不改）。

## 要做的事
1. 网关在 `syncTier` 计算某人档位时，读取 `organization.json` 的当前内容里 `runtime.k8s.userResources[slug]` 的三项档位字段，经现有 `taskTier()` 规范化后渲染。没设置 `WORKPARTNER_ORG_DIR`（默认组织）时保持现状用启动配置。
2. 读文件要便宜：按文件 mtime+size（或 inode）缓存解析结果，未变化不重复解析；多个用户同时 ensure 不重复读。
3. 文件读不到、JSON 解析失败、结构不对时：沿用上一次成功读取的结果（首次失败则用启动时配置），只打一次警告（同一错误不刷屏），绝不因此把任何人降成 standard。
4. 某人条目在新文件里没有档位字段：按现有规则视为 standard（与启动时行为一致）。
5. 更新 `docs/organization.md`、`docs/kubernetes.md` 中「Organization configuration is loaded at gateway startup … external tier controller must keep … consistent」相关描述：改为档位三项按文件当前内容热生效、其余配置仍需重启。
6. 补测试（`tools/runtime-k8s.test.mjs` 或新测试文件）：
   - 启动后改写 organization.json 把某人从 standard 改为 open，下一次 `ensureTier` 写出 `{"tier":"open","tasks":5,"taskMemoryMiB":1024}`；
   - 外部已把 ConfigMap 改成 open 且文件也是 open 时，`ensureTier` 不再发 patch；
   - 文件改坏（非法 JSON）时保持上一次的档位，不 patch 成 standard，警告只出一次；
   - 文件未变化时不重复读取解析（可用计数或注入的读函数断言）。

## 范围
- 可以改：`gateway/runtime/k8s.mjs`、`gateway/runtime/index.mjs`、`gateway/organization/resolve.mjs`、`gateway/organization/resolve.d.mts`、`docs/organization.md`、`docs/kubernetes.md`、`tools/runtime-k8s.test.mjs`、`tools/organization-resolve.test.mjs`、新增的测试文件。
- 不要改：镜像 `image/`、RBAC、其他网关逻辑。确实需要改时在汇报里说明原因。

## 验收标准
- [ ] `node --test tools/runtime-k8s.test.mjs tools/organization-resolve.test.mjs` 全过（含上面 4 个新用例）。
- [ ] `node --test tools/k8s-render.test.mjs` 仍通过。
- [ ] 能跑的话跑 `tools/check.sh`；沙箱 socket 限制导致跑不了的部分在汇报里说明哪几项没跑。

## 约束
- 不要 git 提交。本机 workspace-write 禁网；需要新依赖在汇报里列出，不要自己装（本任务不应需要新依赖）。
- 只写必要的注释。测试要测行为，断言具体期望值。
- 不要读取任何真实生产配置或凭据文件；测试只用临时目录里的假 organization.json。

## 汇报格式
报告写到 `task-paths report T-1360-tier-hot-reload` 算出的路径；中文：1) 改了哪些文件各一句；2) 验证命令和结果；3) 需要协调者处理的事。

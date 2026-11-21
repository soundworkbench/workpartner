# T-1360-tier-hot-reload

1. 修改文件

- `gateway/runtime/k8s.mjs`：按 organization.json 的文件签名缓存当前档位三项，读取失败沿用上次成功结果并去重告警；内存和处理器资源仍使用启动配置。
- `gateway/runtime/index.mjs`、`gateway/organization/resolve.mjs`、`gateway/organization/resolve.d.mts`：把挂载组织文件路径从 resolver 传入 Kubernetes runtime，并保持该路径不进入配置 JSON 序列化结果。
- `tools/runtime-k8s.test.mjs`：新增档位热更新、外部 ConfigMap 一致时不 patch、非法 JSON 保留档位且告警一次、未变化文件只解析一次四项测试。
- `docs/organization.md`、`docs/kubernetes.md`：说明档位三项按 organization.json 当前内容热生效，其他组织配置仍需重启。

2. 验证命令和结果

- `node --test tools/runtime-k8s.test.mjs`：通过。
- `node --test tools/k8s-render.test.mjs`：通过。
- `node --test tools/runtime-k8s.test.mjs tools/organization-resolve.test.mjs`：runtime 测试通过；organization 测试的既有子进程用例因沙箱禁止 `spawnSync('bash')`（EPERM）失败，单独运行时其余 11 项通过。
- `node --check gateway/runtime/k8s.mjs && node --check gateway/runtime/index.mjs && node --check gateway/organization/resolve.mjs`：通过。
- `git diff --check`：通过。
- `bash tools/check.sh`：因沙箱禁止 Python 测试创建本地 socket（Operation not permitted）失败，未进入后续检查。

3. 需要协调者处理的事

- 在允许子进程和本地 socket 的环境重新运行组合测试及 `tools/check.sh`，确认沙箱限制之外的检查结果。

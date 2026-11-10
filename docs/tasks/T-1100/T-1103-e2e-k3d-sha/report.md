# T-1103 交付报告

## 根因

`ci-k3d.sh` 安装分支已经使用固定的 `K3D_SHA256` 校验二进制，但在此之前仍下载上游 `checksums.txt`，仅匹配无路径前缀的文件名并要求结果恰好一行。条目带路径前缀或重复时，该假设不成立，脚本提前报 `Missing or ambiguous k3d SHA256`，尚未执行二进制的固定摘要校验。

## 修改位置

- `tools/k8s/e2e/ci-k3d.sh:77–78`：删除原第 78–82 行下载、筛选、计数和比对上游 k3d 摘要的逻辑。下载二进制后直接以环境变量 `K3D_SHA256` 执行 `sha256sum --check --strict -`。第 66–67 行的非空和格式检查、第 71–76 行的 kubectl 固定校验均保留；两个二进制校验成功后才安装。
- `.github/workflows/e2e-k3d.yml:31–38`：第一个步骤检查 `external_probe`，早于 checkout、Node 安装和工具下载。格式错误、空值、空白、路径、多余冒号、非数字端口或端口超出 1–65535 均失败，英文错误明确要求 `host:port` 并提供任务指定的文档地址示例。用户输入继续通过环境变量读取。原运行目录环境变量设置合并到此步骤。
- `tools/k8s/e2e/tests/ci-adapters.test.mjs:41,65,81–106,181–207`：离线 curl 替身在请求 k3d checksum 文件时失败，确保正常安装无需该文件；本地假二进制使用真实 SHA256 运算，覆盖匹配成功、固定摘要不匹配、二进制损坏、摘要为空或格式错误，失败时断言两个工具均未安装。直接执行工作流第一个 shell 步骤，验证非法探针报错及有效端口边界。
- `tools/k8s/e2e/tests/index.js:1–2`：增加目录测试入口。当前 Node 22 原先将指定测试目录作为模块解析并报 `MODULE_NOT_FOUND`；入口加载现有测试文件，使任务指定的目录命令可以直接运行。

## 测试输出摘要

- 已先运行失败回归：旧安装逻辑在上游 checksum 文件不可用时返回 22，匹配摘要的成功用例失败；旧工作流缺少首步输入检查，用例失败。修复后上述回归均通过。
- `node --test tools/k8s/e2e/tests/`：退出 **0**，目录测试入口通过，失败 0、跳过 0。日志：`/tmp/T-1103-tests.log`。
- `node --test --experimental-test-isolation=none tools/k8s/e2e/tests/ci-adapters.test.mjs`：退出 **0**，展开结果为 **22/22 通过，0 失败，0 跳过**。日志：`/tmp/T-1103-tests-detailed.log`。该诊断选项在当前 Node 版本中不支持目录导入，因此逐例输出使用显式测试文件；上面的标准目录命令已单独通过。
- `bash -n tools/k8s/e2e/ci-k3d.sh`、测试文件 `node --check`、工作流 YAML 解析及全部 **11** 个 `run` 块的 `bash -n` 均通过。`git diff --check` 通过。
- 指定 actionlint Docker 命令实际执行后退出 **1**：`permission denied while trying to connect to the docker API`。沙箱不能访问 Docker daemon，未能运行 actionlint；**需协调者在允许访问 Docker 的环境补跑原命令并确认退出 0**。日志：`/tmp/T-1103-actionlint.log`。
- `bash tools/check.sh` 实际执行后退出 **1**：前置语法检查完成，既有 `tools/wp-seed.test.py` 的 `ModelDiscovery.test_model_permissions_are_read_with_an_identified_client` 在创建本地 HTTPServer socket 时被沙箱拒绝，报 `PermissionError: [Errno 1] Operation not permitted`。后续全库检查没有执行，未修改或跳过该测试；**需协调者在允许本地 socket 的环境补跑完整检查**。日志：`/tmp/T-1103-check.log`。

未运行真实集群端到端测试，未更改固定版本或摘要，未提交 git。新增示例只使用任务指定的文档地址，不包含实际环境标识。

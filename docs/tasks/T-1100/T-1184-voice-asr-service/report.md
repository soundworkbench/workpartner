# T-1184 语音识别服务实施报告

## 第 1 轮（2026-11-13）

### 1. 文件改动

- `asr/server.py`：新增标准库 HTTP 服务，模型启动时加载一次，提供 WAV 校验、带超时串行识别、低能量窗口切段、标签清理及仅含状态码/时长/耗时的日志，工厂函数可注入假识别器。
- `asr/requirements.txt`：固定两个 2.0.1 包及题述 amd64 wheel 的 SHA-256，不新增 numpy 或其他 Python 依赖。
- `asr/Dockerfile`：新增两阶段 Python 3.12 镜像，以 checksum 下载并仅解出六个模型文件，hash 校验安装依赖，以 UID 10001 运行并提供健康检查。
- `asr/tests/test_server.py`：新增 10 项真实 HTTP 行为测试，覆盖正常及别名 Content-Type、标签、413 不读体、非法音频、时长、忙时超时、静音切段及样本完整性、路由/方法、日志隐私和异常后锁释放。
- `asr/tests/smoke.sh`：提供镜像参数入口，在非 root、只读根文件系统、禁外网、2 CPU/2Gi 容器内等待健康，识别中文样例并断言「开放时间」，打印耗时，验证 413/415，退出清理容器。
- `deploy/k8s/asr.yaml.tmpl`：新增系统命名空间的单副本 Deployment、8080 ClusterIP Service 和只放同命名空间网关入站/拒绝全部出站的 NetworkPolicy，包含资源限制和安全设置。
- `tools/k8s/render.mjs`：增加默认关闭的 `runtime.k8s.deploy.asr` 配置，开启时校验并渲染镜像、hostname 节点选择和线程数。
- `tools/k8s-render.test.mjs`：增加改动前四种部署组合的 CLI 字节摘要回归，以及开启后的三个对象、字段和配置校验测试。
- `.github/workflows/asr-image.yml`：仅在 ASR 或本工作流相关 PR/main push 上执行单测、amd64 镜像构建和公共 smoke 脚本，不推送镜像。
- `docs/kubernetes.md`：补充用途、接口约定、配置、构建/分发/应用流程、离线策略、模型来源作者和 FunASR MODEL_LICENSE 1.1 归属说明。
- `docs/tasks/T-1100/T-1184-voice-asr-service/report.md`：追加本轮改动、验证证据与协调事项。

未修改 `gateway/`、`image/` 或其他工作流，未执行 git 提交。

### 2. 验证命令和结果

- `python3 -m unittest discover asr/tests`：已执行，但当前沙箱禁止创建 AF_INET socket；10 项均在启动测试 HTTP 服务时遭遇 `PermissionError: [Errno 1] Operation not permitted`，不能声称该验收命令通过。
- `bash tools/check.sh`：已执行，前置语法检查完成，随后既有 `tools/wp-seed.test.py` 的 HTTPServer 同样因 socket 权限失败而停止；日志为 `/tmp/t1184-check.log`，不是新增 ASR 代码导致的断言失败。
- `node --test tools/k8s-render.test.mjs`：退出码 0；直接运行 `node tools/k8s-render.test.mjs` 取得详细统计，66 tests、66 pass、0 fail、0 skipped（包含子用例）。
- 关闭开关的字节回归：在修改 renderer 前捕获 hostPort/clusterIP × selector/endpoint 四组完整 CLI 输出的 SHA-256；新增测试分别验证未配置和 `enabled: false` 两种情况，八次输出均匹配旧基线；开启时还断言旧对象完整保留，仅追加三个 ASR 对象。
- `PYTHONPATH="$PWD" python3 /tmp/t1184-http-memory-check.py`：补充验证 10 项全部通过；这个临时脚本只替换测试中的 socket/监听传输为内存字节流，仍经过真实 Handler 的 HTTP 解析与响应序列化，沿用原测试断言、假识别器和并发锁测试；413 的输入流禁止任何 body read。脚本未加入产品代码，也未改动正式 TCP 测试；该结果不替代真实 TCP 验收。
- `bash -n asr/tests/smoke.sh`、ASR Python 文件的 `ast.parse`、工作流的现有 PyYAML 解析、`git diff --check`：通过，没有安装本地依赖。
- Docker 构建及真实模型 smoke：按任务约束未执行；沙箱禁网，未下载模型或安装 sherpa-onnx，待 Actions 验证。

### 3. 需要协调者处理的事项

1. 推分支后核对 `ASR image` Actions：正式 TCP 单测、两阶段镜像构建、原生 sherpa-onnx 加载、只读运行、中文「开放时间」识别及 413/415 均需通过；本轮无法验证真实模型或声称 Actions 已成功。
2. 在允许本地 TCP socket 的环境重跑 `python3 -m unittest discover asr/tests` 和 `bash tools/check.sh`；当前环境的两条验收命令均被系统权限阻断，不能勾选全过。
3. 构建环境需要 BuildKit Dockerfile 1.7、Python 3.12 Linux amd64 镜像与题述两个 wheel，以及可访问 GitHub 模型包和 PyPI；这些是已指定的构建输入，无新增 Python 依赖。
4. 部署时填写 `runtime.k8s.deploy.asr.enabled/image/nodeName/threads`，核实 `srv2153109` 的 hostname 标签、可调度条件及资源，按文档先分发相同镜像引用再应用；T-1185 网关转发接口仍由下游任务实现。
5. 无需超出允许范围的代码改动；模型作者归属、原名和来源已写入文档，镜像保留原 LICENSE/README，协调者需核对 Actions 下载得到的模型及其许可文件。

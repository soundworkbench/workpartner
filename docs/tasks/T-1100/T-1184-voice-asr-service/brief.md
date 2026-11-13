# T-1184 语音识别服务（SenseVoice，集群内 CPU）

## 目标
在 k3s 集群里跑一个只给网关用的语音识别服务：收 16k 单声道 WAV，返回识别出的文字。用 sherpa-onnx + SenseVoice-Small int8，纯 CPU。下游任务 T-1185 的网关接口会转发到它。

## 背景
- 仓库现在没有任何附属服务镜像；网关、每人镜像之外的服务（如模型转发）由部署方另行提供（`docs/kubernetes.md` 约 155-167 行）。清单模板在 `deploy/k8s/*.yaml.tmpl`，由 `tools/k8s/render.mjs` 渲染；系统命名空间变量 `{{systemNamespace}}`，网关标签 `{{gatewayLabels}}`（见 `deploy/k8s/gateway.yaml.tmpl`）。
- 集群不用镜像仓库：`imagePullPolicy: Never`，镜像由 `tools/k8s/distribute-image.sh` 导入各节点。
- 选型已定（不要换）：
  - Python 包 `sherpa-onnx==2.0.1`，它只依赖 `sherpa-onnx-core==2.0.1`。PyPI 校验值：
    - `sherpa_onnx-2.0.1-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.whl` sha256 `c7780d8af6921c18e8e920376b32d7707294e5cd3838f4762cf746ab919bcc40`
    - `sherpa_onnx_core-2.0.1-py3-none-manylinux2014_x86_64.whl` sha256 `f4ee0ab91c4ae596e0e49d7de32522a946295e038a652f1c1884d89014ee4ec2`
  - 模型包 `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`，163002883 字节，sha256 `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`。包内有 `model.int8.onnx`、`tokens.txt`、`LICENSE`、`README.md`、`test_wavs/{zh,en,ja,ko,yue}.wav`。
  - 加载方式 `sherpa_onnx.OfflineRecognizer.from_sense_voice(model=..., tokens=..., num_threads=..., use_itn=True, language="auto")`。
- 模型许可是 FunASR MODEL_LICENSE 1.1：允许使用、复制、修改、分享，要求注明出处和作者、保留模型名。镜像里要保留模型自带的 LICENSE/README，文档里写明来源。
- 沙箱禁网，你本地装不了 sherpa-onnx、下不了模型；真模型识别交给 Actions 跑（见第 4 条）。本地单测用假识别器。

## 要做的事
1. 新增 `asr/server.py`（只用 Python 标准库 + sherpa_onnx，不加 numpy 以外的依赖；能不用 numpy 就不用）：
   - `ThreadingHTTPServer`，端口 `ASR_PORT`（默认 8080）。
   - `GET /healthz`：模型已加载返回 200 `{"ok":true}`。
   - `POST /v1/recognize`：请求体是 WAV。
     - Content-Type 必须是 `audio/wav`（也接受 `audio/x-wav`），否则 415。
     - 没有 Content-Length 或超过 `ASR_MAX_BYTES`（默认 2097152）返回 413，且不读完请求体。
     - 必须是 PCM 16 位、单声道、16000Hz，否则 400 `{"error":"bad_audio"}`；解析失败也是 400。
     - 时长超过 `ASR_MAX_SECONDS`（默认 60）返回 400 `{"error":"too_long"}`；短于 0.3 秒直接返回 `{"text":""}`。
     - 成功 200 `{"text":"...","seconds":<音频秒数>,"elapsedMs":<识别耗时>}`。
   - 识别器全进程只有一个，识别串行。用带超时的锁或信号量，等待超过 `ASR_QUEUE_TIMEOUT`（默认 10 秒）返回 503 `{"error":"busy"}`。
   - 超过 25 秒的音频分段识别再拼接。切点选在 25 秒边界前 5 秒内能量最低的 100ms 窗口，避免切在字中间。
   - 结果去掉 SenseVoice 可能带的 `<|...|>` 标签，首尾去空白。
   - 隐私：日志只记时长、耗时、状态码，不记音频，不记识别文字。
   - 其它路径 404，其它方法 405。
   - 识别器的创建要能替换（比如工厂函数参数或环境变量），方便单测注入假识别器。
   - 线程数 `ASR_THREADS`（默认 2），模型目录 `ASR_MODEL_DIR`。
2. 新增 `asr/Dockerfile`：
   - 两阶段。构建阶段用 `ADD --checksum=sha256:<上面的值> <模型包 URL>` 下载（Dockerfile 开头声明 `# syntax=docker/dockerfile:1.7`），只解出 `model.int8.onnx`、`tokens.txt`、`LICENSE`、`README.md`、`test_wavs/zh.wav`、`test_wavs/en.wav`。
   - 运行阶段基于 `python:3.12-slim`。pip 用 `--require-hashes` 和一个 requirements 文件，只装上面两个带校验值的包，加 `--only-binary=:all: --no-cache-dir`。
   - 非 root 用户运行，`HEALTHCHECK` 调 /healthz，暴露 8080。
3. 部署：
   - 新增 `deploy/k8s/asr.yaml.tmpl`，内容是 Deployment + Service + NetworkPolicy，放在系统命名空间。
   - 由 `tools/k8s/render.mjs` 渲染，但用一个配置开关（比如 `asr.enabled`，默认关），关的时候渲染结果与改动前完全一样。可配：镜像标签、节点名（nodeSelector `kubernetes.io/hostname`，生产填 srv2153109）、线程数。
   - Deployment 参数：
     - 副本 1，`imagePullPolicy: Never`；
     - requests 500m/1Gi，limits 2 核/2Gi；
     - readiness/liveness 都打 /healthz，initialDelay 要够模型加载；
     - `runAsNonRoot`、`readOnlyRootFilesystem`、`allowPrivilegeEscalation:false`、去掉全部 capabilities；
     - 不挂 ServiceAccount token。
   - Service 名 `wp-asr`，端口 8080。
   - NetworkPolicy：入站只放网关 Pod（用网关的标签选择器）的 8080；出站全拒（`policyTypes:[Ingress,Egress]`，egress 为空）。
   - `docs/kubernetes.md` 补一节：用途、开关、镜像构建和分发（`docker build -t ... asr/`，再走 distribute-image.sh）、模型来源和许可。
4. 测试：
   - `asr/tests/test_server.py`：标准库 unittest，用假识别器。覆盖下列情况：
     - 正常识别；
     - 标签清理；
     - 415、413（超大 Content-Length 时不读体）、400 bad_audio（立体声、8k、24 位）、too_long；
     - 短音频返回空；
     - 忙时 503（第一个请求占着锁、第二个超时）；
     - 分段切点落在低能量处（造一段中间有静音的信号，断言切点在静音窗口内）；
     - 404、405；
     - 日志里不出现识别文字。
   - 渲染测试：开关关时输出与改动前一致，开时包含三个对象且字段正确（NetworkPolicy 出站为空、nodeSelector、资源、Never）。放到现有渲染测试所在位置。
   - 新增 `.github/workflows/asr-image.yml`：
     - 触发：PR 和 push main，只在 `asr/**` 或本工作流改动时跑；
     - 跑单测；
     - `docker build`；
     - 起容器，等 healthz；
     - 用镜像里自带的 zh.wav POST 一次，断言返回文字含「开放时间」，并打印耗时；
     - 再测一次 413 和 415；
     - 不推送任何镜像。
   - 写一个 `asr/tests/smoke.sh`（工作流和协调者本机都调用它），参数是镜像名。

## 范围
- 可以改：新增 `asr/`、`deploy/k8s/asr.yaml.tmpl`、`tools/k8s/render.mjs` 及其测试、`docs/kubernetes.md`、新增 `.github/workflows/asr-image.yml`。
- 不要改：`gateway/`、`image/`、其它工作流（另一路任务在改 gateway 和 browser-tests.yml）。

## 验收标准
- [ ] `python3 -m unittest discover asr/tests` 全过。
- [ ] `bash tools/check.sh` 全过。
- [ ] 渲染开关关时 render 输出逐字节不变（测试证明）。
- [ ] Actions 的 asr-image 工作流能跑通真模型识别（你跑不了，写好即可，由协调者推分支后在 Actions 核对）。
- [ ] Dockerfile 所有下载都带校验值；镜像以非 root 运行。

## 约束
- 不要 git 提交。沙箱禁网，不新增依赖；需要时在汇报里列出。
- 注释少而必要，风格照仓库现有 Python/JS。
- 测试测行为：像调用方那样发 HTTP 请求，断言具体值。

## 汇报格式
报告写到 `docs/tasks/T-1100/T-1184-voice-asr-service/report.md`（各轮追加）。用中文：
1. 改了哪些文件，每个文件一句话。
2. 怎么验证的，命令和结果。
3. 需要协调者处理的事：依赖、超出范围的改动、没解决的问题。

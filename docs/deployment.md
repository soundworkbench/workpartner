# Deployment reference

The gateway is the only public entry point. Terminate TLS at your reverse proxy and forward requests and WebSocket upgrades to the gateway port selected by your organization configuration. Register the matching HTTPS callback with your identity provider.

Mount the organization directory read-only and select its container path with `WORKPARTNER_ORG_DIR`. Mount the configured state directory read-write and credential directory with the permissions required by the gateway. Keep application secrets and per-person model keys outside the repository. Never embed them into Docker layers or third-party download URLs.

Choose the runtime with `runtime.kind`: omitted or `"docker"` keeps the Docker deployment below; `"k8s"` uses a gateway Pod and one StatefulSet per workspace. For Kubernetes configuration, deployment order, image distribution, migration, rollback, probes and troubleshooting, follow the [Kubernetes operations guide](kubernetes.md). Kubernetes uses a ServiceAccount and does not mount the Docker socket. During migration, both gateways must read the same `runtime.migration.ownersFile` and configure `peerOrigin` for delegation; initialize ownership before accepting user traffic.

In Docker mode, the gateway needs Docker access to create each person's container and private network. Docker socket access grants host control; run the gateway only on a host dedicated to this workload. Host paths used when creating containers must refer to the host directories, even when the gateway sees them at different mount paths. Configure the data and credential host paths accordingly. Nonempty `HOST_PARTNER_DATA` and `HOST_PARTNER_SECURE` environment variables override `runtime.hostData` and `runtime.hostSecure`; otherwise the organization JSON values apply.

User containers persist `/data`, including the work directory. Their ports remain private. Allow access only from the gateway and to the configured model endpoint. Back up persistent user data and gateway state before changing images. Rebuilding the image does not replace the organization's configuration.

## Gateway hostname fields

These fields belong at the top level of `organization.json`. Nonempty environment variables override JSON; omitted or empty variables fall back to JSON. Hostnames use the existing validation: optional port, no scheme, path or credentials.

| JSON field | Environment override | Default and purpose |
| --- | --- | --- |
| `publicHost` | `PUBLIC_HOST` | Required public entry and login callback host, for example `workspace.example.com`. |
| `previewHost` | `PREVIEW_HOST` | Empty string; preview host, for example `preview.example.com`. Also requires `features.preview`. |
| `legacyHosts` | `OLD_HOSTS` | `[]`; array of hostname strings, for example `["old.example.com"]`. The environment override is comma-separated and trims whitespace. Each hostname is validated. |
| `projectHost` | `MEEGLE_HOST` | Empty string; project service host, for example `project.example.com`. |

With these fields in the mounted organization JSON, the rendered Kubernetes Deployment needs only `WORKPARTNER_ORG_DIR`; no manual hostname environment additions are required.

For Kubernetes model egress, set exactly one of `runtime.k8s.deploy.modelEgressSelector` (model or relay Pods) or `runtime.k8s.deploy.modelEgressEndpoint` (fixed IPv4/port, for example `{"address":"192.0.2.10","port":4100}`). The latter is only for external endpoints routable from Pods on every node, never an address local to any node, including Docker bridge addresses. It renders a selector-less Service, an EndpointSlice and a precise TCP egress allowance; RFC1918 addresses produce a warning without changing the manifests. For a Docker bridge service, pin a TCP relay Pod to the Docker node in the system namespace and select it with `modelEgressSelector`; the relay connects directly to the bridge's published port. Repeated bridge addresses across nodes and node-guard's INPUT filtering make a Service pointing directly at a bridge address unsuitable. See [model egress routing and the relay example](kubernetes.md#model-egress-routing). Model URLs continue to use the Service hostname and port. Gateway Pods accessing Docker services on the same node, including the migration peer, must also connect directly to the bridge's published port, without a Kubernetes Service pointing at that bridge address.

## Build inputs

`image/third-party.lock.json` contains an `artifacts` array. Every entry supplies `version`, a public `https` URL, the SHA-256 of the downloaded bytes, `destination`, and `format` (`file`, `tar`, or `tar-member`). Required destinations are `aionui-web`, `cc-connect`, `officecli`, `codex`, `codex-code-mode-host`, `claude`, `lark-skills.tar.gz`, and `meegle-skills.tar.gz`. The downloader fetches every input, including `cc-connect`, from its public URL and verifies its locked digest. Downloads are checked before extraction and the completed package directory appears only after all inputs pass. `image/build.sh` verifies the bridge again in `PKG` before creating a context or invoking Docker; missing or mismatched bytes stop the build.

`tar-member` selects exactly one regular file by its full archive path and writes it as the named executable. `tar` entries supply `stripComponents` and normally allow only regular files and directories. AionUi includes three symbolic links pointing at its upstream build machine. Its lock entry declares exact `symlinkReplacements` that rebuild these as relative links to extracted regular files inside the package. Unknown links, missing declared links, external targets and special files are rejected.

The image installs fixed npm versions of the official identity CLIs and exposes only the per-user wrappers; the gateway prepares `/data/.wp-feishu-cli.json` and the signed identity file it references. `WORKPARTNER_IDENTITY_CONFIG` can select that non-secret wrapper configuration. Those npm dependency graphs, like Playwright, are not yet completely SHA-256 locked.

The AionUi archive SHA-256 is different from a digest of an unpacked directory listing. Pin both at their respective download and build checks. A version string or an unchecked URL alone is insufficient. Obtain program releases from their maintainers; the downloader never reads private host package directories.

## Release checks

Run Linux checks before building an image. After building, run `WORKPARTNER_TEST_IMAGE=<image-tag> bash tools/check.sh` to check the certificate bundle and Python's loaded trust roots as the image's runtime user. The Dockerfile also checks both during the build. This offline check does not establish trust in your particular model endpoint: test a real HTTPS model request with certificate verification enabled. Test login, admission, WebSocket routing, logout, file persistence and both engines using your own deployment. Verify that one person's session cannot access another person's container. Tagging `v*` triggers tests, verified downloads, the image build and registry publication. Images built from third-party packages require a separate review of their license notices.

## Start an isolated preview

An administrator supplies a dedicated HTTPS hostname with its identity callback set to `https://<host>/_wp/callback`, an existing test application secret file, and existing test model keys. This guide does not create or rotate credentials. Use empty preview directories, and keep them separate from any running deployment.

Copy `org/default` to an external organization directory. Edit its `organization.json`: set `publicHost`, `identity.appId`, `model.baseUrl`, `runtime.nextImage` to `workpartner-user:local`, `runtime.hostData` to the absolute host preview data directory, and `runtime.hostSecure` to the absolute host preview secret directory. The default `runtime.nextDirectory` is `/workspaces`; create `<data>/workspaces`, `<data>/users`, `<data>/state`, `<data>/shared-skills`, and `<secrets>/aionui`, and put an empty JSON array in `<data>/users.json`. Give UID 1001 access to its user volumes. Store the existing identity secret at `<secrets>/identity-app.secret`. Place pre-created test model key files in `<secrets>/model-pool/*.key`; the gateway assigns one to each newly admitted test user. Do not use production keys or user lists.

Set `model.defaults.codex` and `model.defaults.claude` to available test models before building. With `ORG_DIR` set to the absolute host organization directory and `PKG` set to the verified build inputs, build the user image with that organization:

```sh
WORKPARTNER_ORG_DIR="$ORG_DIR" sh image/build.sh workpartner-user:local
WORKPARTNER_TEST_IMAGE=workpartner-user:local bash tools/check.sh
```

The gateway supplies current model defaults and the catalog from its mounted organization; the image organization is only a fallback. After this version is initially deployed, changing model configuration replaces idle personal containers without another image build. Refresh the page after replacement. Engine model defaults advance when the current value still matches the last organization default; personal model changes and saved browser selections are preserved. Use a fresh test workspace for first-run default acceptance, and verify the model shown in each engine before sending the test message.

With `ORG_DIR`, `DATA_DIR`, and `SECURE_DIR` set to those absolute host paths, start the gateway:

```sh
docker run -d --name workpartner-preview-gateway --hostname workpartner-preview-gateway \
  -p 127.0.0.1:3090:3090 \
  -e WORKPARTNER_ORG_DIR=/organization \
  -e HOST_PARTNER_DATA="$DATA_DIR" \
  -e HOST_PARTNER_SECURE="$SECURE_DIR" \
  -v "$ORG_DIR:/organization:ro" \
  -v "$DATA_DIR/users.json:/etc/partner/users.json" \
  -v "$DATA_DIR/workspaces:/workspaces" \
  -v "$DATA_DIR/users:/users" \
  -v "$DATA_DIR/state:/state" \
  -v "$DATA_DIR/shared-skills:/shared-skills" \
  -v "$SECURE_DIR:/secure" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  workpartner-gateway:local
```

Forward the preview hostname to `127.0.0.1:3090` with WebSocket upgrades. Open it in a browser, complete identity login, select the workspace activation button, and wait for the personal container. Send a simple message using an available test model, upload a small test file, reload the page, and log out. Confirm the response and file remain after re-login and that another test identity has a separate workspace. Record image IDs and the results; source checks with local transport fixtures do not establish this acceptance.

## Current preview limits

The lock selects cc-connect `v2.2.3`, SHA-256 `33ffb25e48e0a976e346728a1b6cebb58e0368a1f7d2bbeac3af9f82b5425372`. The downloader fetches the `cc-connect-v2.2.3-linux-amd64` asset from the public `soundworkbench/cc-connect` release. The build reads `cc-connect` from the download directory and verifies the pinned digest again. A missing binary or mismatched digest stops the build. The image workflow downloads the bridge together with all other inputs.

The `Bridge bump` workflow keeps this pin on the newest non-draft `soundworkbench/cc-connect` release. It runs every 30 minutes, on manual dispatch, and on a `cc-connect-release` repository dispatch. When the pin already matches, it does nothing. A release without a `linux-amd64` asset is skipped and the reason appears in the job summary. Otherwise it downloads the asset and writes its version, URL, release, SHA-256 and size into the lock. It also replaces the version and digest quoted in this reference and runs `tools/check.sh`. It then pushes `bridge-bump/main` and opens or updates the PR `Upgrade the Feishu bridge to cc-connect <tag>`. It uses only the workflow token, so the repository must allow GitHub Actions to create pull requests. A PR opened with that token does not start `Linux tests`. A maintainer closes and reopens the PR to run them, then reviews and merges it.

The bridge release job can trigger the bump immediately instead of waiting for the schedule. The caller needs a token with Contents write access to this repository:

```bash
curl -fsS -X POST https://api.github.com/repos/soundworkbench/workpartner/dispatches \
  -H "Authorization: Bearer $WORKPARTNER_DISPATCH_TOKEN" \
  -H 'Accept: application/vnd.github+json' \
  -d '{"event_type":"cc-connect-release"}'
```

Official skills use the same upstream commits as the private bundle and verified source archive hashes. `image/build.sh --prepare-only <new-directory>` assembles the full context without invoking Docker, including deterministic skill repacking. Playwright is pinned to version 1.61.1 but its npm dependency graph and Chromium download are not yet SHA-256 locked. Third-party license packaging for the remaining programs and an actual Linux image build remain release checks. The gateway includes personal platform authorization and bot onboarding, selected by the organization feature fields.

## Gateway feature selection

`features.feishuAuthorization` controls personal authorization and CLI identity preparation. `FEISHU_USER_AUTH_ENABLED=0` stops new authorizations and token issuance while retaining revocation and status for an already configured integration. The internal token listener uses `runtime.internalPort`; never publish it on the host. `runtime.stateDirectory` selects its persistent authorization state. `features.feishuOnboarding`, `features.marketSkills`, `features.autoTitle` and `features.preview` select the remaining gateway capabilities. Preview also needs a separate `previewHost` (or `PREVIEW_HOST`) and the user-image relay on its reserved internal port. The gateway writes the personal relay key before starting a workspace. The image starts the relay only when that key exists, resolves the gateway address from `runtime.gatewayOrigin`, and exits for the container runtime to restart if the relay fails. The web page loads `/_wp/preview/client.js` from the gateway, which sends links and `window.open` calls to `127.0.0.1` or `localhost` through the preview host; with preview disabled the script is empty. After deployment, check this in a signed-in browser with `node image/tests/verify-preview-links.mjs --cdp http://127.0.0.1:9222 --url https://workspace.example.com/`.

`extensions.gatewayModule` optionally names a trusted local module relative to the organization directory. The public default leaves it empty and has no legacy backend or desktop implementation. When extension loading is enabled, a configured but missing or broken extension is a startup error. Kubernetes skips extensions by default (`runtime.k8s.loadGatewayExtension` defaults to false); legacy users continue through the Docker peer. Set this flag to true when organization-provided routes are needed; the extension must not depend on Docker transport. Keep extension code outside the public snapshot.

### 同一容器内的子助手

容器保留主助手 `main`（「主助手」）：工作目录 `/data/work`，配置 `/data/.cc-connect/config.toml`，桥数据 `/data/.cc-connect/data`，运行文件 `/data/.cc-connect/run`。最多登记 5 个子助手，尚未扫码成功的也计入上限。子助手 ID 固定为随机 `s` 加 8 位十六进制，改名不会改变目录或项目记忆。

| 子助手文件 | 位置 |
| --- | --- |
| 工作目录、CLAUDE.md、AGENTS.md | `/data/agents/<id>`（目录 755） |
| 登记姓名和创建时间 | `/data/.cc-connect/agents/<id>/agent.json` |
| 独立机器人配置 | `/data/.cc-connect/agents/<id>/config.toml`（600） |
| 会话、cron/timer、API socket | `/data/.cc-connect/agents/<id>/data`，socket 在其 `run/api.sock` |
| 桥 pid、连接状态、按 appId 的缓存 | `/data/.cc-connect/agents/<id>/run` |
| 扫码状态、锁和 pending 配置 | `/data/.cc-connect/agents/<id>/` 下的 `.feishu-setup.json`、`.feishu-setup.lock`、`pending-feishu.toml` |

`/data/.cc-connect/agents` 及其子目录为 700。每个助手使用自己的 cc-connect 进程和 data_dir，统一由 `wp-feishu-bot.py supervise` 管理；守护每 3 秒扫描，也接受主 `run/restart.fifo` 的 `rescan`。新增、删除、重启子助手不重启容器或其他桥。主桥日志保持原样，子桥每行带 `[agent <id>] `。容器启动先执行 `wp-agent sync`，更新子助手的公司统一说明与所有助手的名单块；没有子助手时不新增名单块或登记锁。

```sh
printf '%s\n' '{"name":"研究员"}' | wp-agent create
wp-agent list
printf '%s\n' '{"name":"资料员"}' | wp-agent rename s12345678
python3 /opt/workpartner/bin/feishu-onboard.py start --agent s12345678
python3 /opt/workpartner/bin/feishu-onboard.py status --agent s12345678
python3 /opt/workpartner/bin/wp-feishu-bot.py info --refresh
python3 /opt/workpartner/bin/wp-feishu-bot.py restart --agent s12345678
wp-agent ask 资料员 --timeout 300 --json "整理本周资料"
wp-agent delete s12345678
```

将示例 ID 替换为 create 返回的 ID。create/rename 从 stdin 接受不超过 4KB 的一行 JSON；管理命令 stdout 为一行 JSON。姓名先 NFC 归一并去首尾空白，限 1–16 字，允许汉字、ASCII 字母数字、`_`、`-`、`·` 和单个内部空格；`main`/「主助手」保留，大小写折叠后不得重名。create/rename/delete 使用同一个 `agents.lock` 串行处理。

子助手扫码命令应由网关作为后台任务运行，status 轮询 QR 和进度。成功即 `connected`，立即通知守护启动 `agent-<id>` 项目的独立桥，不经过主助手的 `needs_restart` 流程。飞书机器人在扫码时命名，容器内助手的名字不会修改飞书应用名。info 同时返回机器人与助手清单，单个子助手配置损坏不影响其余助手；所有飞书请求共享 7 秒期限。机器人缓存分别放在各助手自己的 `run/bot-cache.json`。

`ask` 接受姓名或 ID，不带消息时从 stdin 读最多 64KB；它在目标工作目录调用 Claude，默认仅输出结果文本，`--json` 返回结构化结果。默认超时 300 秒，允许 10–1800 秒，超时杀掉整个调用进程组。最多同时执行两个调用；禁止调用自己，调用过程携带 `WP_AGENT_DEPTH=1`，被调用助手不能继续调用其他助手。预计超过 2 分钟的请求应放后台执行。

删除只解绑容器内助手，不删除飞书中的应用。它先停止进行中的扫码，把配置目录和工作目录分别 rename 到 `/data/.trash/agents/<id>-<YYYYmmddTHHMMSSZ>/bridge` 与 `work`，通知守护停止该桥，再更新名单；本任务不清理回收目录。删掉最后一个子助手时，主助手名单块及其新增分隔换行被移除，个人说明原字节保留。

子助手目录不在 `/data/work` 下，避免继承主助手的 CLAUDE.md；Claude 项目记忆按工作目录区分。它们仍共享 HOME=/data、用户权限和容器资源，属于工作上下文隔离。**用桥的 `/dir` 切换工作目录后，不再保证说明和项目记忆隔离**；调用方身份也按当前实际目录判定。组织模板升级不会覆盖 `projects.agent.options.work_dir`。

When upgrading the bridge, check `cc-connect --version` inside the built user image and require `v2.2.3`. Start it with the rendered template configuration and inspect the complete startup log for unknown-key or deprecation warnings. The template uses Claude Code; source inspection and a downloaded binary version check do not replace image startup or real Feishu acceptance.

For quick-line acceptance, configure `model.quickLineModel`, replace an idle personal container and verify that its environment contains `QUICK_LINE_MODEL` and the bridge startup log reports quick line enabled. During a real turn, check the temporary line is at most 30 characters and absent from the final reply. Remove the field, replace the container and require the variable to be absent and the log to report quick line off. Test without an explicit `[stream_preview.quick_line]` section, which takes precedence over environment auto-configuration.

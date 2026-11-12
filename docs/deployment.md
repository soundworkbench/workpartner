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

The lock selects cc-connect `v2.2.2`, SHA-256 `22ddcdd2713030652dc21c0c8135e7bf7ec5bd6d0b8cd0af41afa24e4ca1970e`. The downloader fetches the `cc-connect-v2.2.2-linux-amd64` asset from the public `soundworkbench/cc-connect` release. The build reads `cc-connect` from the download directory and verifies the pinned digest again. A missing binary or mismatched digest stops the build. The image workflow downloads the bridge together with all other inputs.

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

When upgrading the bridge, check `cc-connect --version` inside the built user image and require `v2.2.2`. Start it with the rendered template configuration and inspect the complete startup log for unknown-key or deprecation warnings. The template uses Claude Code; source inspection and a downloaded binary version check do not replace image startup or real Feishu acceptance.

For quick-line acceptance, configure `model.quickLineModel`, replace an idle personal container and verify that its environment contains `QUICK_LINE_MODEL` and the bridge startup log reports quick line enabled. During a real turn, check the temporary line is at most 30 characters and absent from the final reply. Remove the field, replace the container and require the variable to be absent and the log to report quick line off. Test without an explicit `[stream_preview.quick_line]` section, which takes precedence over environment auto-configuration.

# Deployment reference

The gateway is the only public entry point. Terminate TLS at your reverse proxy and forward requests and WebSocket upgrades to the gateway port selected by your organization configuration. Register the matching HTTPS callback with your identity provider.

Mount the organization directory read-only and select its container path with `WORKPARTNER_ORG_DIR`. Mount the configured state directory read-write and credential directory with the permissions required by the gateway. Keep application secrets and per-person model keys outside the repository. Never embed them into Docker layers or third-party download URLs.

The gateway needs Docker access to create each person's container and private network. Docker socket access grants host control; run the gateway only on a host dedicated to this workload. Host paths used when creating containers must refer to the host directories, even when the gateway sees them at different mount paths. Configure the data and credential host paths accordingly. Nonempty `HOST_PARTNER_DATA` and `HOST_PARTNER_SECURE` environment variables override `runtime.hostData` and `runtime.hostSecure`; otherwise the organization JSON values apply.

User containers persist `/data`, including the work directory. Their ports remain private. Allow access only from the gateway and to the configured model endpoint. Back up persistent user data and gateway state before changing images. Rebuilding the image does not replace the organization's configuration.

## Build inputs

`image/third-party.lock.json` contains an `artifacts` array. Every entry supplies `version`, a public `https` URL, the SHA-256 of the downloaded bytes, `destination`, and `format` (`file`, `tar`, or `tar-member`). Required destinations are `aionui-web`, `cc-connect`, `officecli`, `codex`, `codex-code-mode-host`, and `claude`. Downloads are checked before extraction and the completed package directory appears only after all inputs pass.

`tar-member` selects exactly one regular file by its full archive path and writes it as the named executable. `tar` entries supply `stripComponents` and normally allow only regular files and directories. AionUi includes three symbolic links pointing at its upstream build machine. Its lock entry declares exact `symlinkReplacements` that rebuild these as relative links to extracted regular files inside the package. Unknown links, missing declared links, external targets and special files are rejected.

The AionUi archive SHA-256 is different from a digest of an unpacked directory listing. Pin both at their respective download and build checks. A version string or an unchecked URL alone is insufficient. Obtain program releases from their maintainers; the downloader never reads private host package directories.

## Release checks

Run Linux checks before building an image. After building, run `WORKPARTNER_TEST_IMAGE=<image-tag> bash tools/check.sh` to check the certificate bundle and Python's loaded trust roots as the image's runtime user. The Dockerfile also checks both during the build. This offline check does not establish trust in your particular model endpoint: test a real HTTPS model request with certificate verification enabled. Test login, admission, WebSocket routing, logout, file persistence and both engines using your own deployment. Verify that one person's session cannot access another person's container. Tagging `v*` triggers tests, verified downloads, the image build and registry publication. Images built from third-party packages require a separate review of their license notices.

## Start an isolated preview

An administrator supplies a dedicated HTTPS hostname with its identity callback set to `https://<host>/_wp/callback`, an existing test application secret file, and existing test model keys. This guide does not create or rotate credentials. Use empty preview directories, and keep them separate from any running deployment.

Copy `org/default` to an external organization directory. Edit its `organization.json`: set `publicHost`, `identity.appId`, `model.baseUrl`, `runtime.nextImage` to `workpartner-user:local`, `runtime.hostData` to the absolute host preview data directory, and `runtime.hostSecure` to the absolute host preview secret directory. The default `runtime.nextDirectory` is `/workspaces`; create `<data>/workspaces`, `<data>/users`, `<data>/state`, and `<secrets>/aionui`, and put an empty JSON array in `<data>/users.json`. Give UID 1001 access to its user volumes. Store the existing identity secret at `<secrets>/identity-app.secret`. Place pre-created test model key files in `<secrets>/model-pool/*.key`; the gateway assigns one to each newly admitted test user. Do not use production keys or user lists.

Set `model.defaults.codex` and `model.defaults.claude` to available test models before building. With `ORG_DIR` set to the absolute host organization directory and `PKG` set to the verified build inputs, build the user image with that organization:

```sh
WORKPARTNER_ORG_DIR="$ORG_DIR" sh image/build.sh workpartner-user:local
WORKPARTNER_TEST_IMAGE=workpartner-user:local bash tools/check.sh
```

The image embeds its own organization, engine templates and model catalog; the gateway mount does not replace them. Existing personal engine files and saved browser selections are preserved. Use a fresh test workspace for first-run default acceptance, and verify the model shown in each engine before sending the test message.

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
  -v "$SECURE_DIR:/secure" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  workpartner-gateway:local
```

Forward the preview hostname to `127.0.0.1:3090` with WebSocket upgrades. Open it in a browser, complete identity login, select the workspace activation button, and wait for the personal container. Send a simple message using an available test model, upload a small test file, reload the page, and log out. Confirm the response and file remain after re-login and that another test identity has a separate workspace. Record image IDs and the results; source checks with local transport fixtures do not establish this acceptance.

## Current preview limits

The native Claude executable and the other five listed program inputs use verified archive hashes. Playwright is pinned to version 1.61.1 but its npm dependency graph and Chromium download are not yet SHA-256 locked. Third-party license packaging and an actual Linux image build remain release checks. Identity messaging bridge templates and official skill bundles are not included in the public edition. The company image must use its private build script. The optional bridge is disabled, and this preview does not provide personal platform authorization. These limits must be resolved or explicitly accepted before publication.

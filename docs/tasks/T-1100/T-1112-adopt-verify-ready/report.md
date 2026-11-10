T-1112 implements readiness waits, gateway preparation, image compatibility mappings, and inventory defaults. No cluster or Docker daemon was used. The gateway public request handler and user Pod spec are unchanged. The existing task brief is preserved.

Changed files:

| File | Change |
| --- | --- |
| `tools/k8s/adopt-user.mjs` | Adds `--ready-timeout`, readiness polling, internal prepare invocation on initial and repeated switch, and published Secret/link verification. |
| `tools/k8s/adopt-wait.mjs` | New shared bounded retry helper; defaults to 180 seconds per check with five-second polling, attempt logging, safe failure reasons, and an in-flight deadline. |
| `tools/k8s/adopt-mappings.mjs` | New single image mapping table and conservative default inventory decisions. |
| `tools/k8s/adopt-inventory.mjs` | Applies mappings before explicit operator targets, initializes harmless decisions, and records only a boolean for CLI interactive mode. |
| `gateway/services.mjs` | Adds an internal-listener-only, loopback-only prepare trigger with current roster and ownership checks; returns empty responses without credentials. |
| `feishu/next.mjs` | Allows the internal prepare trigger to bypass the normal preparation cache and refill token/config files. Normal preparation keeps its existing cache behavior. |
| `tools/k8s-adopt.test.mjs` | Extends fakes with a virtual clock and published Secret state; adds readiness, timeout, prepare/projection, mapping, classification, and redaction coverage. |
| `tools/migration.test.mjs` | Exercises the internal listener with fake HTTP objects: source/method/user/ownership restrictions, refill after caching, and safe errors. |
| `docs/kubernetes.md` | Documents retries, timeout scope, deployment prerequisite, internal prepare, published files, mappings, and default decisions. |
| `docs/tasks/T-1100/T-1112-adopt-verify-ready/report.md` | This report. |

Each readiness check has its own timeout. Pod readiness, gateway status, configured bridge startup, published keys/links, and carried items retry before failing. A failure includes attempts and the last safe reason. Carried-item ALARMs are emitted only after retries are exhausted. Explicit inventory targets override the built-in `/opt/partner-next` → `/opt/workpartner` prefix and `3092` → `25808` port mappings.

Switch calls `POST /internal/adopt/prepare/<slug>` inside the gateway container on `runtime.internalPort` (default 3091), including its already-migrated path. The updated gateway must be deployed before using this switch behavior. Preparation reuses the gateway's existing credential generation and publication code. Verify remains read-only and waits separately for enabled features' nonempty Secret keys and readable, nonempty Pod links. Secret values and upstream error payloads are not logged.

Known startup directory metadata and root Git configuration get dropped decisions with reasons. Transient curl/sleep and interactive claude processes also get defaults; print-mode automation, custom files under system directories, and unknown items remain undecided. The rules do not discard entire `/usr` or `/root` subtrees.

Validation used Node **v22.22.1**. All required takeover tests and new tests pass. The final targeted runs cover **223 distinct passing tests**: 175 takeover, 19 migration, 27 published-file/runtime tests, and two gateway tests using fakes. Test isolation was disabled to obtain individual test counts from node:test.

Commands and output tails:

```text
$ node --version
v22.22.1

$ node --test --experimental-test-isolation=none tools/k8s-adopt.test.mjs
1..175
# tests 175
# suites 0
# pass 175
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ node --test --experimental-test-isolation=none tools/migration.test.mjs
1..19
# tests 19
# suites 0
# pass 19
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ node --test --experimental-test-isolation=none tools/k8s-adopt.test.mjs tools/migration.test.mjs tools/runtime-k8s-files.test.mjs
1..221
# tests 221
# suites 0
# pass 221
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ node --test --experimental-test-isolation=none tools/k8s-adopt.test.mjs tools/migration.test.mjs
1..194
# tests 194
# suites 0
# pass 194
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ node --test --experimental-test-isolation=none --test-name-pattern='gateway preserves a reused extension result|k8s gateway startup' tools/gateway.test.mjs
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ node --check tools/k8s/adopt-user.mjs
$ node --check tools/k8s/adopt-inventory.mjs
$ node --check tools/k8s/adopt-mappings.mjs
$ node --check tools/k8s/adopt-wait.mjs
$ node --check gateway/services.mjs
$ node --check feishu/next.mjs
$ git diff --check
(no output; each exited 0)
```

An additional broader offline regression attempt exercised existing local HTTP and Docker-file fixtures. It did not use a cluster or Docker daemon, but this sandbox disallows socket listeners and the fixture ownership changes. Eight tests failed with `listen EPERM`; three failed with `EINVAL` from `chown`/`fchown`. These tests could not be validated in this environment; no permissions were escalated and no production code was changed to bypass the restrictions. The gateway tests that use fake listeners passed separately above.

```text
$ node --test --experimental-test-isolation=none tools/k8s-adopt.test.mjs tools/migration.test.mjs tools/runtime-k8s-files.test.mjs tools/runtime-models.test.mjs tools/identity-cli.test.mjs tools/gateway.test.mjs
1..262
# tests 262
# suites 0
# pass 251
# fail 11
# cancelled 0
# skipped 0
# todo 0
```

# T-1115 task report

Implemented prepare/wait failure classification and clearer diagnostics. Gateway
production code, the user Pod specification, runtime dependencies, the 180-second
default readiness timeout and the 5-second polling interval are unchanged.

Prepare emits one HTTP-status or error-code line, without response contents.
HTTP 403/404/405 stop immediately with upgrade/listener guidance; HTTP 409/503
and connection failures retry. Responses are closed after reading the status so
a delayed body cannot hold up failure reporting. Deadline failures carry
`ETIMEDOUT`. Checks can set `retry: false`; missing system namespace, invalid
internal port and wrong-node checks do so. Unexpected failures retain only
validated status/code/exit-code fields. Missing published keys are named, and
single-argv `claude` processes remain undecided.

## Changed files

| File | Change |
| --- | --- |
| `tools/k8s/adopt-state.mjs` | Optional retry flag on check failures. |
| `tools/k8s/adopt-wait.mjs` | Immediate failure, safe diagnostics and deadline code. |
| `tools/k8s/adopt-user.mjs` | Prepare protocol/classification, permanent checks, missing key names, dry-run wording. |
| `tools/k8s/adopt-inventory.mjs` | Preserve uncertainty for single-argv process titles. |
| `tools/k8s-adopt.test.mjs` | Offline regressions using fake runtime/HTTP and clock. |
| `tools/gateway.test.mjs` | Public prepare route regression in the existing fake-server test. |
| `docs/kubernetes.md` | Failure classes, loopback port-forward access and process-title limitation. |
| `docs/tasks/T-1100/T-1115-adopt-failure-classes/plan.md` | Implementation plan. |
| `docs/tasks/T-1100/T-1115-adopt-failure-classes/report.md` | This report. |

The supplied `brief.md` was present before work and was not modified.

## Validation

Node: **v22.22.1**. No cluster or Docker was run.

The required command passed:

```text
node --test tools/k8s-adopt.test.mjs tools/migration.test.mjs
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

This environment's default reporter reports file-level results. Running the
same files with test isolation disabled exposes the individual test counts:
**209 passed: 190 takeover tests and 19 migration tests**.

```text
node --test --experimental-test-isolation=none tools/k8s-adopt.test.mjs tools/migration.test.mjs
1..209
# tests 209
# suites 0
# pass 209
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The modified gateway test, including the public-route regression, passed with
fake servers and no listening sockets:

```text
node --test --experimental-test-isolation=none --test-name-pattern='k8s gateway startup' tools/gateway.test.mjs
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The full touched gateway file was also run:
`node --test tools/gateway.test.mjs` reported one failed test file. Its detailed
run (`--experimental-test-isolation=none`) reported:

```text
1..8
# tests 8
# suites 0
# pass 2
# fail 6
# cancelled 0
# skipped 0
# todo 0
```

All six failures are `listen EPERM` from the sandbox's local-socket restriction.
The unchanged gateway test file from HEAD was run using a temporary sibling file
and produced exactly the same two passes and six failures; that temporary file
was removed. The affected test names are:

- exported gateway serves authorization, skill uploads, automatic titles and private previews
- organization switches disable integrations without loading private code or state
- existing organization extensions retain Docker and synchronous token dependencies
- two migration gateways preserve HTTP and WebSocket requests, local entry routes and live ownership
- configured missing or invalid ownership returns 503 without provisioning or runtime writes
- without migration forwarding, previews, internal tokens and keep-running preserve main behavior

`git diff --check` passed. The new failure-class regressions were observed failing
before the fixes. Read-only review found no outstanding critical or important
issues after the deadline fix. A response-body completion concern from review
was treated as affecting the immediate-failure requirement: four prepare HTTP
cases were observed failing before switching the probe from draining to closing
the response, and the final required suite passed afterward.

Live Kubernetes exec and port-forward behavior were documented but not exercised,
as required by the offline-only constraint. The full gateway suite still needs
an environment that permits local test listeners.

T-1113 round 2 is implemented on top of the retained round-1 changes. The e2e organization uses system-namespace FQDNs without trailing dots in all three URLs and now sets `runtime.k8s.dnsNdots` to the gateway hostname's computed dot count. This is 4 for the default domain; the custom-domain test also covers a count of 5.

`runtime.k8s.dnsNdots` is optional and validated during organization resolution as an integer from 1 to 15. The shared user/job Pod builder adds `dnsConfig.options` only when configured. Existing searches are unchanged. No default is added to production organization configuration, so unset production Pod specs retain their prior serialized shape; tests explicitly assert that the `options` key is absent for both user and job Pods.

S10 writes `nameResolution` before policy convergence for both `node-server` and `node-agent`, retaining it on PASS and failure. Each entry includes resolver `search`/`options` lines and four timed lookup results, in order: the configured gateway hostname exactly as used, the configured model hostname exactly as used, the bare gateway Service name, and the absolute gateway FQDN with a trailing dot. Lookup errors and probe transport failures remain evidence rather than aborting collection.

Failure diagnostics pair gateway IP probes with hostname TCP and lookup probes from every same-node user Pod and the failed slug's Pod, including a failure on the other node. Assertion messages keep the existing label first and append `result.reason ?? 'no reason'`.

Changed implementation and test files across both rounds:

| File | Change |
| --- | --- |
| `gateway/organization/resolve.mjs` | Validate optional `runtime.k8s.dnsNdots`; reject null, noninteger, out-of-range and nonnumeric values with a field-specific error. |
| `gateway/organization/resolve.d.mts` | Declare the optional numeric field and its range. |
| `gateway/runtime/k8s.mjs` | Conditionally emit the ndots option in the shared user/job Pod builder. |
| `tools/k8s/e2e/controller.mjs` | Construct FQDN URLs, default the domain, and compute ndots. |
| `tools/k8s/e2e/probe.mjs` | Add nonthrowing timed lookup and filtered resolver-file probes. |
| `tools/k8s/e2e/scenarios.mjs` | Record all four lookup targets before convergence; retain evidence and append probe reasons with a fallback. |
| `tools/k8s/e2e/diagnostics.mjs` | Derive short resource names and collect hostname probes from same-node and failed Pods. |
| `tools/k8s/render.mjs` | Retained round-1 acceptance of Service FQDNs in the configured namespace/domain. |
| `tools/k8s/e2e/tests/organization.test.mjs` | Default/custom domain URLs and computed ndots, manifest equivalence, hostname validation, resource/port consistency. |
| `tools/k8s/e2e/tests/probe.test.mjs` | Lookup success/error timing and resolver-line filtering without live DNS. |
| `tools/k8s/e2e/tests/policy-ready.test.mjs` | Four lookup targets on both Pods, evidence on PASS/FAIL, lookup errors and assertion reason/fallback messages. |
| `tools/k8s/e2e/tests/diagnostics.test.mjs` | Same-node and remote failed-Pod hostname probes, partial evidence and port contracts. |
| `tools/k8s/e2e/tests/index.js` | Retained registration of the round-1 tests. |
| `tools/runtime-k8s.test.mjs` | User and job Pod options at values 1, 4 and 15; omitted options retain exact DNS serialization. |
| `tools/organization-resolve.test.mjs` | Accepted bounds, omitted configuration and invalid values. |
| `docs/kubernetes.md` | Document dnsNdots, replace the FQDN/search-list note, and describe nextBaseUrl as the same Service and port. |
| `docs/tasks/T-1100/T-1113-e2e-s10-gateway-fqdn/plan-r2.md` | Round-2 implementation and verification plan. |
| `docs/tasks/T-1100/T-1113-e2e-s10-gateway-fqdn/report.md` | Updated handoff report. |

The task's existing `brief.md` and `r2.md` are retained as inputs.

Hostname consumers after the change:

| Place | Handling |
| --- | --- |
| `controller.mjs` organization, organization file and ConfigMap | Carry the gateway/internal/model FQDN URLs plus computed ndots. Auxiliary resource names remain short. |
| `scenarios.mjs` S6 | The job's denied gateway connection uses the configured gateway hostname. |
| `scenarios.mjs` S10 | DNS assertions and allowed TCP targets use configured gateway/model hostnames; job denial targets inherit them. Lookup evidence includes those exact hostnames and both comparison names. |
| `diagnostics.mjs` | TCP/lookup use the configured gateway hostname; Service retrieval and EndpointSlice selectors use its first label. |
| `render.mjs` and `deploy/k8s/` templates | Validate system-namespace FQDNs and derive short Service, Deployment, ServiceAccount and EndpointSlice names. Service/port matching and collision checks remain enforced. Egress policies use selectors and ports; tests confirm manifest equivalence to short-name URLs. |
| Gateway Deployment environment | Still only `WORKPARTNER_ORG_DIR`; no hostname override. The e2e gateway reads the generated organization from `/e2e/config.json`. |
| `context.mjs` | Passes the configured gateway origin into each user's model configuration. |
| `gateway/runtime/index.mjs` and `gateway/runtime/k8s.mjs` | Pass the model URL through to `MODEL_BASE_URL` and pass the optional ndots field into the shared Pod builder. |
| `gateway/organization/resolve.mjs` | `nextEnvironment` forwards the configured gateway origin and model base URL to their existing environment variables. |

No clusters, k3d or k3s were run. Entry hostPort settings and the `policyTimeoutMs` default of 60000 are unchanged. Independent read-only code review found no issues.

Validation used Node `v22.22.1`. Regression tests were observed failing for the missing behavior before implementation, then passing after the changes. The exact requested commands and their output tails are below. The default process-isolated runner reports file/wrapper counts in this environment; the additional in-process runs expose the individual test counts.

Command (exit 0):

```sh
node --test tools/k8s/e2e/tests/
```

```text
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 37094.6464
```

Command (exit 0):

```sh
node --test tools/k8s-render.test.mjs
```

```text
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4795.333267
```

Command (exit 0):

```sh
node --test tools/runtime-k8s.test.mjs tools/organization-resolve.test.mjs
```

```text
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 675.478775
```

Command (exit 0):

```sh
node --test --experimental-test-isolation=none tools/k8s/e2e/tests/index.js
```

```text
1..32
# tests 58
# suites 0
# pass 58
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 37100.259999
```

Command (exit 0):

```sh
node --test --experimental-test-isolation=none tools/k8s-render.test.mjs tools/runtime-k8s.test.mjs tools/organization-resolve.test.mjs
```

```text
1..70
# tests 96
# suites 0
# pass 96
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5286.845669
```

`git diff --check` also passed.

The real latency proof remains the coordinator's post-merge GitHub Actions k3d run: S10 PASS, resolver options reflecting the configured ndots, and successful short-name versus configured FQDN lookup timings in `results.json` under S10's `evidence.nameResolution` for both nodes. The configured model and trailing-dot gateway timings are also recorded. Lookup errors or unavailable probes must be distinguished from successful timings. No local unit result establishes that cluster-level outcome.

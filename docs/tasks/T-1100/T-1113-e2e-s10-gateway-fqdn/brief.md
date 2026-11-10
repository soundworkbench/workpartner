# T-1113 e2e S10: gateway short-name lookup is slow; use FQDN and record lookup timing

## Background

The k3d e2e (GitHub Actions) S10 "Two-node network matrix" keeps failing at `waitForPolicy` with
`node-server: gateway HTTP  false !== true` after 60 s. The diagnostics added in the previous task
show, collected right after the timeout:

- user Pods (same node and other node as the gateway) connect by **IP** to the gateway Pod on 18083 and 18084: open.
- the gateway Pod answers HTTP 200 on its Pod IP.
- the `dns` probe of the gateway **short name** returns exactly the gateway Pod IP (assert passes).
- nftables guard drop counters on the gateway node are 0.

So only the TCP probe **by hostname** fails. Hypothesis to fix and prove:

- The e2e organization (`tools/k8s/e2e/controller.mjs` `organization()`) sets `gatewayOrigin`,
  `internalOrigin` and `model.baseUrl` to short names (`<prefix>-gateway`, `<prefix>-model`) that live in
  the system namespace. User Pods find them only through `dnsConfig.searches` (`gateway/runtime/k8s.mjs`),
  which Kubernetes appends **after** the Pod's own namespace searches and the node's host search
  domains. On GitHub runners the host search domain is forwarded upstream, so each lookup (A and AAAA)
  walks several NXDOMAIN round trips before reaching `<system>.svc.<clusterDomain>`.
- `probe.mjs` `tcp()` starts the 1500 ms socket timeout before `net.connect` resolves the name, so a slow
  lookup reports `open: false, reason: 'timeout'`, while the `dns` probe has no time limit and passes.

## Required changes

1. **Probe reason in failures.** In `scenarios.mjs`, the allowed-target assertion inside `waitForPolicy`
   and `checkMatrix` must include the probe `reason` in the assertion message, e.g.
   `node-server: gateway HTTP (timeout)`. Keep the label text first so existing regexes still match.
2. **Lookup timing evidence.** Add a probe kind `lookup` in `probe.mjs` that returns
   `{ addresses, ms }` (use `dns.promises.lookup(host, { all: true })` and `performance.now()`; on error return
   `{ error: code, ms }`, do not throw). In S10, before `waitForPolicy`, from `node-server` and `node-agent`
   record into evidence the lookup result for: the short gateway name and the FQDN
   `<short>.<systemNamespace>.svc.<clusterDomain>.` (trailing dot). Also record the user Pod's
   `/etc/resolv.conf` `search` and `options` lines (read via a probe kind `resolv`; only those two lines, nothing else).
   This evidence must be written even when S10 passes.
3. **Diagnostics.** In `diagnostics.mjs`, for each same-node user Pod also probe `tcp` to the gateway
   **hostname** (as configured) on gatewayPort, plus the `lookup` probe of that hostname, so a future failure
   shows hostname vs IP side by side.
4. **Fix.** In the e2e `organization()`, build `gatewayOrigin`, `internalOrigin` and `model.baseUrl` with the
   FQDN `<name>.<systemNamespace>.svc.<clusterDomain>` (no trailing dot in URLs; `clusterDomain` defaults to
   `cluster.local` the same way `k8s.mjs` does). Check every place that compares or derives from these
   hostnames (S10 DNS assertion, S? scenarios using `gateway.hostname`, `diagnostics.mjs`, policy/egress
   setup, the gateway Deployment env) still works.
5. **Product note, no behaviour change.** Production runtime code (`gateway/runtime/k8s.mjs`) is not to be
   changed in this task. In `docs/` k8s operations doc (the one that documents `runtime.gatewayOrigin`),
   add one short note: for user Pods, set `gatewayOrigin` / `internalOrigin` / model base URL to the FQDN
   in the system namespace; a short name relies on the appended search domain and can be slow when the
   node has host search domains.
6. **Unit tests** (node:test, in `tools/k8s/e2e/tests/`): assertion message contains the reason; `lookup`
   probe returns `ms` and never throws; `organization()` emits FQDN origins and honours a custom
   `clusterDomain`; diagnostics include the hostname probe. Update existing tests that hard-code the
   short names.

## Constraints

- Public repository: no company names, real hostnames, IP addresses or person names in code, docs, tests or commits.
- Do not change `entry` hostPort settings (production shape, not the cause per diagnostics).
- Do not run k3d/k3s or any cluster locally. Only run unit tests:
  `node --test tools/k8s/e2e/tests/` and any existing gateway runtime tests you touch.
- Keep the `policyTimeoutMs` default at 60000.

## Acceptance

- Unit tests above pass locally.
- Report lists changed files, the exact test command and its output tail, and which places use the
  gateway/model hostnames after the change.
- The real proof is the GitHub Actions k3d e2e run after merge (run by the coordinator): S10 PASS and
  evidence shows short-name vs FQDN lookup ms.

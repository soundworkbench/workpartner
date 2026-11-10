# T-1115 Takeover tool: classify prepare/wait failures, clearer diagnostics

Repository: this repo, base `main` (contains #26 "verify waits, switch triggers prepare, path/port mapping").
Files: `tools/k8s/adopt-user.mjs`, `tools/k8s/adopt-wait.mjs`, `tools/k8s/adopt-inventory.mjs`,
`gateway/services.mjs` (tests only), `docs/kubernetes.md`, tests in `tools/k8s-adopt.test.mjs` (and gateway tests if needed).

Follow-ups from the review of the previous takeover change. Today a missing route or a permanent error
waits the full 180 s and then reports one vague reason.

## Required changes

1. **Prepare trigger returns the HTTP status.** The node script run inside the gateway (around
   `adopt-user.mjs:253`) must report the status code back (exit code mapping or a single status line on stdout,
   no body, no secrets). Classify:
   - 404 / 405 / 403 → fail at once, no retry: "Gateway internal prepare route missing or refused (HTTP n):
     upgrade the gateway first / check the internal listener".
   - 409 / 503 / connection refused / reset → retry within the bounded wait, as today.
   - The final failure reason always contains the last HTTP status or the error code.
2. **Non-retryable checks.** Add a non-retryable flag to `AdoptCheckFailed` (e.g. `{ retry: false }`).
   `waitForReady` stops at once on it and prints the reason with the attempt count. Mark as non-retryable at least:
   missing system namespace, invalid gateway internal port, Pod scheduled on a different node than the PV.
3. **Safe fields for unexpected errors.** Errors that are not `AdoptCheckFailed` are no longer folded into
   "Check unavailable or timed out" only: append safe fields (HTTP status / `error.code` / kubectl exit code),
   never message bodies, Secret data or environment values.
4. **Missing published keys are named.** When the wait for published keys times out, the reason lists the
   missing key names (names only, never values).
5. **`claude` interactive detection.** In `adopt-inventory.mjs` (~140), when `/proc/<pid>/cmdline` has only one
   argv element (process title may have been rewritten), keep the item undecided instead of pre-dropping it.
6. **Dry-run wording.** `adopt-user.mjs` ~356: replace "preview link" with "published keys/links".
7. **Docs.** In the takeover section of `docs/kubernetes.md`: describe the failure classes (immediate vs retried),
   state precisely that the internal prepare route accepts only loopback peers, which includes
   `kubectl port-forward` to the gateway Pod (needs pods/portforward permission, only refreshes files of a user
   already owned by k8s, returns no content); document the single-argv limitation of item 5.
8. **Regression test.** Assert that the public gateway entry does not answer `POST /internal/adopt/prepare/<slug>`
   with 204 (expect 404 or the existing public not-found behaviour).

## Constraints

- Public repository: no company names, real hostnames, IP addresses or person names in code, docs, tests, commits.
- Do not change public gateway behaviour or the user Pod spec. No new runtime dependencies.
- Do not run any cluster or Docker. Offline tests only (node:test with fakes, following the existing tests).
- Keep the default ready timeout (180 s) and poll interval (5 s).

## Acceptance

- Offline tests cover: 404 → immediate failure with status in the reason; 409 then 204 → retries then passes;
  connection refused → retried, final reason has the error code; non-retryable check stops at attempt 1;
  unexpected error reason contains safe fields only; missing published key names listed; single-argv `claude`
  stays undecided; public entry does not return 204 for the internal route.
- Run `node --test tools/k8s-adopt.test.mjs tools/migration.test.mjs` plus any gateway test you touch; report Node
  version, test counts, changed files and output tails in the task report.

# T-1112 Takeover tool: verify waits for readiness, maps renamed paths/ports, fills published files

Repository tool: `tools/k8s/adopt-user.mjs` (with `adopt-inventory.mjs`, `adopt-state.mjs`).
Real migrations using `switch --apply` then `verify --apply` showed these failures, which the operator had
to work around with an external retry loop and a hand-written decision helper:

1. **Verify runs before the new Pod is ready.** Right after `switch --apply`, verify reports
   `FAILED at verify gateway AionUi status: Gateway cannot reach AionUi status`, and
   `switch` exits non-zero although nothing is wrong; it passes a minute or two later.
   - Required: the AionUi status check (and the other checks that depend on the Pod serving) must retry
     within a bounded timeout (default 180 s, configurable by a CLI option, poll every 5 s) before failing.
     `switch --apply` must use the same wait so it only fails for real problems. Output must show the
     attempt count and the final reason on failure.
2. **Published files are empty right after switch.** The gateway writes the published files (preview relay
   key, market token, Feishu CLI config) into the user's `<c>-published` Secret in its `prepare(user)` step,
   which runs only at gateway start or on the user's next request. Until then verify fails with
   `Preview key link is invalid`, and kubelet needs time to sync the Secret into the Pod.
   - Required: after switching ownership, `switch --apply` triggers the gateway's prepare for that user
     through an existing internal code path or an internal endpoint that the gateway already exposes; if none
     exists, add a minimal internal-only trigger (internal port, not the public entry) and document it. Then
     verify waits (same bounded retry) until the Secret has the keys and the links in the Pod resolve.
     Do not print secret values anywhere.
3. **Renamed image paths and ports raise false ALARMs.** The new user image moved `/opt/partner-next` to
   `/opt/workpartner` (directory and the `bin/cc-connect` executable inside), and the user web port is
   25808 in the new Pod where the old container also listened on 3092.
   - Required: a built-in mapping table in the takeover tool: old `/opt/partner-next` path prefix →
     `/opt/workpartner`; port 3092 → 25808. Inventory decisions for carried items are compared through the
     mapping, so they pass instead of ALARM. Keep the table in one place, unit-tested.
4. **Known-harmless inventory items.** Items that the old image's start script generates (e.g. differences
   under `/usr`, `/usr/local`, `/usr/local/bin`, `/root`, and `/root/.gitconfig`), plus transient processes
   (`curl`, `sleep`) and interactive `claude` processes seen at inventory time, must be pre-classified as
   dropped with a reason, so the operator only decides real user items. Anything else stays undecided as now.

## Constraints

- Public repository: no company names, real hostnames, IP addresses or person names in code, docs, tests, commits.
- Do not change the gateway's public behaviour or the user Pod spec.
- Do not run any cluster. Offline tests only (node:test with fakes/fixtures, following the existing tests
  for these tools). Run the existing takeover tool tests and the new ones; report the Node version and the
  test summary counts.
- Update the takeover section of `docs/` to describe the waits, the prepare trigger and the mapping table.

## Acceptance

- Offline tests cover: retry until ready then pass; timeout produces a clear failure with attempts;
  switch triggers prepare and verify waits for published keys; path and port mapping; pre-classified
  harmless items; unknown items remain undecided.
- Report lists changed files, commands and output tails.

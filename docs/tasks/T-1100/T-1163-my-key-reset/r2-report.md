# T-1163 rework 2 report

Implemented in the existing `T-1163-my-key-reset` worktree. Preserved and completed both diagnostic edits. No commit, push or branch switch was performed. Protocol filenames, fields and result codes are unchanged.

## Changes

- `gateway/my-key-reset.mjs`: removed eager initialization from construction and periodic recovery. Directory scans treat ENOENT as an empty listing. Initialization remains in the accepted reset POST path; existing audit-write behavior is unchanged.
- `gateway/tests/my-key-reset.test.mjs`: added regression coverage for construction, admitted GET requests on both endpoints, unavailable POST, client generation and periodic recovery with no `S/my-key`. Also verifies that recovery does not populate an existing empty audit directory or partial protocol tree. Existing fixtures explicitly seed their prior state.
- `tools/browser-tests/lib/harness.mjs`: retained the 204 restart response and restart recording, exposed `gateway.restarts`, and explicitly seeded the existing audit-directory prerequisite for reset fixtures. The file-only stand-in broker is unchanged.
- `tools/browser-tests/my-key.e2e.mjs`: retained direct gateway access for the daily-limit route; no executable `route.fetch()` call remains. Session cleanup uses `page.unrouteAll({ behavior: 'wait' })` before page closure, including assertion failures. Success checks exactly one restart of `workpartner-next-member`; rejection, offline, blocked, quota and revoked-session paths check zero restarts.
- `tools/key-reset-integration.test.mjs`: added seven socket-free integration cases using the real `createMyKey` handler, `createBroker`, bootstrap and Python helpers. A temporary JSON store and stdin-reading Python rotate program replace external infrastructure. Only upstream HTTP transport and runtime operations use in-memory fixtures. Gateway polling is held at file boundaries to make restart windows deterministic.
- `tools/key-reset/gateway-host.py` and `docs/key-reset.md`: aligned missing-blocked-list handling with the gateway and documented lazy directory creation.

## Integration coverage and mismatch found

All seven requested cases pass: success, blocked policy with a forged request, absent broker heartbeat, failed rotation followed by retry, gateway replacement before installation, broker replacement after rotation, and three successful resets followed by gateway and broker quota refusals.

Success checks the original inode, owner and mode; exact runtime call counts and member identity; configured key prefix; acceptance of only the replacement value; preservation of every other store field; both audits; independent daily counters; and absence of key values in replies, audit records, shared protocol files and broker-local files. Snapshots include intermediate claim, result and inflight states, before cleanup can remove evidence.

One additional mismatch was reproduced and fixed: when `reset.blocked` was absent, the gateway returned 403 `blocked`, while the broker defaulted to an empty list and rotated a forged request, returning `ok`. The integration test failed with `ok !== denied` before the fix. The broker now rejects a missing list, matching the gateway's existing behavior. The policy integration case covers slug, union ID, wildcard, missing and malformed lists. No other mismatch was found in the covered scenarios.

The existing shared-directory prerequisite remains deliberate: the broker never creates `S/my-key`. Successful integration and browser fixtures explicitly supply that pre-existing directory; the offline integration case leaves it absent and verifies no state is written.

## Validation

Final checks used Node v24.22.1 and Python 3.14.4. The default shell Node was v22.22.1; a separately installed Node 24 runtime was used for the final checks below. `--test-isolation=none` exposes individual test results in this sandbox.

| Command with Node 24 | Result |
| --- | --- |
| `node --test --test-isolation=none gateway/tests/my-key-reset.test.mjs` | 18 passed |
| `node --test --test-isolation=none tools/key-reset-broker.test.mjs` | 27 passed |
| `node --test --test-isolation=none tools/key-reset-integration.test.mjs` | 7 passed |
| `node --test --test-isolation=none --test-name-pattern='my key preview on and off preserve original serializer bytes unless admitted' tools/gateway.test.mjs` | 1 passed; existing test unchanged |

The selected serializer test replaces the listener and requires no socket. The ordinary `node --test` invocations also passed during development. Browser harness and test-file syntax checks, Python AST parsing and `git diff --check` passed. A PATH without Python verified seven clean integration skips; subprocess failures other than missing Python are not silently skipped. Fixture key literals remain below the scanner's length threshold.

Not run: Chrome/browser tests, the full socket-dependent `tools/gateway.test.mjs` suite, socket-dependent My key tests, or the full `tools/*.test.mjs` sweep. The sandbox cannot listen on TCP ports or start a browser. No network access, dependency installation or browser launch was attempted. The browser assertions need execution in CI or an environment that supports those operations.

This report is under the repository's locally ignored `docs/tasks/` directory and remains available in the worktree.

# T-1163 rework 3 report

Implemented M1–M3 and S1–S12 in the existing `T-1163-my-key-reset` worktree. HEAD remains `126e2c4`; no commit, push, or branch switch was performed.

Final relevant test runs: **95 passed, 1 failed**, across 96 executed tests. The single failure is the unchanged organization startup child-process assertion described below; it also fails with the original HEAD test. Browser and socket-based tests were not run. No assertions were weakened to accommodate the sandbox.

## Changes and coverage

| Item | File and function/change | Coverage |
|---|---|---|
| M1 | `gateway/organization/default.json`: removed `reset.blocked`, retaining `enabled:false` and `blockedNote:""`. Existing `my-key.mjs` policy normalization now receives missing blocked through the real resolver and denies it. Updated `docs/organization.md` and `docs/key-reset.md`. | `gateway/tests/my-key-reset.test.mjs`: real `organizationData()` with a temporary organization directory verifies main GET blocked, POST 403 blocked, and empty requests. `tools/key-reset-integration.test.mjs`: real resolver missing-blocked case also checks broker refusal of a forged request. `tools/organization-resolve.test.mjs`: both default comparisons updated. |
| M2 | `gateway/my-key-client.mjs`, `renderReset()`: exact requested Chinese and English paragraphs and success message. | `tools/browser-tests/my-key.e2e.mjs`: exact confirmation and success assertions updated; 390/360 layout coverage includes light and dark. Browser execution unavailable. |
| M3 | `tools/key-reset/key-store.py`, `main()`: timeout, OS error, and zero exit without a changed value return unknown. A completed nonzero exit plus the old hash may return rotate-failed. Leading-dash entry IDs are rejected before execution. `tools/key-reset-broker.mjs`, `handle()`, `decide()`, `resume()`: persist rotation-start time, waiting state and consecutive-check count; retain claim/staging and keep slug busy. Only three consecutive old-hash checks in distinct cycles after the ten-minute quiet period permit failure. New hash finishes forward. State survives restart; audit emits rotate-unknown only on state change. | Broker tests cover late success after timeout, timeout that never lands, waiting before ten minutes, three later checks, restart before and during those checks, staged-file retention, one rotation, busy slug, and one unchanged-state audit. Direct Python helper tests inject timeout/OS error/zero exit and verify unknown; leading-dash ID verifies no command ran. Existing hash recovery, lost response, success, and failure tests remain. |
| S1 | `gateway/my-key-client.mjs`, `confirmReset()`: after a thrown reset POST, GET the main My key endpoint; pending uses existing polling. Other states show failure, with close/revocation guards retained. | New `gateway/tests/my-key-client.test.mjs`: six in-memory tests for pending through success, idle, failed recovery GET, dialog close, and 401/404. Browser case forwards the POST to the real server before aborting its response, then checks normal pending completion. |
| S2 | `gateway/my-key.mjs`, main GET handler: catches reset-summary errors separately and returns reset unavailable/allowed false while preserving the rest of the response. | Gateway reset test injects corrupt daily JSON and EACCES and asserts masked key, available usage totals, model data and guide defaults remain served. |
| S3 | `tools/key-reset-broker.mjs`, `readInflight()` and both cycle scans: each malformed record is caught independently, audited once as stuck without its contents, and skipped. Its known claimed slug stays busy. | Broker test combines a malformed inflight file and corresponding remote claim with another person's valid request; two cycles succeed, the good request finishes, and exactly one scrubbed audit remains. |
| S4 | `tools/key-reset-broker.mjs`, `start()`/`close()`: replace `broker.pid` with atomically published `stateDirectory/broker.lock/`, using an owner token with PID and process start time. Active in-process instances remain exclusive; stale self PIDs and reused PIDs are reclaimable. | Existing second-instance test now uses the directory lock and a live child process. Added reused-PID/different-start-time and stale-self-PID tests, plus release assertions. Lock location and lifecycle documented. |
| S5 | `tools/key-reset-broker.mjs`, `complete()`, `recordAndDeliver()`, `deliver()`, `resume()`: deliver success before recording done. Preserve the final decision and hashes until counting succeeds; retry count without permitting another request for that slug. Recovered successes without prior local inflight records also persist recovery hashes. | Broker tests inject a local count rename failure after delivery, verify successful remote result and busy slug, restart, restore storage, and verify both attempts counted once. Additional test covers recovered success with no original inflight record and another restart. |
| S6 | `tools/key-reset-broker.mjs`, `handle()`, `refuse()`, `markSeen()`, `resume()`: replay markers follow confirmed claims, including claims discovered after lost replies. | Broker test throws before remote rename and verifies no marker, request retained, successful retry. Existing lost-claim-reply recovery test now also verifies a marker and rejection of a real duplicate as replay. Existing completed-ID replay test retained. |
| S7 | `tools/key-reset/gateway-host.py`, `Paths.path()` and failure `finish`: exact configured-prefix/slug/id name; unreadable organization file fails without suffix lookup. Prefix lookup errors are outside the missing-staged-file catch. | Broker helper test with bob/a-bob proves inspection and cleanup cannot select the other slug's file. Policy-loss test checks failed finish and retained staging until the exact configuration returns; idempotence and positive-result protection remain. |
| S8 | `gateway/my-key-reset.mjs`, `lock()`: unrecognized entries older than max(claim timeout, ten minutes) are removed, with one lock-cleared audit per cleanup pass. Younger entries remain busy. | Gateway tests cover young and expired entries, the longer claim-timeout boundary, and stale directory cleanup with a symlink sentinel that remains untouched. |
| S9 | `gateway/my-key-reset.mjs`, `readKey()`/`install()`: staged and installed key reads plus the in-place write use O_NOFOLLOW. Comment explains inode preservation for read-only bind mounts and the following container restart. | Gateway symlink refusal tests verify targets remain untouched and installation stays pending. Existing same-inode, owner/mode, runtime synchronization, and retry tests retained. |
| S10 | `gateway/my-key-reset.mjs`, `summary()`: heartbeat age must be at least -30 seconds as well as no more than the existing maximum age. | Gateway regression checks the accepted 30-second boundary and rejected later future heartbeat with GET/POST refusal. |
| S11 | Gateway `cleanup()` prunes dates older than seven UTC days; `done()` reads last outcome and today's day file only. Broker `prune()` applies the same date boundary. | Gateway regression keeps the seven-day boundary, removes older files, and verifies corrupt historical daily data does not prevent completion. Broker dedicated test retains boundary/recent counters and removes older ones; existing replay-marker pruning test retained. |
| S12 | `docs/key-reset.md`: organization-file-only model.keyPrefix, safe no-key for unsupported environment prefix overrides, exact staging lookup, rotate-unknown, ten-minute/three-cycle rule, persisted recovery, delivery-before-count, lock location, both retention rules, heartbeat bounds and client behavior. | Reviewed against implementation and regression coverage; Markdown checked for whitespace errors. |

## Existing assertions and fixtures changed

- The two organization default object comparisons remove only `blocked: []`, as required by M1.
- Browser confirmation/success text assertions use the exact M2 copy. Layout assertions remain and now run for both themes at both narrow widths. The reset session fixture explicitly supplies `blocked: []`; otherwise the intended permitted-reset tests would correctly be blocked after M1.
- The gateway installation failure injection recognizes numeric `O_RDWR` rather than string `'r+'` after S9; its behavioral assertions are unchanged. The fixture retains its millisecond timing defaults when a test overrides one timing field.
- The broker live-lock test now writes a PID/start-time/token owner under `broker.lock`, and shutdown checks that directory instead of `broker.pid` (S4).
- The broker inflight-field assertion now includes `rotationStarted` and the persisted final `decision`, with additional assertions on both (M3/S5).
- The unresolved broker audit test expects one unchanged-state rotate-unknown audit rather than another stuck line every ten minutes (M3).
- Existing inflight recovery tests no longer expect immediate interrupted failure on the old hash: they assert retained pending/staging, advance the clock ten minutes, run three separate checks, and expect rotate-failed (M3). Pre-rotation recovery without inflight state still expects interrupted.
- Policy-file-loss assertions now expect lookup/failure-delivery refusal and retained staging until configuration is restored, then the original denied/interrupted result (S7). Assertions protecting successful results remain.
- Replay and recovery tests gained assertions for lost claim replies and durable counting; no existing protection was removed.

## Commands and results

The shell's default `node` is v22.22.1. A locally installed Node v24.22.1 was available and used through `/tmp/r3-node24`. Python is 3.14.4. No downloads were needed. Default Node test process isolation reports only a file-level failure in this sandbox; `--test-isolation=none` permits the tests to execute and report assertions.

Final commands:

```sh
/tmp/r3-node24 --test --test-isolation=none gateway/tests/my-key-client.test.mjs gateway/tests/my-key-reset.test.mjs tools/key-reset-broker.test.mjs tools/key-reset-integration.test.mjs tools/organization-resolve.test.mjs
```

85 tests: **84 passed, 1 failed**, no skips or cancellations. Breakdown: client 6/6, gateway reset 25/25, broker 36/36, integration 8/8, organization 9/10.

```sh
/tmp/r3-node24 --test --test-isolation=none --test-name-pattern='^(UTC windows|limits map|model shares|dialog installer|pure mapping|percentages use|upstream limits only|usage ownership rejects|served script)' gateway/tests/my-key.test.mjs
```

11 socket-free tests: **11 passed, 0 failed**.

The failing test is `startup exports quick-line configuration and preserves a container override for child processes` at `tools/organization-resolve.test.mjs:116`; line 127 receives empty stdout instead of `fast'model`. Its source/assertions were not changed. Direct diagnostics of `spawnSync` show an EPERM error and empty captured Node output in this sandbox. The original HEAD test was also run, with its relative gateway/image dependencies linked into a temporary directory:

```sh
/tmp/r3-node24 --test --test-isolation=none --test-name-pattern='^startup exports quick-line' /tmp/r3-baseline/tools/organization-resolve.test.mjs
```

**0 passed, 1 failed**, with the identical empty-stdout assertion. This is an environment limitation, not reported as a pass.

Syntax and whitespace commands:

```sh
/tmp/r3-node24 --check gateway/my-key-client.mjs
/tmp/r3-node24 --check gateway/my-key-reset.mjs
/tmp/r3-node24 --check gateway/my-key.mjs
/tmp/r3-node24 --check tools/key-reset-broker.mjs
/tmp/r3-node24 --check tools/browser-tests/my-key.e2e.mjs
/tmp/r3-node24 --check gateway/tests/my-key-client.test.mjs
/tmp/r3-node24 --check gateway/tests/my-key-reset.test.mjs
/tmp/r3-node24 --check tools/organization-resolve.test.mjs
/tmp/r3-node24 --check tools/key-reset-integration.test.mjs
python3 -I -B - <<'PY'
import ast
from pathlib import Path
files = list(Path('tools').rglob('*.py'))
for file in files:
    ast.parse(file.read_bytes(), filename=str(file))
print(f'{len(files)} Python files parsed; 0 failures')
PY
git diff --check
```

All nine JavaScript syntax checks passed; nine Python files parsed with zero failures; diff whitespace check passed. Changed source/test files were also scanned for `sk-` literals followed by 16 or more allowed characters: zero violations.

Regression development runs (before fixes or before updating explicitly changed behavior):

- `node --test --test-name-pattern='uncertain rotations|store helper returns|malformed inflight|claim transport|successful delivery|staged lookup' tools/key-reset-broker.test.mjs`

  Default isolation: one file-level failure, no individual test results.

- `node --test --test-name-pattern='store helper returns' tools/key-reset-broker.test.mjs`

  Same file-level failure.

- `node --test --experimental-test-isolation=none --test-name-pattern='store helper returns' tools/key-reset-broker.test.mjs`

  0 passed, 1 expected regression failure.

- `/tmp/r3-node24 --test --test-name-pattern='uncertain rotations|store helper returns|malformed inflight|claim transport|successful delivery|staged lookup' tools/key-reset-broker.test.mjs`

  Default isolation: one file-level failure.

- `/tmp/r3-node24 --test --test-isolation=none --test-name-pattern='uncertain rotations|store helper returns|malformed inflight|claim transport|successful delivery|staged lookup' tools/key-reset-broker.test.mjs`

  Initially 0 passed/6 failed; after fixes 6 passed/0 failed.

- `/tmp/r3-node24 --test --test-isolation=none tools/key-reset-broker.test.mjs`

  Iterations: 27 passed/6 failed (old behavior assertions); 33/2 (unreadable-prefix missing-file catch); then 35/0. Final added recovery test is included in the final 36/0 above.

- `/tmp/r3-node24 --test --test-isolation=none --test-name-pattern='restart after staging' tools/key-reset-broker.test.mjs`

  0 passed/1 failed before recovered-claim replay fix.

- `/tmp/r3-node24 --test --test-isolation=none --test-name-pattern='recovered success without' tools/key-reset-broker.test.mjs`

  0 passed/1 failed before persisting recovered success.

- `/tmp/r3-node24 --test --test-isolation=none --test-name-pattern='restart after staging|recovered success without' tools/key-reset-broker.test.mjs`

  2 passed/0 failed; independent review repeated it with the same result.

- `/tmp/r3-node24 --test --test-isolation=none gateway/tests/my-key-client.test.mjs tools/key-reset-broker.test.mjs`

  Independent review: 41 passed/0 failed before the final added broker recovery test.

- `/tmp/r3-node24 --test --test-isolation=none gateway/tests/my-key-client.test.mjs`

  Initial four regressions failed; final six tests passed.

- `node --test gateway/tests/my-key-reset.test.mjs tools/organization-resolve.test.mjs tools/key-reset-integration.test.mjs`

  Default isolation: 0 passed/3 file-level failures.

- `/tmp/r3-node24 --test --test-isolation=none gateway/tests/my-key-reset.test.mjs tools/organization-resolve.test.mjs tools/key-reset-integration.test.mjs`

  Initial 33 passed/9 failed: eight expected regressions plus the unchanged startup environment failure.

- `/tmp/r3-node24 --test --test-isolation=none gateway/tests/my-key-reset.test.mjs tools/key-reset-integration.test.mjs`

  33 passed/0 failed after gateway fixes.

- `/tmp/r3-node24 --test --test-isolation=none gateway/tests/my-key-reset.test.mjs tools/key-reset-integration.test.mjs tools/organization-resolve.test.mjs`

  42 passed/1 unchanged startup environment failure.

## Not run and limitations

- Browser/Playwright execution, screenshots, and live visual checks, including `tools/browser-tests/my-key.e2e.mjs`: the sandbox cannot start a browser or listen on TCP. The updated 360/390 light/dark assertions still require browser CI.
- Socket-based My key tests in `gateway/tests/my-key.test.mjs`; only its eleven pure tests were selected. Other repository browser/socket suites and the complete `tools/check.sh` suite were not run under these restrictions.
- No real SSH, Docker rotation, external key store or deployed workspace was contacted. Broker/integration tests use actual Python helpers and local files; upstream HTTP is exercised through in-memory transport fixtures.
- S11 intentionally limits daily completion lookup to today's file. The last outcome ordinarily provides retry deduplication across midnight. If the previous day's count was saved but the last outcome was not saved before midnight, recovery can also charge the new day. The organization documentation now states this narrow limit instead of claiming unconditional cross-midnight protection.
- The existing organization startup test needs rerunning in an environment that permits normal child-process output capture.

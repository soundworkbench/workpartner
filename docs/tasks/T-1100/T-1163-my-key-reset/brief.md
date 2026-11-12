# T-1163 My key: a "Reset key" button (gateway and page)

This is a **public repository**. Code, comments, test names and commit-facing text are in English and must not contain internal
names, host names, people's names, real identifiers or real keys. Only user-interface copy is Chinese (with English alternatives).
All fixtures use made-up data.

## Goal
In the "My key" dialog a signed-in person can replace their own model key: a "重置钥匙" button, one confirmation, the old key dies,
the new key is installed into their workspace (which restarts once), and the dialog goes back to the masked view of the new key.
The gateway itself cannot change a key upstream; it asks a separate **key-reset broker** through files (protocol below) and then
installs what the broker prepared. Another task writes the broker (`tools/key-reset-broker.mjs`) in parallel; **do not write the
broker here** — for tests use a small stand-in that follows the protocol.

## Read first
- `gateway/my-key.mjs`, `gateway/my-key-client.mjs` (the whole feature today), `gateway/tests/my-key.test.mjs`,
  `tools/browser-tests/my-key.e2e.mjs`, `tools/browser-tests/lib/harness.mjs` (`startGateway`, `startModelGateway`, `modelFixture`).
- `gateway/gateway.mjs` around `createMyKey(...)` (wiring; `runtime`, `aionui.forget`, `modelKeyFor`, `organizationData`).
- `gateway/runtime/k8s.mjs` (`create` writes the Secret `<container>-model-key` from the key file; `restart`; `exclusive`; `ensure`),
  `gateway/runtime/docker.mjs` (the key file is bind-mounted as a single file), `gateway/migration.mjs` (`guardRuntime`, its `writes` set),
  `tools/runtime-k8s.test.mjs`.
- `gateway/feishu-onboarding.mjs` (an existing caller of `runtime.restart` with a `restarted` callback).
- `docs/organization.md` (the `myKey` paragraphs), `gateway/organization/default.json`.

## Shared file protocol (identical text in the gateway brief and the broker brief — implement it exactly)

Two parties that never talk over the network:
- the **gateway** (this repository's `gateway/`), which knows who is signed in but holds no credential that could change a key upstream;
- the **key-reset broker** (`tools/key-reset-broker.mjs`), a small service an operator runs on a separate machine that can already
  reach both the gateway host and the key-store host. It polls the gateway host for requests, makes the new key value, rotates the
  key in the upstream key store and hands the result back.

Names: `S` = `organization.runtime.stateDirectory`, `K` = `organization.runtime.secureDirectory`, `P` = `organization.model.keyPrefix`,
the person's key file = `K/<P><slug>.key`. `R` = `S/my-key/reset`. All directories are mode 0700, all files 0600. JSON files are
written to `R/tmp/<random>` first and then renamed into place, so a reader never sees a partial file.

| path | written by | content |
|---|---|---|
| `R/broker.json` | broker, on every poll | `{"at":"<ISO time>"}` heartbeat |
| `R/active/<slug>.json` | gateway (exclusive create, `wx`) | `{"id","at"}` — at most one attempt per person at a time |
| `R/requests/<id>.json` | gateway | `{"id","slug","at"}`; `id` = 32 lowercase hex chars (16 random bytes); never contains a key |
| `R/claimed/<id>.json` | broker (atomic rename of the request file) | same content; from here on the broker owns the attempt |
| `K/<P><slug>.key.<id>.next` | broker | the new key value only (no JSON); same owner as the key file, mode 0600 |
| `R/results/<id>.json` | broker | `{"id","slug","ok":true|false,"code":"<word>","at"}`; the broker then deletes `claimed/<id>.json` |

Rules:
1. `slug` matches `^[a-z0-9][a-z0-9-]{0,62}$`, `id` matches `^[0-9a-f]{32}$`. Anything else is ignored (never used to build a path).
2. The broker takes a request **only** by renaming `requests/<id>.json` to `claimed/<id>.json`. The gateway gives up on a request that
   nobody took **only** by unlinking `requests/<id>.json`. Exactly one of the two succeeds; the loser gets `ENOENT` and must respect it.
3. A result with `ok:false` is written only when the key in the upstream store is **unchanged** (the person's old key still works), and the
   broker has removed the `.next` file. A result with `ok:true` means the upstream store now accepts **only** the value in the `.next`
   file; the old value is dead and there is no way back, so the gateway must finish installing it however often it has to retry.
4. `code` for `ok:false`: `denied` (not allowed by policy), `limit` (broker's own daily limit), `stale` (request time outside the
   broker's window), `replay` (id seen before), `no-key` (no key file, or the key is not exactly one entry of the store),
   `rotate-failed`, `interrupted`. For `ok:true` the code is `ok`.
5. Policy lives in the organization file under `myKey` and is re-read by both sides for every decision:
   `allow` (array: `*`, a slug or a unionId — unchanged meaning), `reset.enabled` (must be exactly `true`),
   `reset.blocked` (array: `*`, a slug or a unionId — these people may not reset). A person may reset only when `reset.enabled === true`,
   they are admitted by `allow` and not matched by `reset.blocked`. Unreadable or malformed policy = nobody may reset.
6. Each side counts for itself and does not trust the other: at most 3 completed resets per person per UTC day on the gateway, at most
   3 rotations per person per UTC day in the broker.
7. No key value (old or new) ever appears in a request, a result, a log line, an audit line, an error message or a process argument.
   The only places a key value may exist: the key file, the `.next` file, the upstream store, process memory, and standard input of a
   child process.
8. Directories: the gateway already creates `S/my-key`. Either side creates a missing `R` or a missing subdirectory of `R` (`tmp`,
   `active`, `requests`, `claimed`, `results`) with mode 0700 and the owner of its parent directory; every file the broker writes inside
   `R` gets the owner of `R`. The broker never creates `S/my-key`; while that is missing it does nothing at all.
9. Heartbeat: `R/broker.json` carries the **gateway host's** clock (the broker's helper runs there), and the broker writes it only while
   the key store has answered it within the last 60 seconds. The gateway treats a heartbeat that is missing, unreadable or older than
   45 seconds as "broker unavailable" and does not accept a reset then. The broker judges a request's age against the gateway host's
   clock too, so the two machines' clocks never need to agree.
10. Stale leftovers: the gateway removes files in `R/results` and `R/tmp` that are older than one hour and that no `R/active/*.json`
   refers to. The broker never deletes anything in `R/requests`, `R/active` or `R/tmp`.

## What to do

### 1. Configuration
`myKey` gains `"reset": { "enabled": false, "blocked": [], "blockedNote": "" }` (add to `gateway/organization/default.json`, describe in
`docs/organization.md`; adjust `tools/organization-resolve.test.mjs` / `tools/gateway.test.mjs` only if a default comparison needs it).
- Re-read on every request through the existing `policy()`; malformed values mean "disabled / nobody".
- `enabled` must be exactly `true`. `blocked`: array of strings (`*`, slug or unionId); not an array of strings = everybody blocked.
- `blockedNote`: optional string shown to a blocked person (trimmed, at most 200 chars; not a string = empty).

### 2. Runtime: `rekey(slug)`
- `gateway/runtime/k8s.mjs`: add `rekey(slug)` (inside `exclusive`): read the person's key file exactly as `create` does; if the Secret
  `<container>-model-key` exists, replace its `model.key` data with the file content; if it does not exist, do nothing (`create` makes it
  later). It must not touch the StatefulSet, the Pod or anything else. Export it.
- Docker runtime: no `rekey` (the key file is a bind-mounted single file; overwriting it in place is enough — see 3.4).
- `gateway/migration.mjs`: add `'rekey'` to the `writes` set of `guardRuntime` so the ownership guard covers it.
- Unit tests in `tools/runtime-k8s.test.mjs` (existing fake API style): Secret updated when present, nothing created when absent, nothing
  else patched or deleted.

### 3. Gateway module
Put the reset logic in a new file `gateway/my-key-reset.mjs` (keep `my-key.mjs` readable) and route it from `createMyKey`.
`createMyKey` gets optional dependencies, all injectable for tests:
`runtime` (uses `inspect`, `restart`, optional `rekey`), `restarted = slug => {}`, `keyFile = user => path` (the person's key file),
`timers` / timing options (claim timeout, heartbeat age, poll interval, retry delays) with production defaults given below.
Wire them in `gateway/gateway.mjs` (`runtime`, `restarted: slug => aionui.forget(slug)`, the key file path next to `modelKeyFor`).
If `runtime` is not given, the reset feature is off (as if `enabled` were false).

#### 3.1 `GET /_wp/api/my-key` — one new field
`reset: null` when the feature is off (`reset.enabled !== true` or no runtime). Otherwise
`reset: { status: 'idle'|'pending', allowed: boolean, reason: null|'blocked'|'limit'|'unavailable'|'no-key', note: string, left: 0..3, limit: 3 }`:
- `status: 'pending'` while this person has an attempt in flight (`R/active/<slug>.json` exists);
- `reason` (first that applies): `blocked` (matched by `reset.blocked`; `note` = `blockedNote`, otherwise `note` is `''`), `no-key` (no key
  file), `limit` (`left === 0`), `unavailable` (`R/broker.json` missing, unreadable or older than 45 s);
- `allowed` = no reason and status is `idle`. `left` = 3 minus this person's completed resets in the current UTC day.
Nothing else in this reply changes.

#### 3.2 `POST /_wp/api/my-key/reset`
Same gate order and checks as `/reveal`: session (401) → admitted by `allow` (empty 404) → method (405) → `Origin` equals the public
origin and JSON content type (403) → body at most 1 KB of JSON that is exactly an object with `confirm === 'reset'` (400 otherwise).
Feature off → empty 404 (same as not admitted). Then, with a per-person in-process mutex around the whole decision:
- blocked → 403 `{ error, reason: 'blocked' }`; no key file → 409 `no-key`; `left === 0` → 429 `limit`;
  more than 10 accepted attempts by this person in the current UTC day → 429 `limit`;
  heartbeat stale → 503 `unavailable`; an attempt already in flight → 409 `busy`.
- otherwise: create `R/active/<slug>.json` with flag `wx` (if it exists → 409 `busy`; this is what makes two simultaneous clicks, even
  across two gateway processes, produce one attempt), count the attempt, append the audit line, write `R/requests/<id>.json`,
  start the driver (3.4) and reply **202** `{ status: 'pending' }` without waiting.
- If anything fails after `active` was created and before the request file exists, remove `active` again and reply 503.
`error` keeps the fixed text `'My key request failed'`. Replies never contain a key.

#### 3.3 `GET /_wp/api/my-key/reset` (cheap status poll; no upstream call)
Same session/admission gates (401 / empty 404; feature off → empty 404). Reply
`{ status: 'idle'|'pending'|'done'|'failed', code: string, left, allowed, reason, note }`:
`pending` while in flight; otherwise the outcome of this person's latest attempt if it ended less than 10 minutes ago (`done`, or `failed`
with `code` = the broker's code or `unavailable`); otherwise `idle`. Keep the latest outcome in `R/last/<slug>.json` (`{id,status,code,at}`).

#### 3.4 Driver (one per in-flight attempt; also started for every `R/active/*.json` found at gateway start)
Every step must be safe to repeat and must tolerate "already done" (a second gateway process or a restart may be doing the same).
Loop about once per second until the attempt ends:
1. `R/results/<id>.json` with `ok:false` → audit `failed` with the code, write `last` (`failed`), delete the result file, any `.next`
   file of this id and `active`. End. (The person's key is unchanged.)
2. `R/results/<id>.json` with `ok:true` → **install, retrying forever** (delay 2 s, doubling to at most 60 s; never give up, never
   delete the `.next` file before the key file is verified):
   a. read `K/<P><slug>.key.<id>.next` (trimmed). If it is missing: if `last`/the day file already records this id as done, skip to (e);
      otherwise keep retrying (audit `stuck`, step `staged-missing`, once).
   b. advisory check: `GET <model.baseUrl>/magpie/me` with the new key (existing `upstream()` helper) — up to 3 tries 2 s apart. The
      result is only recorded (`verified: true|false` in the audit line); install continues either way, because the old key is dead.
   c. overwrite the **existing** key file in place with the new value (open `r+`, write, truncate, `fsync`; do not rename over it and do
      not change owner or mode — a container may have this very inode bind-mounted), read it back and compare.
   d. `await runtime.rekey?.(slug)`; then `const state = await runtime.inspect(slug)`; if `state.exists && state.running` →
      `await runtime.restart(slug)` and `restarted(slug)`.
   e. record the completed reset for today (by id, so repeating does not count twice), audit `ok`, write `last` (`done`), delete the
      `.next` file, the result file and `active`. End.
   Each failing step appends one audit line `{…, result: 'retry', step: 'install'|'rekey'|'restart'|'record', code: <system code or 'ERROR'>}`
   the first time and then at most once per 10 minutes, so an operator can see where it is stuck.
3. No result yet and `R/requests/<id>.json` still exists after 30 s → `unlink` it. Success → audit `failed` / `unavailable`, write
   `last`, delete `active`. End. `ENOENT` → the broker has claimed it; keep waiting.
4. Claimed but no result after 10 minutes → audit `stuck` (step `broker`) once; keep waiting (do not delete anything).
`active` with an unreadable body, or one whose id has no request, claim, result or `.next` file and is older than 2 minutes, is removed
(audit `failed` / `invalid`).

#### 3.5 Audit and logs
Append to the existing `S/my-key/audit.log` (same directory/file modes, `flush: true`):
`{ at, slug, action: 'reset', result: 'requested'|'ok'|'failed'|'retry'|'stuck', id, code?, step?, verified? }`.
Existing `show`/`copy` lines keep exactly their three fields. `console.error` only prints `[my-key] <fixed code>` as today.
No key value, upstream body or error message in the audit, in logs or in any reply.

### 4. Page (`gateway/my-key-client.mjs`)
Keep the existing look and helpers (`node`, `mark`, `button`, `t`, `textContent` only, no `innerHTML`).
- When `data.reset` is an object, the key card's action row gets a third button `[data-wp-my-key-action="reset"]` "重置钥匙" / "Reset key",
  styled as a **danger outline**: transparent background, border and text `var(--wp-my-key-over)` (already defined: `#b42318` light,
  `#ffb4a9` dark). When `data.reset` is `null` the button does not exist.
- Disabled (with `aria-disabled` semantics via `disabled`) when `!data.reset.allowed`, with a muted line `[data-wp-my-key-reset-note]` under
  the row:
  - `blocked`: `data.reset.note` if non-empty, else `这把钥匙暂不支持自助重置；需要更换请联系管理员。` / `This key cannot be reset here. Ask an administrator to replace it.`
  - `limit`: `今天的重置次数已用完（每天 3 次），明天再试。` / `No resets left today (3 per day). Try again tomorrow.`
  - `unavailable`: `暂时无法重置，请稍后再试。` / `Resetting is unavailable right now. Please try again later.`
  - `no-key`: no line (the card already says no key is assigned).
  - status `pending` (e.g. dialog reopened during a reset): `正在重置钥匙…` / `Resetting the key…`, and start polling (below).
- Click → an inline confirmation panel `[data-wp-my-key-confirm]` inside the key card (`role="alertdialog"`, labelled by its title), the
  action row is hidden while it is open, focus moves to Cancel, Escape/Cancel closes the panel only (not the dialog). Content, exactly:
  - title `确认重置钥匙？` / `Reset this key?`
  - `旧钥匙会立刻作废，无法恢复。` / `The old key stops working immediately and cannot be restored.`
  - `你的工作伙伴会重启约 1 分钟，进行中的对话会中断。` / `Your workspace restarts for about a minute; a conversation in progress is interrupted.`
  - `在自己电脑的工具里填过旧钥匙的，需要自己换成新钥匙。` / `Tools on your own computer that use the old key must be given the new one by you.`
  - muted `今天还可以重置 N 次。` / `N resets left today.`
  - buttons `[data-wp-my-key-action="reset-cancel"]` `取消` / `Cancel` and `[data-wp-my-key-action="reset-confirm"]` `确认重置` / `Reset`
    (solid danger: background `var(--wp-my-key-over)`, text `var(--wp-card, #FDFDF8)`).
- Confirm → `POST /_wp/api/my-key/reset` with `{ confirm: 'reset' }` (same fetch options as reveal). While in flight: hide any shown key
  (`hide()`), disable show/copy/copy-config/reset, status line `[data-wp-my-key-status]` = `正在重置钥匙，工作伙伴会重启约 1 分钟…` /
  `Resetting the key; your workspace restarts for about a minute…`. Poll `GET /_wp/api/my-key/reset` every 2 s:
  - `done` → reload the dialog data (`GET /_wp/api/my-key`) so the masked value is the new key, then show the success line
    `[data-wp-my-key-reset-result="done"]`: `钥匙已重置，旧钥匙已作废。在自己电脑的工具里填过旧钥匙的，请点「显示」查看新钥匙并自己换上。` /
    `The key has been reset and the old one no longer works. If tools on your own computer used the old key, press Show and give them the new one.`
    The new key is **not** shown automatically.
  - `failed` → `[data-wp-my-key-reset-result="failed"]`: `暂时无法重置，请稍后再试。你现在的钥匙没有变，可以照常使用。` /
    `Resetting is unavailable right now. Please try again later. Your current key is unchanged and still works.`; reload data.
  - POST answers 409 `busy` → treat as pending (poll). 429 → the `limit` line. 403 `blocked` → reload data. 503 / network error → the
    `failed` line. 401/404 → the existing `revoke()` behaviour.
  - still `pending` after 5 minutes → `还在处理中，请稍后重新打开「我的钥匙」查看。` / `Still working. Reopen My key later to check.`; stop polling.
  - Closing the dialog stops polling (use the existing `version` guard); reopening shows the pending state from `data.reset.status`.
- Notes list, item 5: when `data.reset` is an object and its reason is not `blocked`:
  `怀疑泄露，马上点上面的「重置钥匙」换一把新的。` / `If you suspect it has leaked, press "Reset key" above right away to get a new one.`
  Otherwise keep the current sentence (contact an administrator).
- No horizontal overflow and no clipped text at 390px and 360px wide, with the confirmation panel open and with the disabled-note line.

### 5. Tests (they are the acceptance; they run on GitHub Actions)
Unit (`gateway/tests/my-key-reset.test.mjs`, same fixture style as `my-key.test.mjs`; drive the broker side by writing protocol files
directly; use short injected timings, no real sleeps over ~100 ms):
- gates: no session 401; not admitted → empty 404 on POST and status GET; feature off (`enabled` false / missing / `"true"` / no runtime) → 404
  and `reset: null`; wrong origin / content type 403; missing or wrong `confirm`, non-object, oversized body 400; GET on POST route 405;
- blocked by slug, by unionId and by `*` → 403 `blocked`, `reset.reason === 'blocked'`, `note` from `blockedNote`; policy re-read per request;
- success: 202, exactly one request file with only `id, slug, at`; simulate claim + `.next` + `ok:true` → key file content replaced
  **in place** (same inode number as before), `rekey` then `inspect` then `restart` then `restarted` called once each in that order
  (restart skipped when `inspect` says not running or not existing), status `done`, `left` 2, `.next`/result/`active` gone, GET shows the new mask;
- old key dead / new key live: fixture upstream that accepts only the current store value — after the reset the dialog GET (which calls
  upstream with the key file) succeeds with the new key and a request with the old key gets 401; `verified: true` in the audit;
- failure fallback: `ok:false` (each code) → status `failed` + code, key file byte-identical to before, `left` unchanged, `.next` removed;
- broker offline: stale/missing heartbeat → 503 `unavailable`, nothing written; heartbeat fresh but nobody claims → after the claim
  timeout the request file is gone, status `failed` / `unavailable`, key unchanged; request claimed just before the timeout → keeps waiting;
- limit: after 3 completed resets the 4th POST → 429 and `reason: 'limit'`; counter survives a new `createMyKey` on the same state
  directory (restart) and resets on the next UTC day; the attempts cap;
- concurrency: two simultaneous POSTs (same handler) → one 202 and one 409, one request file; a second handler instance on the same state
  directory also gets 409;
- recovery: `active` + `ok:true` result + `.next` present at construction (gateway restarted mid-way) → installed without any POST;
  `rekey` / `restart` throwing twice then succeeding → retried, ends `done`, audit has `retry` lines with the step; install repeated after
  completion is a no-op (no double count);
- secrecy: neither key value appears in the audit log, in any reply of the reset routes, in captured `console.error` output, or in the
  request/`last`/day files; `show` after a reset returns the new key and still writes its three-field line.
Browser (`tools/browser-tests/my-key.e2e.mjs`, group `my-key`; add what is needed to `lib/harness.mjs` / `lib/browser.mjs`):
- give the harness a stand-in broker for a gateway run (a function that follows the protocol on that run's directories: heartbeat,
  claim, `.next`, result) with switches for `ok`, a failure code, "offline" (no heartbeat) and "never claims"; make the model fixture
  accept the new key value and reject the old one after a successful reset;
- with a real gateway and `reset: { enabled: true }`: the danger button is present; click → confirmation panel with exactly the three
  sentences and the remaining count; Cancel closes it and nothing was requested; Confirm → progress line → success line, the masked
  value's last four characters change, Show reveals a value different from the old fixture key, the audit has `requested` and `ok`;
- failure (`ok:false`) and offline: the `failed` / `unavailable` texts, the mask is unchanged, Show still reveals the old key;
- blocked (with and without `blockedNote`), limit (drive with `page.route(...).fulfill` or three real resets — the cheaper way) and
  `reset: null`: disabled states / absent button, and the notes item 5 wording in each case; English after switching language;
- double click on Confirm sends one POST;
- layout: at 390x844 and 360x740 with the confirmation panel open, and with the blocked note: no horizontal overflow (existing
  `overflow` helper), the panel and its buttons stay inside the dialog; the danger button's computed colours differ from the normal buttons;
- screenshots with `suite.shot` (masked fixture key only): `reset-button-light-desktop`, `reset-confirm-light-390x844`,
  `reset-confirm-dark-390x844`, `reset-done-light-390x844`, `reset-blocked-light-360x740`.
Update the existing `NOTES` expectation and any test that pins the full GET key set (`reset` is a new top-level key). Keep every other
existing test of the group passing; do not weaken unrelated assertions.

## Scope
- May change: `gateway/my-key.mjs`, `gateway/my-key-client.mjs`, new `gateway/my-key-reset.mjs`, `gateway/gateway.mjs` (wiring only),
  `gateway/runtime/k8s.mjs` (`rekey` only), `gateway/migration.mjs` (the one set entry), `gateway/organization/default.json`,
  `docs/organization.md`, `gateway/tests/my-key.test.mjs`, new `gateway/tests/my-key-reset.test.mjs`, `tools/runtime-k8s.test.mjs`,
  `tools/browser-tests/my-key.e2e.mjs`, `tools/browser-tests/lib/harness.mjs`, `tools/browser-tests/lib/browser.mjs`, and — only if a
  default comparison requires it — `tools/gateway.test.mjs`, `tools/organization-resolve.test.mjs`, `tools/migration.test.mjs`.
- Do not create `tools/key-reset-broker.mjs` or anything under `tools/key-reset/` (the parallel task owns them). No workflow files,
  no Dockerfile, no dependencies, no other gateway modules. If something else seems necessary, say so in the report instead of doing it.

## Environment and constraints
- You work in this git worktree only (branch `T-1163-my-key-reset`, based on the current `origin/main`). **Do not run `git checkout`,
  `git switch`, `git commit`, `git stash` or any other command that changes branches or history.** The coordinator commits.
- Sandbox: workspace-write, **no network**. Node is installed. `gateway/node_modules` may be missing; these unit tests only need Node
  built-ins. Listening on `127.0.0.1` may be refused inside the sandbox: run what you can (`node --check` on every changed module,
  `node --test gateway/tests/my-key.test.mjs gateway/tests/my-key-reset.test.mjs tools/runtime-k8s.test.mjs`) and report exactly which
  tests could not run and why; the coordinator runs the full set outside the sandbox and on GitHub Actions. Do not start a browser here.
- Do not install dependencies. Do not run the whole `tools/check.sh` if it needs things the sandbox lacks; say so.
- Only necessary comments, explaining what the code cannot show. Tests assert behaviour through the public functions and HTTP replies.
- Work in this order so a partial result is still useful: runtime `rekey` → gateway module + unit tests → page → browser tests → docs.

## Report
Write the report to `docs/tasks/T-1100/T-1163-my-key-reset/report.md`, in Chinese:
1. Files changed, one sentence each.
2. How it was verified: commands and results (and which tests could not run in the sandbox).
3. Anything the coordinator must handle: out-of-scope needs, open questions, decisions you took where this brief left room.

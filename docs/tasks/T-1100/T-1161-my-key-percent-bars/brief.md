# T-1161 My key: show usage as percentage bars, never as amounts

This is a **public repository**. Code, comments, test names and commit-facing text are in English and must not contain internal
names, host names, people's names, real identifiers or real keys. Only user-interface copy is Chinese (with English alternatives).
All fixtures use made-up data.

## Goal
In the "My key" dialog the usage card shows one progress bar for **today** and one for **this week** with "已用 NN%".
No amount of money is shown on the page and no amount is returned by the API any more (nothing to find in the browser's developer tools).
Also close one ownership gap in the usage mapping (item 4).

## Background
Read these first; they are the whole feature:
- `gateway/my-key.mjs` — routes, policy (`policy()` re-reads `organizationData()?.myKey` on every request), upstream calls, pure mapping
  functions `mapLimits`, `mapUsage`, `mapUpstream`.
- `gateway/my-key-client.mjs` — the dialog script (`renderUsage`, `styles`).
- `gateway/tests/my-key.test.mjs` — unit tests. `tools/browser-tests/my-key.e2e.mjs` and `tools/browser-tests/lib/harness.mjs`
  (`modelFixture`, `startGateway`) — browser tests, group `my-key`.
- `gateway/organization/default.json` (`myKey` block), `docs/organization.md` (the `myKey` section),
  `tools/gateway.test.mjs` and `tools/organization-resolve.test.mjs` (they mention `myKey`).

Today the GET reply contains `usage.today.cost`, `usage.week.cost` and `usage.limits` (`limit` / `used` / `left` amounts) and the page prints
`$3.20`, an "amounts are estimates" line, "暂不限额" and limit rows with amounts. All of that goes away.

Keys currently have no real limit upstream. 100% is therefore a configurable **weekly reference allowance**; going over it only changes the
bar's colour. Nothing is blocked.

## What to do

### 1. Configuration (`myKey.reference`, re-read on every request like `allow`)
```json
"myKey": { "allow": [], "publicBaseUrl": "", "revealSeconds": 30, "reference": { "weekly": 0, "accounts": {} } }
```
- `reference.weekly`: a finite number > 0 = the weekly reference allowance for everyone, in the same unit as the upstream `cost`.
  Anything else (0, missing, string, negative, NaN) = no reference configured.
- `reference.accounts`: optional object; a key equal to the person's `slug` or `unionId` with a finite number > 0 overrides `weekly` for that
  person (slug wins over unionId). Invalid entries are ignored (fall back to `weekly`). Not an object = ignored.
- The reference for **today** is the person's weekly reference divided by 5 (five working days). No separate setting.
- A corrupt or unreadable organization file keeps failing closed exactly as today (empty allow list → 404).
- Add the default (`"reference": { "weekly": 0, "accounts": {} }`) to `gateway/organization/default.json` and describe it in
  `docs/organization.md` (what it is, that it is only a display yardstick and blocks nothing, today = weekly / 5, re-read per request).
  Adjust `tools/organization-resolve.test.mjs` / `tools/gateway.test.mjs` only if a default-comparison there needs the new key.

### 2. API reply (`GET /_wp/api/my-key`)
`usage` becomes exactly:
```
usage: null                                   // profile call failed (unchanged)
usage: { today, week, enforced }
  today: null | { start, reset, calls, percent, over }
  week:  null | { start, reset, calls, percent, over, models }
  enforced: boolean
```
- `percent`: `null` when no reference applies to this person; otherwise an integer:
  `cost <= 0 → 0`, else `Math.min(999, Math.max(1, Math.round(cost / reference * 100)))` (today uses today's cost and weekly/5).
- `over`: `percent !== null && percent >= 100`.
- `calls`, `models` (name + share) unchanged. `start` / `reset` are **always the computed UTC windows** (`usageWindows`); they are no longer
  replaced by an upstream limit's window.
- `enforced`: `true` when the upstream profile carries at least one valid `day` or `week` limit (what `mapLimits` accepts today), else `false`.
  It only switches one sentence on the page (see 3). `mapLimits` may stay as an internal helper, but **its output must not be put in the reply**.
- The reply must contain **no amount at all**: no `cost`, no `limits`, no `limit` / `used` / `left` / `costLimit` / `costLeft`, and not the
  reference value itself (`reference`, `weekly`). Build the reply field by field as now. The upstream `cost` values are used only inside
  the gateway process to compute `percent` and the model shares.
- Everything else in the reply (`key`, `revealSeconds`, `baseUrl`, `defaults`, `models`) and the `/reveal` route are unchanged.

### 3. Page (`renderUsage` and `styles` in `gateway/my-key-client.mjs`)
Keep the existing look (same `--wp-*` variables, same tiles grid, same class naming). For each period one tile
`[data-wp-my-key-usage="today"|"week"]` (`data-state="ready"|"unavailable"` as now):
- title `今天` / `本周` (`Today` / `This week`);
- when `percent` is a number:
  - `[data-wp-my-key-percent]` with text `已用 NN%` (`NN% used`); for 999 print `已用 999%+` (`999%+ used`);
  - a track `.wp-my-key-track[role="progressbar"]` with `aria-label` = the title, `aria-valuemin="0"`, `aria-valuemax="100"`,
    `aria-valuenow` = `Math.min(100, percent)`, `aria-valuetext` = the percent text; the fill `.wp-my-key-fill` has width `min(100, percent)%`;
  - the tile gets `data-level="normal"` (< 80), `"warn"` (80–99) or `"over"` (≥ 100);
  - when over, a short line `[data-wp-my-key-over]`: `已超过今天参考额度` / `已超过本周参考额度`
    (`Over today's reference allowance` / `Over this week's reference allowance`);
- always (when the tile is ready) a small muted line `[data-wp-my-key-calls]`: `N 次` (`N requests`);
- when `percent` is `null` (no reference configured): **no** percent text and **no** progress bar, only the title and the calls line
  (`data-level` absent). Still no amount.
- Colours: normal fill = `var(--wp-send, #3C3F43)` (as the existing `.wp-my-key-fill`). Warn and over use the house design-system palette,
  for the fill, the percent text and the over line:
  warn `#9a3412` (light) / `#ffcf85` (dark), over `#b42318` (light) / `#ffb4a9` (dark). Dark = `html[data-theme="dark"]`, the selector the
  stylesheet already uses. Define them once as custom properties on `.wp-my-key-dialog` (e.g. `--wp-my-key-warn`, `--wp-my-key-over`).
- Keep the window sentence `[data-wp-my-key-window]` but drop the limit reference at its end:
  `今天从北京时间 08:00 起算；本周从周一 08:00（北京时间）起算。` /
  `Today starts at 08:00 Beijing time; the week starts on Monday at 08:00 Beijing time.` (times still computed from `start`).
- A muted note `[data-wp-my-key-reference-note]`, shown only when at least one of the two tiles has a numeric `percent`:
  - `enforced === false`: `进度条按每周参考额度计算，今天按它的五分之一；目前超过不会停用，只作提醒。` /
    `The bars are measured against a weekly reference allowance (one fifth of it per day). Going over does not stop the key for now; it is only a reminder.`
  - `enforced === true`: `进度条按每周参考额度计算，今天按它的五分之一。这把钥匙另设有用量上限，达到后会暂停，详情请问管理员。` /
    `The bars are measured against a weekly reference allowance (one fifth of it per day). This key also has a usage limit; it pauses when the limit is reached. Ask an administrator for details.`
- Keep the `本周常用：…` model-share line.
- Remove: `money`, `[data-wp-my-key-cost]`, `[data-wp-my-key-estimate]` (the "amounts are estimates" line), `[data-wp-my-key-limits]`
  with its limit rows and `暂不限额`, and `beijingReset` if nothing uses it any more. The served script must not contain the strings `'$'`,
  `估算`, `金额`, `暂不限额`.
- No horizontal overflow and no clipped text at 390px and 360px wide (the two tiles may stay side by side as now).
- Everything is still written with `textContent`; no `innerHTML`.

### 4. Ownership gap in `mapUsage` (`gateway/my-key.mjs`, the check around `callerKeys`)
Today, when `callerKeys` is empty the totals are accepted without knowing whose they are (an unrestricted key would receive the whole
ledger; calls made without any key appear in `by.callerKey` as one entry that is not this person's). New rule — otherwise `today` and `week`
are `null` ("unavailable"):
- `callerKeys` is empty **only if** `calls === 0`, `cost === 0` and `by.callerKey` is empty (a week with no usage → 0 calls, percent 0);
- otherwise `callerKeys` has exactly one element whose `name` equals the profile name;
- `by.callerKey` is empty, or has exactly one element whose `name` equals the profile name (upstream sets `name` to the key's own name;
  the entry for calls without a key has another name).
Add unit tests: `callerKeys: []` with `by.callerKey: [{ name: 'No gateway key' }]` and calls > 0 → null; `callerKeys: []` with
`by.callerKey: [{ name: '<another name>' }]` → null; `callerKeys: []`, `by.callerKey: []`, calls > 0 → null; one matching `callerKeys`
entry but a foreign `by.callerKey` entry → null; all empty with zero totals → `calls: 0`, `percent: 0` (with a reference).

### 5. Tests (they are the acceptance; they run on GitHub Actions)
`gateway/tests/my-key.test.mjs` — update the existing assertions that read `cost` / `limits`, and add:
- percent mapping: with the fixture (`week cost 18.4`, `today cost 3.2`) and `reference.weekly = 40` → week 46, today 40, `over` false;
  `weekly = 20` → week 92, today 80; `weekly = 10` → week 184 and today 160 with `over` true; a tiny reference → 999; zero cost → 0;
  a tiny positive cost → 1;
- `reference.accounts` override by slug and by unionId (second person keeps `weekly`), invalid entries ignored;
- no reference (missing, 0, negative, string, `reference: null`) → `percent: null`, `over: false`, `calls` still present;
- the reference is re-read per request (change the organization file between two GETs, no restart);
- `enforced` true with a valid upstream day/week limit, false without; windows stay the computed ones in both cases;
- **no amounts**: for replies with and without a reference and with upstream limits: the raw body contains no `$`; walking the parsed JSON,
  no key is any of `cost`, `costLimit`, `costLeft`, `limit`, `limits`, `used`, `left`, `reference`, `weekly`, `accounts`; `usage.today` has exactly the
  keys `start, reset, calls, percent, over` and `usage.week` exactly those plus `models`; the body does not contain the fixture amounts
  as text (`18.4`, `3.2`, `15.2`) nor the reference value (use a distinctive one such as `37.5` in that test);
- the served script (`myKeyClient()`) contains neither `'$'` nor `估算` / `金额` / `暂不限额` / `estimate`;
- item 4.

`tools/browser-tests/my-key.e2e.mjs` (+ `lib/harness.mjs` as needed) — replace the two usage tests that assert amounts/limits and add:
- a real gateway with a reference configured (put e.g. `reference: { weekly: 40 }` into the `SETTINGS` the suite already passes):
  both tiles show a progress bar and `已用 46%` / `已用 40%` with `data-level="normal"`, `aria-valuenow` matches, the calls lines show
  `86 次` / `512 次` (use the fixture totals; mind the Monday single-day case the fixture already handles — on a Monday week = today),
  the note says going over does not stop the key; English after switching language;
- warn (80–99) and over (≥ 100, including 999 → `999%+` and fill width capped at 100%) levels: colours of the fill differ between normal,
  warn and over (compare computed `background-color`), the over line appears only when over. These rendering states may be driven with
  `page.route(...).fulfill({ json })` like the existing `key-missing` session, or with further gateways — choose the cheaper way;
- no reference: no `[role="progressbar"]`, no `[data-wp-my-key-percent]`, calls lines still shown, no note;
- **no amounts**: every captured `GET /_wp/api/my-key` body and the dialog's full text (`textContent` of the dialog, key masked) contain no `$`;
  the usage card text matches none of `/[$¥￥]|USD|金额|估算|amount|estimate/i`; the parsed reply has none of the keys listed above;
- layout: at 390x844 and 360x740 the dialog with bars (use an over state so the over line is present) has no horizontal overflow
  (reuse the existing `overflow` helper) and both tiles stay inside the dialog;
- screenshots with `suite.shot` (masked key, fixtures only): `usage-bars-light-desktop`, `usage-bars-light-390x844`, `usage-over-light-390x844`,
  `usage-bars-dark-390x844`.
Keep every other existing test of the group passing (menu, access, key actions, guide, layout, appearance). Do not weaken unrelated assertions.

## Scope
- May change: `gateway/my-key.mjs`, `gateway/my-key-client.mjs`, `gateway/tests/my-key.test.mjs`, `gateway/organization/default.json`,
  `docs/organization.md`, `tools/browser-tests/my-key.e2e.mjs`, `tools/browser-tests/lib/harness.mjs`, `tools/browser-tests/lib/browser.mjs`,
  and — only if a default comparison requires it — `tools/gateway.test.mjs`, `tools/organization-resolve.test.mjs`.
- Do not change anything else (no workflow files, no Dockerfile, no dependencies, no other gateway modules). If something else seems
  necessary, say so in the report instead of doing it.

## Environment and constraints
- You work in this git worktree only (branch `T-1161-my-key-percent-bars`, based on the current `origin/main`). **Do not run `git checkout`,
  `git switch`, `git commit`, `git stash` or any other command that changes branches or history.** The coordinator commits.
- Sandbox: workspace-write, **no network**. Node 24 is installed. `gateway/node_modules` may be missing; the unit tests of this module only
  need Node built-ins. Listening on `127.0.0.1` may be refused inside the sandbox: run what you can
  (`node --check gateway/my-key.mjs gateway/my-key-client.mjs`, `node --test gateway/tests/my-key.test.mjs`) and report exactly which tests
  could not run and why; the coordinator runs the full set outside the sandbox and on GitHub Actions. Do not start a browser here.
- Do not install dependencies. Do not run the whole `tools/check.sh` if it needs things the sandbox lacks; say so.
- Only necessary comments, explaining what the code cannot show. Tests assert behaviour through the public functions and HTTP replies.
- Be quick and minimal: this is a small, focused change; do not refactor unrelated code.

## Report
Write the report to `docs/tasks/T-1100/T-1161-my-key-percent-bars/report.md`, in Chinese:
1. Files changed, one sentence each.
2. How it was verified: commands and results (and which tests could not run in the sandbox).
3. Anything the coordinator must handle: out-of-scope needs, open questions, decisions you took where this brief left room.

# T-1163 Key-reset broker (the service that rotates a person's key for the "Reset key" button)

This is a **public repository**. Code, comments, test names, documentation and commit-facing text are in English and must not contain
internal names, host names, people's names, real identifiers or real keys. Examples use placeholders such as `gateway-host.example`.
All fixtures use made-up data.

## Goal
A person presses "Reset key" in the gateway's "My key" dialog. The gateway cannot change a key upstream — on purpose it holds no
credential for that. It writes a small request file. This task builds the other half: a **broker**, a small long-running program an
operator runs on a separate machine that can already run commands on the gateway host and on the key-store host. The broker polls for
requests, checks them independently, makes a new key value in memory, stages it next to the person's key file, rotates the key in the
upstream key store, and writes the result. A parallel task builds the gateway half (`gateway/my-key-reset.mjs`); **do not touch the
gateway here**. The two halves meet only through the file protocol below.

## Read first
- `gateway/my-key.mjs` (`policy()`, `admitted()` — the broker's policy check must give the same answers for `allow`), `docs/organization.md`
  (the `myKey` paragraphs), `gateway/organization/default.json` (`model.keyPrefix`, `runtime.usersFile`), `gateway/user-catalog.mjs` or
  wherever the users file is read (a JSON array of people with at least `slug` and optionally `unionId`).
- `tools/check.sh` (what CI runs: `node --test tools/*.test.mjs` and an `ast.parse` of every `tools/**/*.py`), an existing tool test such as
  `tools/k8s-tools.test.mjs` for style.

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

## What to build

### Files
- `tools/key-reset-broker.mjs` — the broker. Node built-ins only; must run on Node 22 and Node 24. ES module that both exports its
  pieces for tests and runs as a program (`node tools/key-reset-broker.mjs --config <file>`).
- `tools/key-reset/gateway-host.py` and `tools/key-reset/key-store.py` — two helpers the broker runs **on the remote hosts**. Python
  standard library only, must run on Python 3.11+. They are never installed remotely: the broker sends the source each time (below).
- `tools/key-reset-broker.test.mjs` — tests (picked up by `tools/check.sh`).
- `docs/key-reset.md` — operator documentation.

### How the broker runs a helper (no key in any process argument)
The configuration gives, per remote host, a command prefix as an argv array (in production an `ssh ... host` prefix with connection
sharing; in tests `["sh","-c"]`). The broker spawns `[...prefix, BOOTSTRAP]` **without a shell**, where `BOOTSTRAP` is one fixed string:

```
python3 -I -c 'import sys,json;d=json.load(sys.stdin);exec(compile(d["source"],"helper","exec"),{"REQUEST":d})'
```

and writes one JSON document to the child's standard input: `{"source":"<helper source>","op":"<name>","args":{...}}`. The helper prints
exactly one JSON line on standard output and exits 0; anything else (non-zero exit, no JSON, timeout, output over 256 KB) is a transport
failure. Standard error is drained and discarded (only its byte count may be logged). Each call has a timeout (default 30 s, 90 s for
`rotate`); on timeout the child is killed. A new key value travels only inside that standard-input document. No helper ever prints a
key value, and the broker never logs or stores standard output of a helper beyond parsing the JSON line.

### Configuration (JSON file, mode 0600; refuse to start if it is group- or world-readable)
```json
{
  "gatewayHost": {
    "command": ["ssh", "-o", "BatchMode=yes", "gateway-host.example"],
    "organizationFile": "/path/on/gateway-host/organization.json",
    "usersFile": "/path/on/gateway-host/users.json",
    "stateDirectory": "/path/on/gateway-host/state",
    "secureDirectory": "/path/on/gateway-host/secure"
  },
  "keyStore": {
    "command": ["ssh", "-o", "BatchMode=yes", "key-store.example"],
    "file": "/path/on/key-store/caller-keys.json",
    "rotate": ["docker", "exec", "-i", "entry", "/magpie", "gateway-key", "rotate", "{id}", "--key", "-"]
  },
  "stateDirectory": "/var/lib/key-reset-broker",
  "pollSeconds": 5,
  "dailyLimit": 3,
  "windowSeconds": 120,
  "newKeyPrefix": "sk-wp-"
}
```
`stateDirectory`/`secureDirectory` under `gatewayHost` are the **host** paths of the protocol's `S` and `K` (the organization file may name
container paths; do not use those). `P` is read from the organization file (`model.keyPrefix`, default `model-`). Validate everything
(absolute paths, argv arrays of non-empty strings, `rotate` contains `{id}` exactly once, numbers in sane ranges, `dailyLimit` 1..3 — it
can be lowered, never raised above 3) and exit with a clear message naming the bad field (never echoing values).

### `tools/key-reset/gateway-host.py` (runs on the gateway host; `args` always carries the four `gatewayHost` paths)
All path building goes through one function that validates `slug` and `id` with the protocol's patterns. Every open of a key file or
`.next` file uses `O_NOFOLLOW` and requires a regular file; directories must not be symlinks. JSON files read from `R` are limited to
4 KB. Operations:
- `poll` — if `S/my-key` is missing: `{"ready":false}` and nothing else. Otherwise make missing directories (protocol rule 8); if
  `args.heartbeat` is true write `R/broker.json` (tmp + rename); list `R/requests` and `R/claimed` (at most 50 names each, only names
  matching `<id>.json`, body must be an object whose `id` equals the file name and whose `slug` is valid; others are skipped); read the
  policy and the users file and answer
  `{"ready":true,"now":"<ISO time of this host>","requests":[{"id","slug","at","allowed":bool}],"claimed":[{"id","slug","at"}]}`.
  `allowed` follows protocol rule 5 exactly (same matching as the gateway's `admitted()`: `*`, the slug, or the person's `unionId` from the
  users file). The policy file and the users file are read fresh on every call; any error there = `allowed:false` for everyone.
  No unionId or other detail about a person is ever returned.
- `claim` — `args: {id, slug, stage: bool, next: "<new key>"|absent}`. Rename `requests/<id>.json` → `claimed/<id>.json`; `ENOENT` →
  `{"claimed":false}`. Then, if `stage` is false → `{"claimed":true}`. If `stage` is true: re-evaluate `allowed` now (false →
  `{"claimed":true,"allowed":false}`); the key file must exist, be a regular file of 8..512 bytes after trimming (else
  `{"claimed":true,"allowed":true,"key":false}`); create `K/<P><slug>.key.<id>.next` with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, the
  key file's owner and group, content = `next` + newline, `fsync`; answer
  `{"claimed":true,"allowed":true,"key":true,"current":"<sha256 hex of the trimmed key file>"}`.
- `inspect` — `args: {id, slug}` → `{"request":bool,"claimed":bool,"result":null|{"ok","code"},"current":"<sha256>"|null,"next":"<sha256>"|null}`
  (hashes of the trimmed key file and `.next` file; never the values).
- `finish` — `args: {id, slug, ok: bool, code}`. Only if `claimed/<id>.json` exists: when `ok` is false remove the `.next` file first;
  write `results/<id>.json` (tmp + rename, owner of `R`, never replacing an existing `ok:true` result with `ok:false`), then remove
  `claimed/<id>.json`. If `claimed/<id>.json` does not exist: change nothing, answer `{"done":true,"already":true}`. Safe to repeat.

### `tools/key-reset/key-store.py` (runs on the key-store host)
The store file is a JSON **array** of objects; each has at least `id` (string), `secret` (the key value) and `masked`, plus other fields
that must survive untouched. The helper only reads the file; the only writer is the configured rotate command. A read that fails to
parse is retried up to 3 times 200 ms apart (the owner may be rewriting it).
- `ping` — `{"ok":true}` when the file parses as an array, else `{"ok":false}`.
- `which` — `args: {hashes:[...]}` → `{"present":[bool,...]}`: for each sha256 hex, whether exactly one entry's `secret` hashes to it.
- `rotate` — `args: {current:"<sha256 hex of the old value>", next:"<new value>", rotate:[argv with "{id}"]}`:
  1. find the entries whose `secret` hashes to `current`. Not exactly one: if exactly one entry's `secret` equals `next` →
     `{"ok":true,"already":true}`; otherwise `{"ok":false,"code":"no-key"}` (nothing was run).
  2. remember that entry without `secret` and `masked`, and the number of entries.
  3. run the rotate argv with `{id}` replaced by the entry's `id` (argument list, no shell), standard input = `next` + newline,
     standard output and error captured and thrown away (the real command prints the new key), timeout 60 s.
  4. read the file again and find the entry by `id`:
     - `secret == next` → `{"ok":true,"drift":[names of other fields of that entry that changed],"entries":<same count: true|false>}`;
     - `secret` still hashes to `current` → `{"ok":false,"code":"rotate-failed"}`;
     - anything else → `{"ok":false,"code":"unknown"}`.
  The broker never holds the old key value: the person's key is located only by its hash.

### `tools/key-reset-broker.mjs`
Local state directory (0700; files 0600): `broker.pid` (refuse to start when it names another live process), `seen/<id>` (replay guard,
exclusive create; pruned after 2 days), `days/<UTC date>.json` (`{ "<slug>": { "started": n, "done": ["<id>", ...] } }`; pruned after
7 days), `inflight/<id>.json` (`{id, slug, at, current, next}` — the two **hashes**, written before the rotate call, removed after the
result is delivered), `audit.log`.

One loop, strictly sequential (so one person can never have two rotations running), every `pollSeconds`:
1. Every 30 s (and at start): `key-store ping`. Remember when it last succeeded.
2. `gateway-host poll` with `heartbeat: true` only if the last successful ping is younger than 60 s.
3. Unfinished business first: retry every delivered-but-unconfirmed result; then resume every `claimed` id this process is not
   already handling (see "Resume").
4. For each request, oldest first:
   a. `seen/<id>` exists → refuse `replay`. Otherwise create it.
   b. `at` not within `windowSeconds` of the poll's `now` (either direction) → refuse `stale`.
   c. poll said `allowed:false` → refuse `denied`.
   d. today's `done` for this slug has `dailyLimit` entries, or `started` ≥ 2 × `dailyLimit` → refuse `limit`.
   e. the key store has not answered within 60 s → leave the request alone (do not claim; the gateway withdraws it itself).
   f. make the new value: `newKeyPrefix` + `crypto.randomBytes(42).toString('base64url')` (56 characters).
   g. `claim` with `stage:true`. `claimed:false` → the gateway withdrew it: forget the value, done (nothing counted).
      `allowed:false` → `finish` `denied`. `key:false` → `finish` `no-key`.
   h. write `inflight/<id>.json` with `current` and sha256 of the new value; increment `started` and persist; then `rotate`.
   i. `ok:true` → add the id to `done`, audit, `finish ok:true code:"ok"`. Record `drift` / `entries:false` in the audit line (field
      names only) — it does not turn success into failure, because the key **has** changed.
      `ok:false` with `no-key` or `rotate-failed` → `finish ok:false` with that code.
      `unknown`, or a transport failure/timeout of the rotate call → decide with `which([current, next])`: `next` present → success as
      above; `current` present → `finish ok:false code:"rotate-failed"`; neither, or `which` itself failing → keep the attempt open and
      decide again on the next loop (audit `stuck`, step `rotate`, the first time and then at most once per 10 minutes).
   "Refuse" = `claim` with `stage:false`, then `finish ok:false` with the code (if `claimed:false`, nothing more to do).
5. A `finish` that fails is retried on every loop until it succeeds — forever for `ok:true` (the gateway must learn that the old key is
   dead), and for `ok:false` too. Drop the new value from memory as soon as `claim` has staged it and `rotate` has returned.

Resume (a `claimed` id with no in-memory attempt — the broker was restarted):
- `inflight/<id>.json` exists → `which([current, next])`: `next` present → add to `done` (if not there), `finish ok:true`; `current`
  present → `finish ok:false code:"interrupted"`; neither → audit `stuck` (step `resume`), try again next loop.
- no inflight file → `inspect`; if it reports a `next` hash and `which([next])` says present → `finish ok:true`; otherwise
  `finish ok:false code:"interrupted"` (the rotate was never started, so the old key is intact).

Audit (`audit.log`, one JSON object per line, appended with `flush`):
`{ at, slug, id, action: "reset", result: "ok"|"refused"|"failed"|"stuck"|"resumed", code, step?, drift? }`.
Standard error (for the service journal) gets only fixed words and codes (`[key-reset] poll-failed`, `[key-reset] rotate ok`, …) — never a
slug's key, a hash, a helper's output, or an exception message that could quote input. Errors thrown inside the broker carry a code
only. No key value or hash is ever written to disk locally except the two hashes in `inflight/<id>.json`.

Program interface: `--config <file>` (required); `--once` (one loop then exit — for tests and for operators); `--check` (validate the
configuration, `ping` the key store and `poll` without heartbeat, print `ok` or a code, exit 0/1). `SIGTERM`/`SIGINT`: finish the
request being handled, remove `broker.pid`, exit 0. Export a factory such as `createBroker(config, { now, randomBytes, run, log })` so
tests can inject time, randomness, the child-process runner and failures.

### `docs/key-reset.md`
For an operator, in plain language: what the two halves do and why the gateway holds no upstream credential; the protocol table and
rules (copy from this brief); every configuration field; what the person sees for each failure code; the guarantees (old key works
until the rotate succeeds; after that only forward) and how a stuck attempt shows up in both audit logs and how it resolves itself;
how to switch the feature off (`myKey.reset.enabled: false` in the organization file — takes effect on the next request, no restart)
and how to exclude people (`myKey.reset.blocked`); a hardened systemd unit example (`Restart=always`, `MemoryMax=256M`,
`NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=` the state directory and the ssh control-socket directory,
`PrivateTmp=yes`, `ProtectHome=read-only`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `CapabilityBoundingSet=` empty,
`LockPersonality=yes`, `UMask=0077`) with a note on which account it must run as (one that already has the two remote accesses; do not
create new credentials for it) and an ssh prefix example with `ControlMaster=auto`, `ControlPath`, `ControlPersist` so polling does not
open a connection every few seconds. Add one sentence and a link in `docs/organization.md` next to the `myKey` paragraphs only if the
parallel task has not already (it edits that paragraph — keep your change to a single added line at the end of the `myKey` section).

## Tests (`tools/key-reset-broker.test.mjs`) — they are the acceptance and run on GitHub Actions (Linux, `python3` present)
Use the real helpers through the real bootstrap with prefix `["sh","-c"]`, temporary directories for `S`, `K`, the local state and a
made-up store file, and a made-up rotate program written into the temp directory by the test (it must behave like the real one: reads
the value from standard input, refuses a value that starts with a reserved prefix or equals another entry's secret, rewrites the
store with only that entry's `secret`/`masked` changed, **prints the new value on standard output**). Inject time; no real sleeps over
~100 ms. Cover at least:
- success: request → `.next` (content, mode 0600, same owner as the key file) → store entry's secret equals it → `results/<id>.json`
  `ok:true` → `claimed` gone; every other field of that entry and every other entry unchanged; heartbeat written with the host time;
  the new value has the prefix, 62 characters, base64url alphabet, and differs between two resets;
- secrecy: neither the old nor the new value occurs in the broker's captured standard output/error, the local state directory
  (`audit.log`, `days`, `inflight`, `seen`), `R` (requests, claimed, results, heartbeat), or in any child argv — record argv with a
  wrapper prefix (a script that appends `"$@"` to a file and then runs `sh -c`) and with the made-up rotate program recording its own argv;
- policy: `reset.enabled` false / missing / `"true"`, person not in `allow`, in `blocked` by slug / by unionId / `*`, malformed or missing
  organization file, missing users file → result `denied`, store unchanged, no `.next` left; policy change between two polls is honoured;
  policy change between `poll` and `claim` is caught by `claim`;
- limit: three successes, the fourth → `limit`; persists across a new broker on the same state directory; a new UTC day resets; `started` cap;
  the gateway-side files cannot raise it (a request cannot carry a counter);
- `stale` (older and newer than the window, judged on the host's `now`), `replay` (same id again after it was processed → refused, store
  unchanged);
- hostile names: request files named or containing `../x`, uppercase, over-long slug, wrong id length, body/file-name mismatch, a 1 MB
  body, a directory instead of a file → ignored, nothing outside the temp tree touched, loop continues with the valid ones;
- `no-key`: key file missing; key not in the store; key matching two entries; key file or `.next` path being a symlink → refused, target untouched;
- rotate program exits non-zero without changing anything → `rotate-failed`, `.next` removed, old value still in the store, `done` not incremented;
- ambiguous rotate: the program changes the store and then exits non-zero / the runner reports a timeout after the change → resolved by
  `which` to `ok:true`;
- restart: (a) crash after `claim`, before `rotate` → a new broker writes `interrupted`, removes `.next`, old value intact;
  (b) crash after `rotate`, before `finish` → a new broker writes `ok:true` and counts it once; (c) `finish` failing twice then
  succeeding → exactly one `ok:true` result, never an `ok:false` one;
- withdrawn: request file removed before `claim` → no rotation, nothing counted, store unchanged;
- key store unreachable: no heartbeat is written, requests are not claimed; back again → heartbeat resumes;
- `S/my-key` missing → `ready:false`, nothing created; missing `R` subdirectories are created with the parent's owner and 0700;
- two people in one poll → handled one after the other, both `ok:true`; a second process on the same state directory refuses to start;
- configuration validation (each bad field named, group/world-readable file refused, `dailyLimit` above 3 refused);
- `python3 -I -m py_compile` style check is not needed (CI already parses every `tools/**/*.py`), but each helper operation has at
  least one direct test through the bootstrap.

## Scope
- May add: `tools/key-reset-broker.mjs`, `tools/key-reset/gateway-host.py`, `tools/key-reset/key-store.py`,
  `tools/key-reset-broker.test.mjs`, `docs/key-reset.md`; may add one line to `docs/organization.md`.
- Do not change anything under `gateway/`, `image/`, `feishu/`, workflow files, `tools/check.sh` or other tools/tests. No dependencies.
  If something else seems necessary, say so in the report instead of doing it.

## Environment and constraints
- You work in this git worktree only (branch `T-1163-key-reset-broker`, based on the current `origin/main`). **Do not run
  `git checkout`, `git switch`, `git commit`, `git stash` or any other command that changes branches or history.** The coordinator commits.
- Sandbox: workspace-write, **no network**, no ssh. Node and python3 are installed. Everything here is testable with local child
  processes and temp directories; run `node --test tools/key-reset-broker.test.mjs` and `node --check tools/key-reset-broker.mjs` and
  report the real output. If the sandbox refuses something (for example `chown`), say exactly what and keep the test meaningful on CI.
- Do not install dependencies. Only necessary comments, explaining what the code cannot show.
- Work in this order so a partial result is still useful: helpers + their direct tests → broker loop + tests → resume/ambiguous cases → docs.

## Report
Write the report to `docs/tasks/T-1100/T-1163-key-reset-broker/report.md`, in Chinese:
1. Files added/changed, one sentence each.
2. How it was verified: commands and results (and what could not run in the sandbox).
3. Anything the coordinator must handle: out-of-scope needs, open questions, decisions you took where this brief left room.

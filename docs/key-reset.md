# Key-reset broker

The gateway accepts a signed-in person's **Reset key** request and later installs the result. It has no credential that can change a key in the upstream store. The broker runs on a separate operator machine, checks the request independently, stages a new value on the gateway host, and runs the existing upstream rotation command on the key-store host. The two services exchange files; neither exposes a reset network API.

Gateway construction, recovery scans, GET requests and client-script delivery do not create reset directories. The gateway creates directories when accepting a reset POST or writing an existing My key audit entry. The broker still waits for `S/my-key` to exist before publishing its heartbeat; a fresh installation without that directory reports reset unavailable until an audited key action has created it.

Run the broker with Node 22 or Node 24. Both remote hosts need Python 3.11 or later. There are no package dependencies. Keep `tools/key-reset-broker.mjs` and its adjacent `tools/key-reset/` directory together. Each helper's source travels over standard input on every call; there is nothing to install on either remote host.

## Configuration and operation

Save a JSON configuration with mode 0600. The broker refuses a symlink, a nonregular file, or a file with any group or other permissions. Errors identify the field, never its value.

```json
{
  "gatewayHost": {
    "command": ["ssh", "-o", "BatchMode=yes", "-o", "ControlMaster=auto", "-o", "ControlPath=/var/lib/key-reset-ssh/%C", "-o", "ControlPersist=120", "gateway-host.example"],
    "organizationFile": "/srv/gateway/organization.json",
    "usersFile": "/srv/gateway/users.json",
    "stateDirectory": "/srv/gateway/state",
    "secureDirectory": "/srv/gateway/secure"
  },
  "keyStore": {
    "command": ["ssh", "-o", "BatchMode=yes", "-o", "ControlMaster=auto", "-o", "ControlPath=/var/lib/key-reset-ssh/%C", "-o", "ControlPersist=120", "key-store.example"],
    "file": "/srv/key-store/caller-keys.json",
    "rotate": ["docker", "exec", "-i", "entry", "/magpie", "gateway-key", "rotate", "{id}", "--key", "-"]
  },
  "stateDirectory": "/var/lib/key-reset-broker",
  "pollSeconds": 5,
  "dailyLimit": 3,
  "windowSeconds": 120,
  "newKeyPrefix": "sk-wp-"
}
```

All example names and paths are placeholders. Use the account that **already has both remote accesses**; do not create new credentials for this service. The remote gateway account must be able to read the organization, users and key files, create private protocol directories, and assign files to the required existing owners. The remote store account must already be allowed to read the store and run the configured rotate command. If these permissions are absent, provision them through the existing operational process before enabling resets.

| Field | Meaning and validation |
|---|---|
| `gatewayHost.command` | Required nonempty argv prefix for commands on the gateway host. No local shell expansion. |
| `gatewayHost.organizationFile` | Required absolute host path to the live organization JSON. |
| `gatewayHost.usersFile` | Required absolute host path to the users JSON array, with `slug` and `unionId` for admitted people. |
| `gatewayHost.stateDirectory` | Required absolute **host** path for `S`. Do not copy a container-only path from the organization. |
| `gatewayHost.secureDirectory` | Required absolute **host** path for `K`. |
| `keyStore.command` | Required nonempty argv prefix for the key-store host. |
| `keyStore.file` | Required absolute path on that host to the JSON array of store entries. |
| `keyStore.rotate` | Required nonempty argv; exactly one occurrence of `{id}` across the array. The helper substitutes the matched store entry's ID. The command must read the new value from stdin. |
| `stateDirectory` | Required absolute broker-local directory for the process lock, replay guard, counters, inflight hashes and audit. Use a dedicated directory on persistent storage. |
| `pollSeconds` | Integer 1–30, default 5. Polls run sequentially; this delay follows completion of a loop. |
| `dailyLimit` | Integer 1–3, default 3. Can lower the broker's allowance but cannot raise it above the protocol maximum. |
| `windowSeconds` | Integer 1–3600, default 120. Maximum request timestamp difference in either direction, measured against the gateway host's clock. |
| `newKeyPrefix` | 1–64 ASCII letters, digits, underscores or hyphens, default `sk-wp-`. Appended to 42 cryptographically random bytes encoded as 56 base64url characters. The default produces a 62-character value. |

Argv arrays contain at most 128 nonempty strings, each at most 8192 characters, without NUL bytes. Paths must be absolute and contain no `.` or `..` components. `model.keyPrefix` is read only from the organization file, defaults to `model-`, and must contain only ASCII letters, digits, underscores or hyphens (up to 128 characters). Environment overrides of the key prefix are not supported by the broker: if the gateway uses such an override, the broker cannot find the key and safely answers `no-key`. Keep key paths and the prefix stable while requests are pending. Staged lookup uses exactly `P + slug + ".key." + id + ".next"`; it never suffix-matches another person's file. If the organization file becomes unreadable, inspection cannot identify the staged value and failure delivery waits until the configuration is readable again.

Connection sharing in the example avoids a new SSH connection every few seconds. Create the control-socket directory with mode 0700, owned by the service account. The actual child argv is the configured prefix plus this fixed bootstrap string:

```text
python3 -I -c 'import sys,json;d=json.load(sys.stdin);exec(compile(d["source"],"helper","exec"),{"REQUEST":d})'
```

The broker sends one JSON document containing `source`, `op` and `args` on stdin. A helper must exit zero and print exactly one JSON line. Nonzero exit, malformed or missing output, more than 256 KB of stdout, or a deadline failure is a transport failure. Stderr is drained and discarded. Calls have a 30-second deadline, or 90 seconds for `rotate`; the rotation command itself has a 60-second deadline. Rotation-command stdout and stderr go directly to the null device so even a command that prints its new key cannot disclose it through helper output or exhaust memory by printing it repeatedly.

```sh
chmod 600 /etc/key-reset-broker.json
node /opt/key-reset/tools/key-reset-broker.mjs --config /etc/key-reset-broker.json --check
node /opt/key-reset/tools/key-reset-broker.mjs --config /etc/key-reset-broker.json --once
node /opt/key-reset/tools/key-reset-broker.mjs --config /etc/key-reset-broker.json
```

`--check` validates configuration, pings the store and polls without writing a heartbeat. It prints `ok` or a fixed error code and exits 0 or 1. It may create missing protocol directories once `S/my-key` exists. `--once` performs one full loop, including recovery, and exits. The normal mode runs until SIGTERM or SIGINT; it completes the currently running attempt's processing, releases its lock directory and exits. An unresolved or undelivered attempt remains recoverable by the next process. A second process using the same local state directory refuses to start. The lock is `stateDirectory/broker.lock/`, atomically published with a unique owner file containing the PID and Linux `/proc` process start time in its name. A dead process or a reused PID with a different start time is stale; a same-process owner without an active in-memory lock is also stale. This does not rely on a persistent PID file alone. The old `broker.pid` format is no longer used. Operate only one broker for a gateway, with a single persistent local state directory.

## Policy and what the person sees

Both services read `myKey` on every decision. To disable new resets without restarting, set `myKey.reset.enabled` to `false` in the live organization file. Already-claimed rotations still require completion; disabling the feature cannot undo them. `claim` rechecks admission immediately before staging, so disabling between poll and claim takes effect too.

```json
{
  "myKey": {
    "allow": ["*"],
    "reset": {
      "enabled": true,
      "blocked": ["example-slug", "example-union-id"]
    }
  }
}
```

`allow` and `blocked` match `*`, a slug, or the person's union ID. Matching the current gateway's `admitted()` also requires a catalog person with both a slug and a nonempty union ID, even for `*`. A missing or malformed policy or users file denies everyone. `enabled` must be the JSON boolean `true`; the string `"true"` does not enable resets. A missing or malformed `blocked` list denies everyone on both sides, including through the gateway's merged organization configuration. Defaults contain only `enabled:false` and `blockedNote:""`; use an explicit `blocked: []` for no exclusions. The broker never returns union IDs to the calling process.

The gateway owns the exact UI copy. These are the result meanings it must communicate:

| Code | Meaning for the person |
|---|---|
| `ok` | The key inside the workspace is replaced automatically and the workspace restarts. Only tools on the person's own computer need the new key entered by hand. The old key no longer works. |
| `denied` | Reset is unavailable under the current policy. The old key is unchanged. |
| `limit` | The daily allowance or attempt cap is reached. Try on a later UTC day. |
| `stale` | The request expired or its time was too far in the future. Submit a fresh request. |
| `replay` | This attempt ID has already been processed. Submit a fresh request. |
| `no-key` | The existing key cannot be safely identified: its file is unavailable or unsafe, or it does not match exactly one store entry. Ask an operator to check it. |
| `rotate-failed` | The rotation command exited with failure and the old hash remains, or an uncertain rotation passed the quiet-period checks below. Retry later. |
| `rotate-unknown` | Audit-only waiting code; no failure result is delivered. The attempt remains pending while the broker resolves the rotation. |
| `interrupted` | A previous attempt stopped before changing the key. The old key still works; submit a fresh request. |

When the broker is unavailable, the gateway does not accept a new reset. When rotation is unresolved, there is **no failure result**: the attempt stays pending. Do not tell the person to revert to the old key until the broker has proved that it remains accepted.

## Recovery and audit

The old key works until rotation succeeds. After that, only forward completion is possible: the gateway must keep trying to install `.next`. A failed delivery does not change a positive decision into a negative one. Both successful and failed result deliveries are retried on subsequent loops.

Before rotation, the broker persists only the hashes of the current and staged values, then increments the day's `started` count. A rotation is charged to the broker UTC day when it starts; that timestamp survives restart. `done` contains successful attempt IDs and is updated idempotently **after successful result delivery**. A local count-write failure never blocks delivery: the broker retains its inflight decision, retries the count on later cycles (also after restart), and keeps the slug busy until counting succeeds. The broker rejects new work after `dailyLimit` successes or `2 × dailyLimit` starts. Counters supplied by the gateway are ignored. Unavailable stores leave unclaimed requests and the replay guard untouched, allowing recovery before the gateway's withdrawal deadline without turning the request into a replay. A replay marker is written only after a successful claim, or after recovery observes a claim whose response was lost. Transport failure before the remote rename leaves the request retryable.

A timeout or transport failure cannot prove that a command on the remote host stopped. An uncertain rotation remains unresolved: its slug stays busy, `.next` is preserved, and no `ok:false` result is delivered. Each cycle checks the stored hashes. If the new hash is present exactly once, completion proceeds forward as success. If only the old hash remains, the broker waits at least ten minutes from the persisted rotation-start time, then requires three consecutive old-hash checks in different cycles before returning `rotate-failed`. Checks before the quiet period do not count; an unavailable store or neither hash resets the consecutive count. The rotation-start timestamp, count and waiting state survive restart; older inflight records use their existing attempt timestamp conservatively. No second rotation is issued.

On restart, inflight hashes are resolved by the same rules without plaintext; the gateway host's staged `.next` file still holds the value. Persisted final decisions are redelivered idempotently and local counting is retried. A claim without inflight state is inspected: an accepted staged hash means success; otherwise an unchanged pre-rotation attempt can be interrupted. A failed inspection or store lookup leaves it open. Local inflight state is also recovered when a successful `finish` removed the remote claim but its reply was lost. Malformed inflight files are skipped independently and audited once as `stuck` until repaired, so unrelated attempts can proceed.

While unresolved, the gateway keeps reporting pending. The dialog's five-minute polling cap stops polling without declaring failure; reopening resumes. A lost reset POST response causes the client to check the main My key endpoint and resume polling if acceptance is pending. Heartbeats more than 45 seconds old or more than 30 seconds in the future are unavailable. An unreadable reset summary disables resets without hiding the person's masked key, usage or guide.

The store helper reads the JSON array without modifying it. Parse/read failures are retried up to three reads, 200 ms apart. Only the configured command writes it. After rotation, the helper checks the matched entry again. A timeout or OS error returns `unknown` unless the new value is already stored; only a completed nonzero exit with the old hash still present returns `rotate-failed`. A zero exit without the new value is also uncertain. Entry identifiers beginning with `-` are rejected before running a command. Changes to fields other than `secret` and `masked`, or to the number of entries, are audited but cannot turn a completed rotation into a failure. The broker logs only ordinary identifier-shaped drift field names, never their values.

`audit.log` is one flushed JSON object per line:

```json
{"at":"2030-01-01T12:00:00.000Z","slug":"example-slug","id":"0123456789abcdef0123456789abcdef","action":"reset","result":"stuck","code":"rotate-unknown","step":"rotate","state":"old"}
```

Results are `ok`, `refused`, `failed`, `stuck` or `resumed`; optional fields include `step`, `drift`, and `entries:false`. Uncertain rotations emit `rotate-unknown` once per waiting-state change (`old`, `missing`, or `unavailable`), not every cycle; the persisted waiting state avoids repeating unchanged audit lines across restart. Other failed pre-rotation recovery lookups retain the ten-minute stuck-audit throttle. It is checked each loop without issuing another rotation. Restoring store access usually resolves it automatically. If an outside change replaced both values, an operator must establish what happened before the broker can finish. Preserve the staged file and inflight record while investigating; do not manually publish a failure or roll back a completed rotation.

Correlate the attempt ID with the gateway's audit under `S/my-key/audit.log`. The gateway half is responsible for its request/pending/completion entries; the broker never writes that audit. The broker's `stuck` entry plus an uncompleted gateway attempt identify the same pending reset. Once the store becomes readable and a hash can be identified, the broker writes the result and the gateway can complete its side. Journal messages contain only fixed words and codes, such as `[key-reset] finish-failed`.

The local directory contains `broker.lock/`, `seen/<id>` (exclusive replay markers retained for two days), `days/<UTC date>.json` (dates older than seven UTC days are pruned), `inflight/<id>.json`, and `audit.log`. Open inflight records prevent their replay markers from being pruned. Directories are 0700 and files 0600. Counters use fsync and atomic replacement; inflight records are exclusively created and flushed before rotation, then updated atomically as recovery state changes. No plaintext key enters a local record or temporary file. Audit appends are flushed. Do not discard local state during upgrades. The gateway likewise prunes `R/days/<slug>-<UTC date>.json` older than seven UTC days, and completion checks read only today's day file plus the last-outcome record. Gateway lock entries with unrecognized names older than the larger of ten minutes and the claim timeout are removed with a `lock-cleared` audit line; younger entries stay busy. Audit retention is an operator responsibility.

## Service example

Replace `existing-operator` with the account that already has both accesses, and adjust all paths. Prepare the state and control-socket directories with that owner and mode 0700 before starting the unit. Keep the configuration and installed code outside the writable directories.

```ini
[Unit]
Description=Key-reset broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=existing-operator
ExecStart=/usr/bin/node /opt/key-reset/tools/key-reset-broker.mjs --config /etc/key-reset-broker.json
Restart=always
RestartSec=5
TimeoutStopSec=180
MemoryMax=256M
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/key-reset-broker /var/lib/key-reset-ssh
PrivateTmp=yes
ProtectHome=read-only
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
LockPersonality=yes
UMask=0077
LimitCORE=0

[Install]
WantedBy=multi-user.target
```

`LimitCORE=0` prevents a crash dump from persisting process-memory keys. Ensure the existing remote execution environment also does not collect process dumps or standard-input traces. SSH's host verification and existing account access remain in force.

## Shared file protocol

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

# T-1118 User image: pre-create /run/mysqld owned by the partner user

Repository: this repo, base `main`. Files: `image/Dockerfile`, `image/tests/`, `docs/kubernetes.md`.

## Background
Users who run their own MariaDB inside the workspace need `/run/mysqld` (socket/pid dir). The container runs as
uid/gid 1001 and cannot create it under `/run`. The operator currently patches the built image by hand with
`install -d -o 1001 -g 1001 -m 755 /run/mysqld` as root.

## Required changes
1. In `image/Dockerfile`, next to the existing `/srv -> /data/srv` step (root stage, before switching to the
   unprivileged user), add `install -d -o 1001 -g 1001 -m 755 /run/mysqld`. Use the same uid/gid source the
   Dockerfile already uses for the partner user (variable or literal, match existing style).
2. Extend the existing image test style (`image/tests/`) with a static check that the Dockerfile creates
   `/run/mysqld` with owner 1001 and mode 755 in a root stage. If an existing test parses the Dockerfile, extend it.
3. One sentence in `docs/kubernetes.md` next to the `/srv` note: the image provides `/run/mysqld` writable by
   the user for self-hosted MariaDB; data stays under `/data`.

## Constraints
- Public repository: no company names, real hostnames, IP addresses or person names.
- Do not build images or run Docker/clusters. Static/offline tests only.

## Acceptance
- Run the image tests (e.g. `python3 -m unittest discover -s image/tests -p '*.test.py'` or the repo's existing
  command) and any test you touch; report the command, counts and changed files in the task report.

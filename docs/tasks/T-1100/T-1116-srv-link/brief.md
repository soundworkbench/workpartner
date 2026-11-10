# T-1116 User image: /srv is a link to /data/srv

## Background

In the old user container, some users keep their own services and data under `/data/srv/<name>` and reach
them through `/srv/<name>` links (scripts, cron jobs, database configs and app files hard-code `/srv/...`).
In the current user image (`image/Dockerfile`, runtime user 1001) `/srv` is an empty directory owned by root,
so the runtime user cannot recreate those links, and the user's services cannot start after migration.

## Required changes

1. `image/Dockerfile`, in a `USER root` stage before `USER 1001:1001`: replace the empty `/srv` directory with a
   symbolic link `/srv -> /data/srv` (fail the build if `/srv` is not empty, do not delete content silently).
2. `image/bin/start.sh` (runs as the runtime user, `HOME=/data`): before the init hooks run
   (`wp_init_hooks`), make sure `/data/srv` exists as a directory (`mkdir -p`); if `/data/srv` exists but is not a
   directory or is a symlink, print a warning and continue (do not delete or replace it).
3. Tests (offline, follow existing `image/tests/*.test.py` style, `python3 -I -m unittest`):
   - a static check that the Dockerfile creates the `/srv -> /data/srv` link in a root stage before the runtime `USER`.
   - the start-script step: creates `/data/srv` when missing; leaves an existing directory and its contents unchanged;
     warns and continues when `/data/srv` is a file or symlink. If the step is hard to test inside `start.sh`, put it in a
     small function in `image/bin/wp-init-hooks.sh` (sourced by start.sh) and test the function.
4. Docs: in the user image / migration section of `docs/`, add one short note: `/srv` in the user image is a link to
   `/data/srv`, so content under `/srv` persists on the data volume.

## Constraints

- Public repository: no company names, real hostnames, IP addresses or person names.
- Do not change the Pod spec, the gateway, or any other startup behaviour.
- Do not build the image or run containers/clusters. Run only:
  `python3 -I -m unittest discover -s image/tests -p '*.test.py'` (or the way the existing tests are run; report it).

## Acceptance

- Tests above pass; report changed files, the exact command and its output tail, and the Python version.

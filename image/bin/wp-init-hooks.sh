#!/bin/bash
# Source this file, then call wp_init_hooks [data-directory].
wp_link_published_files() {
  local data_dir=$1 published_dir=${WORKPARTNER_PUBLISHED_DIR:-}
  [ -n "$published_dir" ] || return 0
  local path name temporary
  local -a names=(.zp-market-token .wp-feishu-cli.json .zp-preview-relay-key)
  local -A seen=()
  # Keep default links even before keys arrive; ignore Kubernetes' ..data entries.
  for path in "$published_dir"/*; do
    [ -f "$path" ] || continue
    name=${path##*/}
    case "$name" in
      .*|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]*) continue ;;
    esac
    names+=("$name")
  done
  for name in "${names[@]}"; do
    [ -z "${seen[$name]:-}" ] || continue
    seen[$name]=1
    if ! temporary=$(mktemp -d "$data_dir/.wp-published.XXXXXX"); then
      printf '[wp-init] warning: cannot link published file %s\n' "$name" >&2
      continue
    fi
    if ! ln -s -- "$published_dir/$name" "$temporary/link" ||
       ! mv -fT -- "$temporary/link" "$data_dir/$name"; then
      rm -f -- "$temporary/link"
      rmdir -- "$temporary"
      printf '[wp-init] warning: cannot link published file %s\n' "$name" >&2
      continue
    fi
    rmdir -- "$temporary" || printf '[wp-init] warning: cannot clean temporary directory for published file %s\n' "$name" >&2
  done
  return 0
}

wp_init_hooks() {
  local data_dir=${1:-/data}
  wp_link_published_files "$data_dir"
  local hooks_dir="$data_dir/.zp-init.d"
  [ -d "$hooks_dir" ] || return 0
  if [ -d "$hooks_dir/bin" ]; then
    export PATH="$hooks_dir/bin:$PATH"
  fi
  local hook metadata owner mode status line output size
  local -a hooks=()
  mapfile -d '' -t hooks < <(printf '%s\0' "$hooks_dir"/*.sh | LC_ALL=C sort -z)
  for hook in "${hooks[@]}"; do
    [ -e "$hook" ] || [ -L "$hook" ] || continue
    if [ ! -f "$hook" ] || [ -L "$hook" ]; then
      printf '[wp-init] warning: skipping non-regular hook %s\n' "${hook##*/}" >&2
      continue
    fi
    metadata=$(stat -c '%u %a' -- "$hook") || continue
    read -r owner mode <<< "$metadata"
    if [ "$owner" != "$EUID" ] || (( (8#$mode & 0022) != 0 )); then
      printf '[wp-init] warning: skipping unsafe hook %s\n' "${hook##*/}" >&2
      continue
    fi
    if ! output=$(mktemp); then
      printf '[wp-init] warning: cannot capture hook %s; skipping\n' "${hook##*/}" >&2
      continue
    fi
    # Isolate shell state and time out only the hook, preserving background services.
    # A regular file avoids waiting for inherited output descriptors to close.
    if timeout --foreground --kill-after=5s 60s bash -- "$hook" > "$output" 2>&1; then
      status=0
    else
      status=$?
    fi
    # Bound the snapshot even if a background service keeps writing to the file.
    size=$(stat -c '%s' -- "$output")
    head -c "$size" -- "$output" |
      while IFS= read -r line || [ -n "$line" ]; do
        printf '[wp-init:%s] %s\n' "${hook##*/}" "$line"
      done
    rm -f -- "$output"
    if [ "$status" -ne 0 ]; then
      printf '[wp-init] warning: hook %s exited with status %s; continuing\n' "${hook##*/}" "$status" >&2
    fi
  done
  return 0
}

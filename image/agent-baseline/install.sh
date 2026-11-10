#!/usr/bin/env bash
# 用法：install.sh <目标 .claude 目录> <钩子目录在目标环境里的路径>
# 例：install.sh /home/claude/.claude /home/claude/.claude/hooks
# 把 hooks/ 下的钩子复制到 <目标>/hooks/，并在 <目标>/settings.json 补上 PreToolUse 条目。
# 幂等：已装则跳过；改 settings.json 前备份为 settings.json.bak-<日期>-noblock。只增不改其他键。
set -euo pipefail
[ $# -eq 2 ] || { echo "用法：$0 <目标 .claude 目录> <钩子目录在目标环境里的路径>" >&2; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)/hooks"
TARGET="${1%/}"; HOOKS_IN_ENV="${2%/}"
[ -d "$TARGET" ] || { echo "目标目录不存在：$TARGET" >&2; exit 1; }
mkdir -p "$TARGET/hooks"
for f in no-long-sleep.py no-blocking-foreground.py no-repeat-poll.py; do
  if [ ! -e "$TARGET/hooks/$f" ] || ! cmp -s "$SRC/$f" "$TARGET/hooks/$f"; then
    [ "$(readlink -f "$SRC/$f")" = "$(readlink -f "$TARGET/hooks/$f")" ] || cp "$SRC/$f" "$TARGET/hooks/$f"
  fi
  chmod 755 "$TARGET/hooks/$f"
done
python3 - "$TARGET/settings.json" "$HOOKS_IN_ENV" <<'PY'
import json, os, shutil, sys, time
path, hooks = sys.argv[1:3]
d = json.load(open(path)) if os.path.exists(path) else {}
poll = f"python3 {hooks}/no-repeat-poll.py"
want = [("Bash", [f"python3 {hooks}/no-long-sleep.py", f"python3 {hooks}/no-blocking-foreground.py", poll]),
        ("Agent|Task", [f"python3 {hooks}/no-blocking-foreground.py"]),
        ("Read", [poll]),
        ("TaskOutput|BashOutput", [poll])]
pre = d.setdefault("hooks", {}).setdefault("PreToolUse", [])
changed = False
for matcher, cmds in want:
    entry = next((e for e in pre if e.get("matcher") == matcher), None)
    if entry is None:
        entry = {"matcher": matcher, "hooks": []}
        pre.append(entry); changed = True
    have = {h.get("command") for h in entry.setdefault("hooks", [])}
    for c in cmds:
        if c not in have:
            entry["hooks"].append({"type": "command", "command": c}); changed = True
if not changed:
    print("已安装，跳过：" + path); sys.exit(0)
if os.path.exists(path):
    bak = f"{path}.bak-{time.strftime('%Y%m%d')}-noblock"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
tmp = path + ".tmp"
json.dump(d, open(tmp, "w"), indent=2, ensure_ascii=False)
if os.path.exists(path):
    shutil.copymode(path, tmp)
os.replace(tmp, path)
print("已安装：" + path)
PY

import hashlib
import json
import re
import subprocess
import time


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def read_store(filename):
    for attempt in range(3):
        try:
            with open(filename, encoding="utf-8") as stream:
                rows = json.load(stream)
            if not isinstance(rows, list):
                raise ValueError("store")
            return rows
        except (OSError, ValueError):
            if attempt == 2:
                raise
            time.sleep(0.2)


def matching(rows, hashed):
    return [r for r in rows if isinstance(r, dict) and isinstance(r.get("secret"), str)
            and digest(r["secret"]) == hashed]


def main(request):
    args, op = request["args"], request["op"]
    try:
        rows = read_store(args["file"])
    except Exception:
        return {"ok": False} if op == "ping" else {"error": "store-unavailable"}
    if op == "ping":
        return {"ok": True}
    if op == "which":
        hashes = args["hashes"]
        if not isinstance(hashes, list) or len(hashes) > 50 or not all(
                isinstance(h, str) and re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes):
            raise ValueError("hashes")
        return {"present": [len(matching(rows, h)) == 1 for h in hashes]}
    if op != "rotate":
        raise ValueError("op")
    current, value, command = args["current"], args["next"], args["rotate"]
    if not isinstance(current, str) or not re.fullmatch(r"[0-9a-f]{64}", current):
        raise ValueError("current")
    if not isinstance(value, str) or not 8 <= len(value.encode()) <= 512 or "\n" in value or "\r" in value:
        raise ValueError("next")
    if not isinstance(command, list) or not command or not all(isinstance(v, str) and v and "\0" not in v for v in command):
        raise ValueError("rotate")
    if sum(v.count("{id}") for v in command) != 1:
        raise ValueError("rotate")
    found = matching(rows, current)
    if len(found) != 1:
        if sum(isinstance(r, dict) and r.get("secret") == value for r in rows) == 1:
            return {"ok": True, "already": True}
        return {"ok": False, "code": "no-key"}
    entry = found[0]
    identifier = entry.get("id")
    if not isinstance(identifier, str) or not identifier or "\0" in identifier or identifier in (value, entry["secret"]):
        return {"ok": False, "code": "no-key"}
    if identifier.startswith("-"):
        return {"ok": False, "code": "rotate-failed"}
    before = {k: v for k, v in entry.items() if k not in ("secret", "masked")}
    completed = None
    try:
        # The command prints the key. Discard both streams without buffering or a file.
        completed = subprocess.run([v.replace("{id}", identifier) for v in command], input=(value + "\n").encode(),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        after = read_store(args["file"])
        found = [r for r in after if isinstance(r, dict) and r.get("id") == identifier]
        if len(found) != 1:
            return {"ok": False, "code": "unknown"}
        entry = found[0]
        if entry.get("secret") == value:
            fields = {k: v for k, v in entry.items() if k not in ("secret", "masked")}
            drift = sorted(k for k in before.keys() | fields.keys()
                           if (k not in before or k not in fields or before[k] != fields[k]))
            return {"ok": True, "drift": drift, "entries": len(after) == len(rows)}
        # Signals and exec-client failures cannot rule out a later remote write.
        if completed is not None and 1 <= completed.returncode <= 124 and isinstance(entry.get("secret"), str) and digest(entry["secret"]) == current:
            return {"ok": False, "code": "rotate-failed"}
    except Exception:
        pass
    return {"ok": False, "code": "unknown"}


try:
    print(json.dumps(main(REQUEST), separators=(",", ":")))
except Exception:
    print('{"error":"store-failed"}')

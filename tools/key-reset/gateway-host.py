import datetime
import hashlib
import json
import os
import re
import stat
import uuid


SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")
ID = re.compile(r"[0-9a-f]{32}\Z")
CODES = {"denied", "limit", "stale", "replay", "no-key", "rotate-failed", "interrupted"}
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def directory(path):
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("path")
    fd = os.open("/", DIRECTORY)
    try:
        for part in path.split("/"):
            if not part:
                continue
            if part in (".", ".."):
                raise ValueError("path")
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def subdirectory(parent, name):
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        created = True
    except FileExistsError:
        created = False
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    if created:
        owner = os.fstat(parent)
        os.fchown(fd, owner.st_uid, owner.st_gid)
    os.fchmod(fd, 0o700)
    return fd


def read_file(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("file")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("size")
        return data, info


def read_json(parent, name):
    return json.loads(read_file(parent, name, 4096)[0])


def external_json(path):
    parent = directory(os.path.dirname(path))
    try:
        return json.loads(read_file(parent, os.path.basename(path), 16 * 1024 * 1024)[0])
    finally:
        os.close(parent)


def policy(args, slug):
    try:
        organization = external_json(args["organizationFile"])
        users = external_json(args["usersFile"])
        config = organization["myKey"]
        allow = config.get("allow", [])
        reset = config.get("reset", {})
        blocked = reset.get("blocked")
        if not isinstance(users, list) or not all(isinstance(u, dict) for u in users):
            return False
        if not all(isinstance(v, list) and all(isinstance(s, str) for s in v) for v in (allow, blocked)):
            return False
        user = next((u for u in users if u.get("slug") == slug), {})
        union = user.get("unionId")
        matches = lambda values: any(v in ("*", slug, union) for v in values)
        return bool(isinstance(union, str) and union and reset.get("enabled") is True
                    and matches(allow) and not matches(blocked))
    except Exception:
        return False


class Paths:
    def __init__(self, args, create=False):
        self.args = args
        state = directory(args["stateDirectory"])
        try:
            parent = os.open("my-key", DIRECTORY, dir_fd=state)
        finally:
            os.close(state)
        try:
            self.root = subdirectory(parent, "reset") if create else os.open("reset", DIRECTORY, dir_fd=parent)
        finally:
            os.close(parent)
        self.dirs = {name: (subdirectory(self.root, name) if create else None)
                     for name in ("tmp", "active", "requests", "claimed", "results")}
        self.secure = None

    def folder(self, name):
        if self.dirs[name] is None:
            self.dirs[name] = os.open(name, DIRECTORY, dir_fd=self.root)
        return self.dirs[name]

    def path(self, kind, slug=None, attempt=None):
        # All names derived from a person or request pass this single gate.
        if not isinstance(slug, str) or not SLUG.fullmatch(slug):
            raise ValueError("slug")
        if not isinstance(attempt, str) or not ID.fullmatch(attempt):
            raise ValueError("id")
        if kind in self.dirs:
            return self.folder(kind), attempt + ".json"
        if kind not in ("key", "next"):
            raise ValueError("kind")
        if self.secure is None:
            self.secure = directory(self.args["secureDirectory"])
        # A staged value must remain discoverable if policy becomes unreadable or its prefix changes.
        if kind == "next":
            suffix = slug + ".key." + attempt + ".next"
            staged = [name for name in os.listdir(self.secure) if name.endswith(suffix)
                      and re.fullmatch(r"[a-zA-Z0-9_-]{0,128}", name[:-len(suffix)])]
            if len(staged) > 1:
                raise ValueError("next")
            if staged:
                return self.secure, staged[0]
        try:
            organization = external_json(self.args["organizationFile"])
            prefix = organization.get("model", {}).get("keyPrefix", "model-")
        except Exception:
            prefix = "model-"
        if not isinstance(prefix, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{0,128}", prefix):
            raise ValueError("prefix")
        name = prefix + slug + ".key"
        return self.secure, name + ("." + attempt + ".next" if kind == "next" else "")

    def atomic(self, parent, name, value):
        temp = uuid.uuid4().hex
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600,
                     dir_fd=self.folder("tmp"))
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            owner = os.fstat(self.root)
            os.fchown(stream.fileno(), owner.st_uid, owner.st_gid)
            os.fchmod(stream.fileno(), 0o600)
            stream.write(json.dumps(value, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temp, name, src_dir_fd=self.dirs["tmp"], dst_dir_fd=parent)
        os.fsync(parent)

    def rows(self, kind):
        rows = []
        for name in sorted(os.listdir(self.dirs[kind])):
            if not re.fullmatch(r"[0-9a-f]{32}\.json", name):
                continue
            try:
                body = read_json(self.dirs[kind], name)
                if not isinstance(body, dict) or body.get("id") != name[:-5]:
                    continue
                self.path(kind, body.get("slug"), body.get("id"))
                rows.append({k: body.get(k) for k in ("id", "slug", "at")})
                if len(rows) == 50:
                    break
            except Exception:
                continue
        return rows

    def key(self, kind, slug, attempt):
        data, owner = read_file(*self.path(kind, slug, attempt), 4096)
        data = data.strip()
        if not 8 <= len(data) <= 512:
            raise ValueError("key")
        return data, owner

    def digest(self, kind, slug, attempt):
        try:
            return hashlib.sha256(self.key(kind, slug, attempt)[0]).hexdigest()
        except Exception:
            return None


def main(request):
    args, op = request["args"], request["op"]
    try:
        paths = Paths(args, create=op == "poll")
    except FileNotFoundError:
        if op == "poll":
            return {"ready": False}
        if op == "finish":
            return {"done": True, "already": True}
        raise
    if op == "poll":
        instant = now()
        if args.get("heartbeat") is True:
            paths.atomic(paths.root, "broker.json", {"at": instant})
        rows = paths.rows("requests")
        for row in rows:
            row["allowed"] = policy(args, row["slug"])
        return {"ready": True, "now": instant, "requests": rows, "claimed": paths.rows("claimed")}
    slug, attempt = args.get("slug"), args.get("id")
    try:
        claimed_dir, claimed_name = paths.path("claimed", slug, attempt)
    except FileNotFoundError:
        if op == "finish":
            return {"done": True, "already": True}
        raise
    if op == "claim":
        source_dir, source_name = paths.path("requests", slug, attempt)
        # Never replace a claim left by an earlier process.
        try:
            os.stat(claimed_name, dir_fd=claimed_dir, follow_symlinks=False)
            return {"claimed": False}
        except FileNotFoundError:
            pass
        try:
            os.rename(source_name, claimed_name, src_dir_fd=source_dir, dst_dir_fd=claimed_dir)
        except FileNotFoundError:
            return {"claimed": False}
        os.fsync(claimed_dir)
        if not args.get("stage"):
            return {"claimed": True}
        body = read_json(claimed_dir, claimed_name)
        if body.get("id") != attempt or body.get("slug") != slug or not policy(args, slug):
            return {"claimed": True, "allowed": False}
        try:
            current, owner = paths.key("key", slug, attempt)
            value = args["next"]
            if not isinstance(value, str) or not 8 <= len(value.encode()) <= 512 or value != value.strip():
                raise ValueError("next")
            fd = os.open(paths.path("next", slug, attempt)[1],
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=paths.secure)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                os.fchown(stream.fileno(), owner.st_uid, owner.st_gid)
                os.fchmod(stream.fileno(), 0o600)
                stream.write(value + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.fsync(paths.secure)
        except Exception:
            return {"claimed": True, "allowed": True, "key": False}
        return {"claimed": True, "allowed": True, "key": True,
                "current": hashlib.sha256(current).hexdigest()}
    if op == "inspect":
        def exists(kind):
            parent, name = paths.path(kind, slug, attempt)
            try:
                body = read_json(parent, name)
                return isinstance(body, dict) and body.get("id") == attempt and body.get("slug") == slug
            except Exception:
                return False
        result = None
        if exists("results"):
            body = read_json(*paths.path("results", slug, attempt))
            result = {k: body.get(k) for k in ("ok", "code")}
        return {"request": exists("requests"), "claimed": exists("claimed"), "result": result,
                "current": paths.digest("key", slug, attempt), "next": paths.digest("next", slug, attempt)}
    if op == "finish":
        if type(args.get("ok")) is not bool or args.get("code") not in ({"ok"} if args["ok"] else CODES):
            raise ValueError("result")
        try:
            os.stat(claimed_name, dir_fd=claimed_dir, follow_symlinks=False)
        except FileNotFoundError:
            return {"done": True, "already": True}
        result_dir, result_name = paths.path("results", slug, attempt)
        try:
            previous = read_json(result_dir, result_name)
        except FileNotFoundError:
            previous = None
        if isinstance(previous, dict) and previous.get("ok") is True:
            os.unlink(claimed_name, dir_fd=claimed_dir)
            os.fsync(claimed_dir)
            return {"done": True, "already": True}
        if not args["ok"]:
            try:
                parent, name = paths.path("next", slug, attempt)
                os.unlink(name, dir_fd=parent)
                os.fsync(parent)
            except FileNotFoundError:
                pass
        paths.atomic(result_dir, result_name, {"id": attempt, "slug": slug, "ok": args["ok"],
                                              "code": args["code"], "at": now()})
        os.unlink(claimed_name, dir_fd=claimed_dir)
        os.fsync(claimed_dir)
        return {"done": True}
    raise ValueError("op")


try:
    print(json.dumps(main(REQUEST), separators=(",", ":")))
except Exception:
    print('{"error":"gateway-failed"}')

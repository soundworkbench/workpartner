"""从镜像模板同步公司统一说明，块外内容逐字节保留；已有 AGENTS.md 不动。"""

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

BEGIN = b'<!-- workpartner:company-instructions:begin -->'
END = b'<!-- workpartner:company-instructions:end -->'
TIER_FILE = Path('/run/workpartner/tier/tier.json')
LEGACY_TIER = '## 本人的任务档位（2026-11-21 管理员设置）'.encode()


def task_tier(path=TIER_FILE):
    standard = {'tier': 'standard', 'tasks': 3, 'taskMemoryMiB': 512}
    try:
        data = json.loads(path.read_bytes())
        if not isinstance(data, dict):
            return standard
        tier = data.get('tier', 'standard')
        if tier not in ('standard', 'open', 'unlimited'):
            return standard
        tasks = data.get('tasks', {'standard': 3, 'open': 5, 'unlimited': None}[tier])
        memory = data.get('taskMemoryMiB', 512 if tier == 'standard' else 1024)
        positive = lambda value: type(value) is int and 0 < value <= 2 ** 53 - 1
        if (tasks is not None and not positive(tasks)) or not positive(memory):
            return standard
        return {'tier': tier, 'tasks': tasks, 'taskMemoryMiB': memory}
    except (OSError, ValueError, RecursionError):
        return standard


def remove_legacy_tier(content):
    return re.sub(rb'^' + re.escape(LEGACY_TIER) + rb'(?:\r?\n|$).*?(?=^## |\Z)',
                  b'', content, flags=re.MULTILINE | re.DOTALL)


def memory_budget(environment=os.environ, limits=None):
    """Prefer the container's effective limit, including per-person overrides."""
    if limits is None:
        limits = [Path('/sys/fs/cgroup/memory.max'), Path('/sys/fs/cgroup/memory/memory.limit_in_bytes')]
    for path in limits:
        try:
            value = int(path.read_text().strip())
            if 0 < value < 2 ** 60:
                return value
        except (OSError, ValueError):
            pass
    return int(environment['PARTNER_MEMORY_BYTES'])


def block_span(content):
    """返回唯一完整标记块的位置；无标记返回 None，残缺或重复标记拒绝写入。"""
    if BEGIN not in content and END not in content:
        return None
    if content.count(BEGIN) != 1 or content.count(END) != 1:
        raise ValueError('公司统一说明标记残缺或重复，未修改说明文件')
    start = content.index(BEGIN)
    stop = content.index(END) + len(END)
    if start >= content.index(END):
        raise ValueError('公司统一说明标记顺序错误，未修改说明文件')
    return start, stop


@contextmanager
def locked_instructions(workspace):
    target = (workspace / 'CLAUDE.md').resolve()
    # 独立锁文件不能随说明的原子替换而更换 inode；与 wp-agent 名单同步共用。
    with os.fdopen(os.open(target.with_name('.' + target.name + '.lock'),
                           os.O_CREAT | os.O_RDWR, 0o600), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def sync(template, workspace, name, memory_bytes=None, tier_path=TIER_FILE):
    with locked_instructions(workspace):
        _sync(template, workspace, name, memory_bytes, tier_path)


def _sync(template, workspace, name, memory_bytes, tier_path):
    """首次或原样旧模板整份更新；个人说明只同步标记块，无块则追加一次。"""
    source = template.read_bytes()
    if any(token in source for token in (b'__MEMORY_MIB__', b'__BACKGROUND_MEMORY_MIB__', b'__BACKGROUND_TASKS_TEXT__')):
        tier = task_tier(tier_path)
        total = memory_budget() if memory_bytes is None else memory_bytes
        if total < 4 * 2 ** 20:
            raise ValueError('容器内存预算过小，未修改说明文件')
        source = source.replace(b'__MEMORY_MIB__', str(total // 2 ** 20).encode())
        source = source.replace(b'__BACKGROUND_MEMORY_MIB__', str(min(tier['taskMemoryMiB'], total // (2 * 2 ** 20))).encode())
        tasks_text = '同时运行的后台任务个数不限' if tier['tasks'] is None else f"同时最多运行 {tier['tasks']} 个"
        source = source.replace(b'__BACKGROUND_TASKS_TEXT__', tasks_text.encode())
    span = block_span(source)
    if span is None:
        raise ValueError('镜像模板缺少公司统一说明块，未修改说明文件')
    block = source[span[0]:span[1]]
    if b'__NAME__' in block:
        raise ValueError('公司统一说明块不能包含姓名占位符')

    # 跟随本人已有的 CLAUDE.md 软链，不把软链替换为普通文件。
    target = (workspace / 'CLAUDE.md').resolve()
    current = target.read_bytes() if target.exists() else None
    personalized = source.replace(b'__NAME__', name.encode('utf-8'))
    if current is None:
        updated = personalized
    else:
        span = block_span(current)
        cleaned = (remove_legacy_tier(current) if span is None else
                   remove_legacy_tier(current[:span[0]]) + current[span[0]:span[1]] + remove_legacy_tier(current[span[1]:]))
        span = block_span(cleaned)
        if span is None:
            # 清单保存主分支已发布的原文；逐字节匹配，不能归一化本人改动。
            versions = json.loads(Path(__file__).with_name('legacy-instructions.json').read_bytes())
            if any(cleaned == version['template'].replace('__NAME__', name).encode('utf-8')
                   for version in versions):
                updated = personalized
            else:
                separator = b'\n' if not cleaned or cleaned.endswith(b'\n') else b'\n\n'
                updated = cleaned + separator + block + b'\n'
        else:
            updated = cleaned[:span[0]] + block + cleaned[span[1]:]

    if updated != current:
        # 同目录替换避免中途退出留下半份说明；保留已有文件权限。
        mode = stat.S_IMODE(target.stat().st_mode) if current is not None else 0o644
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as pending:
            pending_path = Path(pending.name)
            try:
                pending.write(updated)
                pending.flush()
                os.fchmod(pending.fileno(), mode)
                os.replace(pending_path, target)
            finally:
                pending_path.unlink(missing_ok=True)

    agents = workspace / 'AGENTS.md'
    if not agents.exists() and not agents.is_symlink():
        agents.symlink_to('CLAUDE.md')


class TierWatcher:
    def __init__(self, template, workspace, name, tier_path=TIER_FILE):
        self.template, self.workspace, self.name, self.tier_path = template, workspace, name, tier_path
        self.digest = object()

    def poll(self):
        try:
            digest = hashlib.sha256(self.tier_path.read_bytes()).digest()
        except OSError:
            digest = None
        if digest != self.digest:
            sync(self.template, self.workspace, self.name, tier_path=self.tier_path)
            self.digest = digest


if __name__ == '__main__':
    args = (Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
    if '--watch' in sys.argv[4:]:
        watcher = TierWatcher(*args)
        while True:
            try:
                watcher.poll()
            except (OSError, ValueError) as error:
                print(f'同步公司统一说明失败，稍后重试：{error}', file=sys.stderr, flush=True)
            time.sleep(300)
    try:
        sync(*args)
    except (OSError, ValueError) as error:
        sys.exit(f'同步公司统一说明失败：{error}')

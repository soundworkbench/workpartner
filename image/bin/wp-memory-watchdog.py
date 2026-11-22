"""End the largest agent tool process before the container reaches its memory limit.

The kernel OOM killer would otherwise kill the whole container. Only descendants of a
Claude Code or Codex main process are candidates, so the startup script, web service,
messaging bridge, engines and this watchdog keep running and the tool call fails alone.
"""

import os
from pathlib import Path
import signal
import sys
import time

THRESHOLD = 0.85
INTERVAL = 0.2
# Leave time for the killed process to release its memory before measuring again.
SETTLE = 2
# Claude Code also starts its bundled search tools from its own binary, under argv[0] such as rg.
ENGINES = {'claude', 'codex', 'codex.real'}
PAGE = os.sysconf('SC_PAGE_SIZE')
GIB = 2 ** 30


def memory(cgroup):
    """Return (used, limit) in bytes, or None without a limit; reclaimable page cache is not used."""
    limit = (cgroup / 'memory.max').read_text().strip()
    if limit == 'max':
        return None
    stat = dict(line.split() for line in (cgroup / 'memory.stat').read_text().splitlines())
    used = int((cgroup / 'memory.current').read_text()) - int(stat['file']) + int(stat['shmem'])
    return used, int(limit)


def processes(proc):
    table = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text()
            argv0 = (entry / 'cmdline').read_bytes().split(b'\0', 1)[0].decode(errors='replace')
            rss = int((entry / 'statm').read_text().split()[1]) * PAGE
        except (OSError, IndexError, ValueError):
            continue
        close = stat.rindex(')')
        table[int(entry.name)] = {
            'pid': int(entry.name), 'comm': stat[stat.index('(') + 1:close],
            'ppid': int(stat[close + 2:].split()[1]), 'argv0': os.path.basename(argv0), 'rss': rss}
    return table


def engine(process):
    # The Codex wrapper is a Python script, so its command name, not argv[0], names it.
    return process['argv0'] in ENGINES or process['comm'] == 'codex'


def largest_tool(table):
    best = None
    for process in table.values():
        if engine(process):
            continue
        parent, seen = process['ppid'], set()
        while parent in table and parent not in seen and not engine(table[parent]):
            seen.add(parent)
            parent = table[parent]['ppid']
        if parent in table and engine(table[parent]) and (best is None or process['rss'] > best['rss']):
            best = process
    return best


def check(cgroup, proc):
    """Kill one tool process when memory is above the threshold; return the log line."""
    reading = memory(cgroup)
    if reading is None or reading[0] < reading[1] * THRESHOLD:
        return None
    victim = largest_tool(processes(proc))
    if victim is None:
        return None
    try:
        os.kill(victim['pid'], signal.SIGKILL)
    except ProcessLookupError:
        return None
    name = victim['comm'] if victim['argv0'] in (victim['comm'], '') else f"{victim['comm']}（{victim['argv0']}）"
    return (f"内存看护：容器内存 {reading[0] / GIB:.1f}/{reading[1] / GIB:.1f} GiB，"
            f"已结束 {name}，pid {victim['pid']}，占用 {victim['rss'] / GIB:.1f} GiB")


def main(cgroup=Path('/sys/fs/cgroup'), proc=Path('/proc')):
    try:
        if memory(cgroup) is None:
            print('内存看护：容器没有内存上限，不启动', file=sys.stderr)
            return
    except (OSError, ValueError, KeyError):
        print('内存看护：读不到容器内存用量，不启动', file=sys.stderr)
        return
    while True:
        time.sleep(INTERVAL)
        line = check(cgroup, proc)
        if line:
            print(line, file=sys.stderr, flush=True)
            time.sleep(SETTLE)


if __name__ == '__main__':
    main()

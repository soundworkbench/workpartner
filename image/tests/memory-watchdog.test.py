"""The memory watchdog ends only the largest agent tool process under memory pressure."""
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('watchdog', ROOT / 'bin/wp-memory-watchdog.py')
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)

MIB = 2 ** 20
# Holds MiB and prints its pid; argv[0] decides sys.executable, so the interpreter comes from HOLD_PYTHON. "tool" starts a child the way Claude Code starts its bundled
# search (a shell execs the engine binary as rg), then reports how that child ended.
HOLD = '''import os, subprocess, sys, time
block = bytearray(int(sys.argv[1]) * 2 ** 20)
for i in range(0, len(block), 4096): block[i] = 1
if sys.argv[2:3] == ['claude']: open('/proc/self/comm', 'w').write('claude')
print(os.getpid(), flush=True)
if sys.argv[2:3] == ['tool']:
    tool = subprocess.Popen(['bash', '-c', 'exec -a rg "$0" "$1" "$2" claude', os.environ['HOLD_PYTHON'], __file__, sys.argv[3]])
    print(tool.pid, tool.wait(), flush=True)
time.sleep(60)
'''


class MemoryWatchdogTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cgroup = self.root / 'cgroup'
        self.proc = self.root / 'proc'
        self.cgroup.mkdir()
        self.proc.mkdir()
        self.script = self.root / 'hold.py'
        self.script.write_text(HOLD)

    def usage(self, current, limit=1000 * MIB, file=0, shmem=0):
        (self.cgroup / 'memory.max').write_text(f'{limit}\n')
        (self.cgroup / 'memory.current').write_text(f'{current}\n')
        (self.cgroup / 'memory.stat').write_text(f'anon {current - file}\nfile {file}\nshmem {shmem}\n')

    def fake(self, pid, comm, ppid, argv0, mib):
        entry = self.proc / str(pid)
        entry.mkdir()
        (entry / 'stat').write_text(f'{pid} ({comm}) S {ppid} {pid} {pid} 0 -1\n')
        (entry / 'cmdline').write_bytes(argv0.encode() + b'\0--flag\0')
        (entry / 'statm').write_text(f'1 {mib * MIB // watchdog.PAGE} 0\n')

    def hold(self, mib, argv0, *extra):
        """Start a real process; only processes started here are visible to the watchdog."""
        child = subprocess.Popen([argv0, self.script, str(mib), *extra], executable=sys.executable,
                                 env={**os.environ, 'HOLD_PYTHON': sys.executable}, stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (child.kill(), child.wait(), child.stdout.close()))
        self.assertEqual(int(child.stdout.readline()), child.pid)
        os.symlink(f'/proc/{child.pid}', self.proc / str(child.pid))
        return child

    def test_kills_only_the_runaway_tool_of_a_live_engine(self):
        engine = self.hold(96, 'claude', 'tool', '64')
        tool = int(engine.stdout.readline())
        os.symlink(f'/proc/{tool}', self.proc / str(tool))
        outsider = self.hold(128, 'aioncore')

        self.usage(900 * MIB)
        line = watchdog.check(self.cgroup, self.proc)

        self.assertEqual(engine.stdout.readline().split(), [str(tool), '-9'])
        self.assertIsNone(engine.poll())
        self.assertIsNone(outsider.poll())
        self.assertIsNotNone(re.fullmatch(rf'内存看护：容器内存 0\.9/1\.0 GiB，已结束 claude（rg），pid {tool}，占用 0\.\d GiB', line), line)

    def test_engines_and_services_are_never_chosen(self):
        self.fake(1, 'start.sh', 0, '/bin/bash', 50)
        self.fake(10, 'aioncore', 1, 'aioncore', 3000)
        self.fake(11, 'cc-connect', 1, 'cc-connect', 3000)
        self.fake(20, 'codex', 10, '/usr/bin/python3', 40)
        self.fake(21, 'codex.real', 20, '/opt/bin/codex.real', 2000)
        self.fake(22, 'bash', 21, '/bin/bash', 5)
        self.fake(23, 'python3 (x)', 22, 'python3', 300)
        self.fake(30, 'claude', 11, '/opt/claude/bin/claude', 2500)
        self.fake(31, 'claude', 30, 'rg', 200)
        self.assertEqual(watchdog.largest_tool(watchdog.processes(self.proc))['pid'], 23)
        (self.proc / '23').rename(self.root / 'gone')
        self.assertEqual(watchdog.largest_tool(watchdog.processes(self.proc))['pid'], 31)

    def test_reclaimable_cache_and_low_usage_do_not_kill(self):
        self.fake(30, 'claude', 1, 'claude', 100)
        self.fake(31, 'claude', 30, 'rg', 100)
        for current, file in ((800 * MIB, 0), (990 * MIB, 600 * MIB)):
            self.usage(current, file=file)
            self.assertIsNone(watchdog.check(self.cgroup, self.proc))
        self.usage(990 * MIB, file=600 * MIB, shmem=500 * MIB)
        self.assertEqual(watchdog.memory(self.cgroup), (890 * MIB, 1000 * MIB))

    def test_container_without_limit_does_not_start(self):
        (self.cgroup / 'memory.max').write_text('max\n')
        result = subprocess.run([sys.executable, '-I', '-c',
                                 'import runpy, sys; from pathlib import Path; '
                                 'runpy.run_path(sys.argv[1])["main"](Path(sys.argv[2]))',
                                 ROOT / 'bin/wp-memory-watchdog.py', self.cgroup],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertIn('没有内存上限', result.stderr)


if __name__ == '__main__':
    unittest.main()

"""以环境变量指定的假消息桥验证守护进程，所有等待都有截止时间。"""
from datetime import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'bin/wp-feishu-bot.py'


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.run = self.base / 'run'
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, WP_CC_CONNECT_DIR=str(self.base),
                        WP_CC_CONNECT_BIN=str(self.bin / 'cc-connect'),
                        PATH=str(self.bin) + os.pathsep + os.environ['PATH'])
        self.process = None
        self.log = (self.base / 'output').open('wb')
        self.err = (self.base / 'error').open('wb')
        self.addCleanup(self.log.close)
        self.addCleanup(self.err.close)
        self.addCleanup(self.stop)

    def fake(self, body):
        command = self.bin / 'cc-connect'
        command.write_text('#!' + sys.executable + '\nimport os, time, sys, signal\n' + body)
        command.chmod(0o755)

    def config(self):
        (self.base / 'config.toml').write_text('[[projects]]\nname="test"\n')

    def start(self, launcher=None):
        command = ([sys.executable, '-c', launcher, str(SCRIPT)] if launcher else
                   [sys.executable, str(SCRIPT), 'supervise'])
        self.process = subprocess.Popen(command, env=self.env, stdout=self.log, stderr=self.err,
                                        umask=0o022)

    def output(self):
        return (self.base / 'output').read_text() + (self.base / 'error').read_text()

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
                self.fail('守护进程未在 TERM 后退出')

    def wait_for(self, predicate, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            if self.process and self.process.poll() is not None:
                self.fail(self.output())
            time.sleep(0.05)
        self.fail('超时等待消息桥状态：' + self.output())

    def pid(self):
        try:
            return int((self.run / 'bridge.pid').read_text())
        except (OSError, ValueError):
            return None

    def event(self):
        try:
            return json.loads((self.run / 'bridge-state.json').read_text()).get('event')
        except (OSError, ValueError):
            return None

    def restart(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'restart'], env=self.env,
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '{"ok":true}\n')

    def test_late_config_restart_state_and_term(self):
        self.fake('print("connected to wss://x", flush=True)\n'
                  'print("private raw log", file=sys.stderr, flush=True)\n'
                  'time.sleep(60)\n')
        self.start()
        time.sleep(0.2)
        self.assertIsNone(self.pid())
        self.config()
        first = self.wait_for(self.pid)
        self.wait_for(lambda: self.event() == 'connected')
        state = json.loads((self.run / 'bridge-state.json').read_text())
        self.assertEqual(set(state), {'event', 'at'})
        datetime.fromisoformat(state['at'])
        self.assertNotIn('wss', json.dumps(state))
        self.assertEqual((self.base / 'output').read_bytes(), b'connected to wss://x\n')
        self.assertIn('private raw log\n', (self.base / 'error').read_text())
        self.assertNotIn('private raw log', (self.base / 'output').read_text())
        self.assertNotIn('connected to wss://x', (self.base / 'error').read_text())
        self.restart()
        second = self.wait_for(lambda: self.pid() if self.pid() != first else None, timeout=3)
        self.wait_for(lambda: self.event() == 'connected')
        self.assertEqual(self.output().count('[startup] bridge-started'), 1)
        self.stop()
        for pid in (first, second):
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        self.assertFalse((self.run / 'bridge.pid').exists())
        result = subprocess.run([sys.executable, str(SCRIPT), 'restart'], env=self.env,
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'ok': False, 'error': 'no_supervisor'})

    def test_all_events_and_new_start_clears_state(self):
        self.config()
        # 用文件推进假桥输出，避免依赖严格的计时窗口。
        self.fake('from pathlib import Path\n'
                  'base=Path(os.environ["WP_CC_CONNECT_DIR"])\n'
                  'last=""\n'
                  'while True:\n'
                  '    text=(base/"event").read_text() if (base/"event").exists() else ""\n'
                  '    if text and text != last:\n'
                  '        channel, line=text.split("|", 1)\n'
                  '        print(line, file=getattr(sys, channel), flush=True); last=text\n'
                  '    time.sleep(0.02)\n')
        self.start()
        first = self.wait_for(self.pid)
        self.assertIsNone(self.event())
        for channel in ('stdout', 'stderr'):
            for line, event in [('connected to wss://x', 'connected'), ('disconnected to wss://x', 'disconnected'),
                                ('websocket reconnecting: attempt 2', 'reconnecting'),
                                ('websocket reconnect attempts exhausted after 3 attempts', 'exhausted')]:
                (self.base / 'event').write_text(channel + '|[lark] ' + line)
                self.wait_for(lambda: self.event() == event)
            state = (self.run / 'bridge-state.json').read_bytes()
            for line in ('user says reconnecting', 'user says connected', 'connected to ws://x',
                         'disconnected to chat', 'websocket reconnecting: attempt nope',
                         'websocket reconnect attempts exhausted after nope attempts'):
                (self.base / 'event').write_text(channel + '|' + line)
                path = self.base / ('output' if channel == 'stdout' else 'error')
                self.wait_for(lambda: line in path.read_text())
                time.sleep(0.05)
                self.assertEqual((self.run / 'bridge-state.json').read_bytes(), state)
        (self.base / 'event').unlink()
        self.restart()
        self.wait_for(lambda: self.pid() and self.pid() != first)
        self.assertEqual(json.loads((self.run / 'bridge-state.json').read_text()), {'event': None, 'at': None})

    def test_crashes_back_off_and_restart_interrupts_backoff(self):
        self.fake('from pathlib import Path\n'
                  'with (Path(os.environ["WP_CC_CONNECT_DIR"])/"starts").open("a") as f:\n'
                  '    f.write(str(time.monotonic())+"\\n")\n'
                  'sys.exit(1)\n')
        self.config()
        self.start()
        def starts():
            path = self.base / 'starts'
            return [float(x) for x in path.read_text().splitlines()] if path.exists() else []
        self.wait_for(lambda: len(starts()) >= 3, timeout=9)
        times = starts()
        self.assertGreaterEqual(times[1] - times[0], 1.9)
        self.assertGreaterEqual(times[2] - times[1], 3.9)
        self.assertLess(times[1] - times[0], 3.5)
        self.assertLess(times[2] - times[1], 5.5)
        now = time.monotonic()
        self.restart()
        self.wait_for(lambda: len(starts()) >= 4, timeout=2)
        self.assertLess(starts()[3] - now, 2)

    def test_backoff_caps_at_60_and_stable_run_resets_it(self):
        clock = self.base / 'clock'
        def advance(value):
            temp = self.base / 'clock.next'
            temp.write_text(str(value))
            temp.replace(clock)
        advance(0)
        self.fake('from pathlib import Path\n'
                  'base=Path(os.environ["WP_CC_CONNECT_DIR"])\n'
                  'with (base/"starts").open("a") as f: f.write("start\\n")\n'
                  'while (base/"hold").exists(): time.sleep(0.02)\n'
                  'sys.exit(1)\n')
        self.config()
        launcher = """import os, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
module['time'].monotonic = lambda: float(Path(os.environ['WP_CC_CONNECT_DIR'], 'clock').read_text())
sys.argv = [sys.argv[1], 'supervise']
sys.exit(module['main']())
"""
        self.start(launcher)
        def count():
            path = self.base / 'starts'
            return len(path.read_text().splitlines()) if path.exists() else 0
        self.wait_for(lambda: count() == 1)
        now = 0
        for number, delay in enumerate((2, 4, 8, 16, 32, 60, 60), start=2):
            self.wait_for(lambda: self.pid() is None)
            advance(now + delay - 0.1)
            time.sleep(0.2)
            self.assertEqual(count(), number - 1)
            if number == 8:
                (self.base / 'hold').touch()
            now += delay
            advance(now)
            self.wait_for(lambda: count() == number)
        advance(now + 301)
        (self.base / 'hold').unlink()
        self.wait_for(lambda: self.pid() is None)
        advance(now + 302.9)
        time.sleep(0.2)
        self.assertEqual(count(), 8)
        advance(now + 303)
        self.wait_for(lambda: count() == 9)

    def test_term_kills_bridge_that_ignores_term(self):
        self.fake('signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
                  'print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        self.config()
        self.start()
        pid = self.wait_for(self.pid)
        self.wait_for(lambda: self.event() == 'connected')
        self.stop()
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_bridge_inherits_umask_and_runtime_files_are_private(self):
        self.fake('mask=os.umask(0)\nos.umask(mask)\n'
                  'print("umask="+oct(mask), flush=True)\n'
                  'print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        self.config()
        self.start()
        self.wait_for(lambda: self.event() == 'connected')
        self.assertIn('umask=0o22\n', self.output())
        self.assertEqual(self.run.stat().st_mode & 0o777, 0o700)
        for name in ('bridge.pid', 'bridge-state.json', 'restart.fifo', 'supervisor.lock'):
            self.assertEqual((self.run / name).stat().st_mode & 0o777, 0o600, name)

    def check_unwritable_file(self, name):
        self.run.mkdir()
        blocked = self.run / name
        blocked.mkdir()
        self.fake('from pathlib import Path\n'
                  'with (Path(os.environ["WP_CC_CONNECT_DIR"])/"starts").open("a") as f:\n'
                  '    f.write(str(os.getpid())+"\\n")\n'
                  'print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        self.config()
        self.start()

        def pids():
            path = self.base / 'starts'
            return [int(x) for x in path.read_text().splitlines()] if path.exists() else []

        self.wait_for(lambda: len(pids()) == 1)
        self.wait_for(lambda: f'无法写入 {name}' in self.output())
        first = pids()[0]
        os.kill(first, 0)
        self.assertIsNone(self.process.poll())
        os.kill(first, signal.SIGKILL)
        self.wait_for(lambda: len(pids()) == 2)
        second = pids()[1]
        os.kill(second, 0)
        self.restart()
        self.wait_for(lambda: len(pids()) == 3, timeout=3)
        os.kill(pids()[2], 0)
        self.assertIsNone(self.process.poll())
        self.assertNotIn('Traceback', self.output())
        blocked.rmdir()
        self.restart()
        self.wait_for(lambda: len(pids()) == 4, timeout=3)
        self.wait_for(lambda: self.event() == 'connected' and self.pid() == pids()[3])
        self.assertEqual(list(self.run.glob('.bot-*')), [])
        self.stop()
        for pid in pids():
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_state_write_failure_preserves_bridge_and_restarts(self):
        self.check_unwritable_file('bridge-state.json')

    def test_pid_write_failure_preserves_bridge_and_restarts(self):
        self.check_unwritable_file('bridge.pid')

    def test_unexpected_loop_error_recovers_without_stopping_bridge(self):
        self.fake('print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        self.config()
        self.start('''import runpy, sys
module = runpy.run_path(sys.argv[1])
supervisor = module['Supervisor']
original = supervisor.read_output
def fail_once(self, channel):
    supervisor.read_output = original
    raise RuntimeError('private exception text')
supervisor.read_output = fail_once
sys.argv = [sys.argv[1], 'supervise']
sys.exit(module['main']())
''')
        first = self.wait_for(self.pid)
        self.wait_for(lambda: self.event() == 'connected')
        self.assertEqual(self.pid(), first)
        self.assertIn('守护循环异常（RuntimeError）', self.output())
        self.assertNotIn('private exception text', self.output())
        self.restart()
        self.wait_for(lambda: self.pid() and self.pid() != first)

    def test_default_binary_ignores_path(self):
        self.fake('print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        del self.env['WP_CC_CONNECT_BIN']
        self.config()
        # 镜像绝对路径在本机不存在，只替换执行阶段，断言实际选择的路径。
        self.start('''import os, runpy, subprocess, sys
original = subprocess.Popen
def launch(args, **kwargs):
    assert args[0] == '/opt/workpartner/bin/cc-connect', args[0]
    args[0] = os.path.join(os.environ['WP_CC_CONNECT_DIR'], 'bin', 'cc-connect')
    return original(args, **kwargs)
subprocess.Popen = launch
sys.argv = [sys.argv[1], 'supervise']
runpy.run_path(sys.argv[0], run_name='__main__')
''')
        self.wait_for(lambda: self.event() == 'connected')


if __name__ == '__main__':
    unittest.main()

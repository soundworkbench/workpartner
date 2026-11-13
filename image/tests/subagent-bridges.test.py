"""多桥进程隔离、查询状态与共享期限的命令级回归。"""
import fcntl
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import time
import unittest

HERE = Path(__file__).resolve().parent
SUPERVISOR = runpy.run_path(str(HERE / 'feishu-supervisor.test.py'))['SupervisorTest']
BaseSupervisor = type('BaseSupervisor', (unittest.TestCase,),
                      {key: value for key, value in SUPERVISOR.__dict__.items()
                       if not key.startswith('test_') and not key.startswith('__')})
del SUPERVISOR
FIXTURE = runpy.run_path(str(HERE / 'agents.test.py'))['Fixture']
SCRIPT = HERE.parent / 'bin/wp-feishu-bot.py'


class MultiBridgeTest(BaseSupervisor):
    def test_subbridge_pid_repaired_after_control_preparation(self):
        self.fake('from pathlib import Path\n'
                  'base=Path(sys.argv[sys.argv.index("--config")+1]).parent\n'
                  'with (base/"starts").open("a") as f: f.write(str(os.getpid())+"\\n")\n'
                  'print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        self.config()
        sub = self.sub('s11111111')
        blocked_fifo = self.run / 'restart.fifo'
        blocked_fifo.mkdir(parents=True)
        blocked_run = sub / 'run'
        blocked_run.touch()
        self.start()
        self.wait_for(self.pid)
        def sub_pid():
            path = sub / 'starts'
            return int(path.read_text().splitlines()[-1]) if path.exists() else None
        sub_child = self.wait_for(sub_pid)
        self.assertIsNone(self.subpid(sub))
        self.wait_for(lambda: self.output().count('控制通道准备失败') >= 2)
        blocked_run.unlink()
        blocked_run.mkdir()
        blocked_fifo.rmdir()
        self.wait_for(lambda: self.run.joinpath('restart.fifo').is_fifo(), timeout=9)
        self.wait_for(lambda: self.subpid(sub) == sub_child, timeout=3)
        self.assertNotEqual(self.bridge_status(sub / 'run')['online'], 'offline')

    def test_restart_subbridge_interrupts_long_loop_error_backoff(self):
        self.fake('from pathlib import Path\n'
                  'base=Path(sys.argv[sys.argv.index("--config")+1]).parent\n'
                  'with (base/"starts").open("a") as f: f.write(str(os.getpid())+"\\n")\n'
                  'print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        self.config()
        sub = self.sub('s11111111')
        launcher = '''import os, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
real_monotonic = module['time'].monotonic
origin = real_monotonic()
module['time'].monotonic = lambda: origin + (real_monotonic() - origin) * 4
base = module['selectors'].DefaultSelector
class FailingSelector(base):
    def select(self, timeout=None):
        if Path(os.environ['WP_CC_CONNECT_DIR'], 'fail').exists():
            raise RuntimeError('private loop failure')
        return super().select(timeout)
module['selectors'].DefaultSelector = FailingSelector
sys.argv = [sys.argv[1], 'supervise']
sys.exit(module['main']())
'''
        self.start(launcher)
        main = self.wait_for(self.pid)
        first = self.wait_for(lambda: self.subpid(sub))
        (self.base / 'fail').touch()
        self.wait_for(lambda: self.output().count('守护循环异常') >= 5, timeout=8)
        started = time.monotonic()
        self.send('restart s11111111')
        second = self.wait_for(lambda: self.subpid(sub) if self.subpid(sub) != first else None,
                               timeout=3)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(self.pid(), main)
        self.assertNotEqual(first, second)
        self.assertNotIn('private loop failure', self.output())
        (self.base / 'fail').unlink()

    def test_subbridge_output_error_does_not_pause_other_bridges(self):
        self.fake('from pathlib import Path\n'
                  'base=Path(sys.argv[sys.argv.index("--config")+1]).parent\n'
                  'with (base/"starts").open("a") as f: f.write(str(time.monotonic())+" "+str(os.getpid())+"\\n")\n'
                  'print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        self.config()
        bad, good = self.sub('s11111111'), self.sub('s22222222')
        launcher = '''import runpy, sys, time
from pathlib import Path
module = runpy.run_path(sys.argv[1])
cls = module['Supervisor']
original = cls.read_output
def read_output(self, channel):
    if self.agent_id == 's11111111':
        raise OSError('private-secret')
    return original(self, channel)
def wait_after_error(self, delay):
    (self.base / 'global-wait').touch()
cls.read_output = read_output
cls.wait_after_error = wait_after_error
sys.exit(cls(time.time()).run())
'''
        self.start(launcher=launcher)
        main = self.wait_for(self.pid)
        good_pid = self.wait_for(lambda: self.subpid(good))
        self.wait_for(lambda: 's11111111 消息桥输出异常' in self.output())
        self.wait_for(lambda: self.event() == 'connected')
        self.wait_for(lambda: json.loads((good / 'run/bridge-state.json').read_text()).get('event') == 'connected')
        self.send('restart s22222222')
        changed = self.wait_for(lambda: self.subpid(good) if self.subpid(good) != good_pid else None, timeout=2)
        def starts():
            return [line.split() for line in (bad / 'starts').read_text().splitlines()] if (bad / 'starts').exists() else []
        self.wait_for(lambda: len(starts()) >= 3 and self.subpid(bad) is None, timeout=9)
        attempts = starts()
        self.assertEqual(len(attempts), 3)
        self.assertGreaterEqual(float(attempts[1][0]) - float(attempts[0][0]), 1.9)
        self.assertGreaterEqual(float(attempts[2][0]) - float(attempts[1][0]), 3.9)
        for _, pid in attempts:
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid), 0)
        self.assertEqual(self.pid(), main)
        self.assertEqual(self.subpid(good), changed)
        self.assertEqual(self.output().count('s11111111 消息桥输出异常'), 3)
        self.assertEqual(self.process.poll(), None)
        self.stop()
        self.assertFalse((self.base / 'global-wait').exists())
        self.assertNotIn('private-secret', self.output())

    def sub(self, agent_id):
        base = self.base / 'agents' / agent_id
        base.mkdir(parents=True)
        (base / 'agent.json').write_text(json.dumps({'id':agent_id,'name':agent_id,'createdAt':'2026-11-13T00:00:00Z'}))
        (base / 'config.toml').write_text('[[projects]]\nname="agent-' + agent_id + '"\n')
        return base

    def subpid(self, base):
        try:
            return int((base / 'run/bridge.pid').read_text())
        except (OSError, ValueError):
            return None

    def send(self, message):
        with (self.run / 'restart.fifo').open('w') as stream:
            stream.write(message + '\n')

    def test_scan_restart_delete_prefix_and_registration(self):
        self.fake('mask=os.umask(0); os.umask(mask)\nprint("umask="+oct(mask), flush=True)\n'
                  'print("connected to wss://x", flush=True)\n'
                  'print("stderr line", file=sys.stderr, flush=True)\ntime.sleep(60)\n')
        self.config()
        self.start()
        main = self.wait_for(self.pid)
        first = self.sub('s11111111')
        start = time.monotonic()
        first_pid = self.wait_for(lambda: self.subpid(first), timeout=3.5)
        self.assertLess(time.monotonic() - start, 3.1)
        self.wait_for(lambda: json.loads((first / 'run/bridge-state.json').read_text()).get('event') == 'connected')
        second = self.sub('s22222222')
        self.send('rescan')
        start = time.monotonic()
        second_pid = self.wait_for(lambda: self.subpid(second), timeout=1)
        self.assertLess(time.monotonic() - start, 1)
        self.assertEqual(self.pid(), main)
        result = subprocess.run([sys.executable, str(SCRIPT), 'restart', '--agent', 's11111111'],
                                env=self.env, capture_output=True, text=True, timeout=3)
        self.assertEqual(json.loads(result.stdout), {'ok':True})
        changed = self.wait_for(lambda: self.subpid(first) if self.subpid(first) != first_pid else None)
        self.assertEqual(self.pid(), main)
        self.assertEqual(self.subpid(second), second_pid)
        self.restart()
        main_changed = self.wait_for(lambda: self.pid() if self.pid() != main else None)
        self.assertEqual(self.subpid(first), changed)
        self.assertEqual(self.subpid(second), second_pid)
        (first / 'config.toml').unlink()
        self.send('rescan')
        self.wait_for(lambda: self.subpid(first) is None)
        with self.assertRaises(ProcessLookupError):
            os.kill(changed, 0)
        self.assertEqual(self.pid(), main_changed)
        self.assertEqual(self.subpid(second), second_pid)
        for agent_id in ('s11111111', 's00000000', '../main'):
            result = subprocess.run([sys.executable, str(SCRIPT), 'restart', '--agent', agent_id],
                                    env=self.env, capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout), {'ok':False,'error':'not_found'})
        out = (self.base / 'output').read_text().splitlines()
        self.assertIn('umask=0o22', out)
        self.assertIn('[agent s11111111] umask=0o77', out)
        self.assertIn('connected to wss://x', out)
        self.assertIn('[agent s11111111] connected to wss://x', out)
        self.assertIn('[agent s22222222] connected to wss://x', out)
        self.assertNotIn('[agent main] connected to wss://x', out)
        self.assertIn('[agent s22222222] stderr line', (self.base / 'error').read_text())
        self.assertEqual(self.output().count('[startup] bridge-started'), 1)
        invalid = self.sub('invalid')
        unregistered = self.sub('s33333333')
        (unregistered / 'agent.json').unlink()
        self.send('rescan\nunknown\nrestart invalid')
        time.sleep(0.3)
        self.assertIsNone(self.subpid(invalid))
        self.assertIsNone(self.subpid(unregistered))
        self.assertEqual(self.pid(), main_changed)
        data = self.base / 'workdata'
        self.env['WP_DATA_DIR'] = str(data)
        (data / 'work').mkdir(parents=True)
        (data / 'work/CLAUDE.md').write_text('main original')
        for agent_id in ('s11111111', 's22222222'):
            (data / 'agents' / agent_id).mkdir(parents=True)
        renamed = subprocess.run([sys.executable, str(SCRIPT.with_name('wp-agent')), 'rename', 's22222222'],
                                 input='{"name":"新名字"}', capture_output=True, text=True, env=self.env, timeout=5)
        self.assertEqual(renamed.returncode, 0, renamed.stderr)
        self.assertEqual(json.loads(renamed.stdout)['agent']['name'], '新名字')
        self.assertEqual(self.subpid(second), second_pid)
        self.assertEqual(self.pid(), main_changed)
        removed = subprocess.run([sys.executable, str(SCRIPT.with_name('wp-agent')), 'delete', 's22222222'],
                                 capture_output=True, text=True, env=self.env, timeout=5)
        self.assertEqual(json.loads(removed.stdout), {'ok': True})
        def stopped():
            try:
                os.kill(second_pid, 0)
                return False
            except ProcessLookupError:
                return True
        self.wait_for(stopped)
        self.assertFalse(second.exists())
        self.assertTrue(list((data / '.trash/agents').glob('s22222222-*/bridge/config.toml')))
        self.assertEqual(self.pid(), main_changed)

    def test_only_crashing_bridge_backs_off_and_refresh_preserves_workdir(self):
        self.fake('from pathlib import Path\n'
                  'base=Path(sys.argv[sys.argv.index("--config")+1]).parent\n'
                  'with (base/"starts").open("a") as f: f.write(str(time.monotonic())+"\\n")\n'
                  'if base.name == "s11111111": sys.exit(1)\n'
                  'print("connected to wss://x", flush=True)\ntime.sleep(60)\n')
        self.config()
        bad, good = self.sub('s11111111'), self.sub('s22222222')
        (good / 'config.toml').write_text('[[projects]]\nname="agent-s22222222"\n[projects.agent]\ntype="codex"\n[projects.agent.options]\nwork_dir="/data/agents/s22222222"\n')
        self.env.update(PARTNER_BRIDGE_MODEL='new-model', PARTNER_DEFAULT_EFFORT='high')
        self.start()
        main = self.wait_for(self.pid)
        good_pid = self.wait_for(lambda: self.subpid(good))
        def starts():
            return [float(value) for value in (bad / 'starts').read_text().splitlines()] if (bad / 'starts').exists() else []
        self.wait_for(lambda: len(starts()) >= 3, timeout=9)
        times = starts()
        self.assertGreaterEqual(times[1] - times[0], 1.9)
        self.assertGreaterEqual(times[2] - times[1], 3.9)
        self.assertEqual(self.pid(), main)
        self.assertEqual(self.subpid(good), good_pid)
        self.assertEqual(len((good / 'starts').read_text().splitlines()), 1)
        self.assertEqual(json.loads((good / 'run/bridge-state.json').read_text())['event'], 'connected')
        self.assertIn('model = "new-model"', (good / 'config.toml').read_text())
        self.assertIn('work_dir="/data/agents/s22222222"', (good / 'config.toml').read_text())
        self.send('restart s11111111')
        self.wait_for(lambda: len(starts()) >= 4, timeout=1.5)
        self.assertEqual(self.pid(), main)
        self.assertEqual(self.subpid(good), good_pid)


class InfoTest(FIXTURE):
    def test_cache_lock_contention_skips_write_without_delaying_info(self):
        item = self.create()
        directory = self.directory(item)
        self.config(directory, 'cli_sub')
        cache = directory / 'run/bot-cache.json'
        original = cache.read_bytes()
        launcher = '''import runpy, sys
module = runpy.run_path(sys.argv[1])
def fetch(*args):
    return {'name': 'fresh', 'avatar': None, 'activate': True}
module['info'].__globals__['fetch_bot'] = fetch
sys.argv = sys.argv[1:]
sys.exit(module['main']())
'''
        for existing in (True, False):
            with self.subTest(existing=existing):
                if not existing:
                    cache.unlink()
                with (self.base / 'agents.lock').open('w') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    start = time.monotonic()
                    result = self.command('wp-feishu-bot.py', 'info', '--refresh', launcher=launcher, timeout=2)
                    self.assertLess(time.monotonic() - start, 2)
                info = json.loads(result.stdout)
                self.assertTrue(info['ok'])
                self.assertEqual(info['bots'][0]['name'], 'fresh')
                self.assertIsNone(info['bots'][0]['error'])
                self.assertEqual(info['agents'][0]['id'], item['id'])
                if existing:
                    self.assertEqual(cache.read_bytes(), original)
                else:
                    self.assertFalse(cache.exists())
        self.command('wp-feishu-bot.py', 'info', '--refresh', launcher=launcher)
        self.assertEqual(json.loads(cache.read_text())['cli_sub']['name'], 'fresh')
        self.assertEqual(cache.stat().st_mode & 0o777, 0o600)

    def test_cache_fetch_racing_delete_does_not_recreate_registration(self):
        item = self.create()
        self.config(self.directory(item), 'cli_sub')
        launcher = '''import os, runpy, subprocess, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
def fetch(*args):
    agent_id = module['AGENTS']['registered']()[0]['id']
    deleted = subprocess.run([sys.executable, '-I', str(Path(sys.argv[0]).with_name('wp-agent')),
                              'delete', agent_id], capture_output=True, text=True, timeout=5)
    if deleted.returncode: raise RuntimeError('delete failed')
    return {'name': 'fetched', 'avatar': None, 'activate': True}
module['info'].__globals__['fetch_bot'] = fetch
sys.argv = sys.argv[1:]
sys.exit(module['main']())
'''
        result = self.command('wp-feishu-bot.py', 'info', '--refresh', launcher=launcher)
        info = json.loads(result.stdout)
        self.assertEqual(info['agents'], [])
        self.assertEqual(info['bots'][0]['name'], 'fetched')
        self.assertFalse(self.directory(item).exists())
        self.assertFalse(self.work(item).exists())
        self.assertTrue(list((self.data / '.trash/agents').glob(item['id'] + '-*/bridge/agent.json')))

    def config(self, directory, app_id):
        (directory / 'config.toml').write_text('[[projects]]\nname="test"\n[[projects.platforms]]\ntype="feishu"\n'
                                                f'[projects.platforms.options]\napp_id="{app_id}"\napp_secret="private-secret"\n')
        (directory / 'config.toml').chmod(0o600)
        run = directory / 'run'
        run.mkdir(exist_ok=True)
        (run / 'bot-cache.json').write_text(json.dumps({app_id:{'name':'cached', 'avatar':None, 'activate':True, 'at':time.time()}}))
        return run

    def info(self):
        result = self.command('wp-feishu-bot.py', 'info')
        self.assertEqual(len(result.stdout.splitlines()), 1)
        return json.loads(result.stdout)

    def test_separate_status_order_and_unreadable_sub(self):
        first, second = self.create('一'), self.create('二')
        main_run = self.config(self.base, 'cli_main')
        first_run = self.config(self.directory(first), 'cli_first')
        second_run = self.config(self.directory(second), 'cli_second')
        at = '2026-11-13T00:00:00+00:00'
        for run in (main_run, first_run, second_run):
            (run / 'bridge-state.json').write_text(json.dumps({'event':'connected','at':at}))
        (main_run / 'bridge.pid').write_text(str(os.getpid()))
        (second_run / 'bridge.pid').write_text(str(os.getpid()))
        result = self.info()
        self.assertEqual(result['limit'], 5)
        self.assertEqual([item['id'] for item in result['agents']], ['main',first['id'],second['id']])
        self.assertEqual([item['agentId'] for item in result['bots']], ['main',first['id'],second['id']])
        self.assertEqual([item['online'] for item in result['bots']], ['online','offline','online'])
        self.assertTrue(all(item['lastEvent'] == 'connected' and item['lastEventAt'] == at for item in result['bots']))
        self.assertTrue(all(item['setup'] == 'connected' for item in result['agents']))
        self.assertEqual([item['appId'] for item in result['agents']], ['cli_main','cli_first','cli_second'])
        self.assertEqual(self.agent('list')['agents'], result['agents'])
        (self.directory(first) / 'config.toml').write_text('private-secret [[broken')
        result = self.info()
        self.assertEqual(len(result['bots']), 2)
        self.assertIsNone(result['agents'][1]['appId'])
        self.assertEqual(result['agents'][1]['setup'], 'connected')
        (self.base / 'config.toml').unlink()
        self.assertEqual([item['id'] for item in self.info()['agents']], [first['id'],second['id']])
        (self.base / 'config.toml').write_text('private-secret [[broken')
        result = self.command('wp-feishu-bot.py', 'info', code=1)
        self.assertEqual(json.loads(result.stdout), {'ok': False, 'error': 'config_unreadable'})

    def test_setup_branches_and_unknown_state(self):
        item = self.create()
        path = self.directory(item) / '.feishu-setup.json'
        for state, wanted in [(None,'none'), ({'status':'preparing','expiresAt':time.time()+60},'preparing'),
                              ({'status':'waiting','expiresAt':time.time()+60},'waiting'),
                              ({'status':'preparing','expiresAt':0},'expired'),
                              ({'status':'waiting','expiresAt':0},'expired'),
                              ({'status':'needs_identity'},'needs_identity'), ({'status':'failed'},'failed'),
                              ({'status':'expired'},'expired'), ({'status':'unknown'},'failed'),
                              ({'status':'connected'},'none')]:
            if state:
                path.write_text(json.dumps(state))
            result = self.info()
            self.assertEqual(result['agents'][0]['setup'], wanted)
            self.assertEqual(result['bots'], [])
            self.assertEqual(result['agents'], self.agent('list')['agents'])
        self.config(self.directory(item), 'cli_ready')
        self.assertEqual(self.info()['agents'][0]['setup'], 'connected')

    def test_shared_deadline_and_no_failed_cache(self):
        first, second = self.create('一'), self.create('二')
        for directory, app in ((self.base,'cli_main'),(self.directory(first),'cli_first'),(self.directory(second),'cli_second')):
            run = self.config(directory, app)
            (run / 'bot-cache.json').unlink()
        launcher = '''import runpy, socket, sys, time
def resolve(*args, **kwargs): time.sleep(60)
socket.getaddrinfo = resolve
sys.argv = [sys.argv[1], 'info']
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        self.env['WP_FEISHU_API_BASE'] = 'http://dns.test'
        start = time.monotonic()
        result = subprocess.run([sys.executable, '-I', '-c', launcher, str(SCRIPT)], env=self.env,
                                capture_output=True, text=True, timeout=9)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(time.monotonic() - start, 8)
        bots = json.loads(result.stdout)['bots']
        self.assertEqual(len(bots), 3)
        self.assertTrue(all(item['error'] == 'feishu_unreachable' for item in bots))
        self.assertFalse(list(self.base.rglob('bot-cache.json')))
        self.assertNotIn('private-secret', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()

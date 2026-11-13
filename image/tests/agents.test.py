"""通过命令边界验证助手目录、名单、并发调用和扫码，不访问外网。"""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest

BIN = Path(__file__).resolve().parents[1] / 'bin'
HOME = BIN.parent / 'home'


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.base = self.data / '.cc-connect'
        self.base.mkdir()
        (self.data / 'work').mkdir()
        self.original = '我的说明\r\n保留这个尾巴'.encode()
        (self.data / 'work/CLAUDE.md').write_bytes(self.original)
        self.template = self.data / 'instructions'
        self.template.write_text('你好 __NAME__\n<!-- workpartner:company-instructions:begin -->\n公司规则\n<!-- workpartner:company-instructions:end -->\n')
        self.env = dict(os.environ, WP_DATA_DIR=str(self.data), WP_CC_CONNECT_DIR=str(self.base),
                        WP_INSTRUCTIONS_TEMPLATE=str(self.template), PARTNER_BRIDGE_MODEL='test-model',
                        PARTNER_DEFAULT_EFFORT='high', WP_FEISHU_TEMPLATE=str(HOME / 'cc-connect-feishu.toml'))

    def command(self, script, *args, payload=None, code=0, cwd=None, timeout=9, launcher=None, optimize=False):
        command = [sys.executable, '-I', '-B', *(['-O'] if optimize else [])]
        if launcher:
            command += ['-c', launcher]
        result = subprocess.run([*command, str(BIN / script), *args], env=self.env,
                                input=payload, capture_output=True, text=True, cwd=cwd, timeout=timeout)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        self.assertNotIn('private-secret', result.stdout + result.stderr)
        return result

    def agent(self, *args, name=None, code=0, **kwargs):
        result = self.command('wp-agent', *args, payload=json.dumps({'name': name}) if name is not None else None,
                              code=code, **kwargs)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        return json.loads(result.stdout)

    def create(self, name='研究员'):
        return self.agent('create', name=name)['agent']

    def directory(self, agent):
        return self.base / 'agents' / agent['id']

    def work(self, agent):
        return self.data / 'agents' / agent['id']

    def fake(self, name, body):
        path = self.data / name
        path.write_text('#!' + sys.executable + '\n' + body)
        path.chmod(0o755)
        return str(path)

    def snapshot(self):
        return {str(p.relative_to(self.data)): p.read_bytes() for p in self.data.rglob('*') if p.is_file()}


class AgentTest(Fixture):
    def test_missing_main_instructions_stay_absent(self):
        main = self.data / 'work/CLAUDE.md'
        main.unlink()
        item = self.create()
        self.assertFalse(main.exists())
        self.assertIn('你是子助手', (self.work(item) / 'CLAUDE.md').read_text())
        self.agent('sync')
        self.assertFalse(main.exists())
        self.agent('delete', item['id'])
        self.assertFalse(main.exists())

    def test_failed_create_rolls_back_directories_and_hides_exceptions(self):
        original = self.template.read_bytes()
        partial_failure = '''import pathlib, runpy, sys
def fail(*args, **kwargs): raise RuntimeError('private-secret')
pathlib.Path.symlink_to = fail
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        roster_failure = '''import runpy, sys
module = runpy.run_path(sys.argv[1])
original = module['roster']
def roster(record, records):
    original(record, records)
    if record['id'] != 'main': raise RuntimeError('private-secret')
module['manage'].__globals__['roster'] = roster
sys.argv = sys.argv[1:]
sys.exit(module['main']())
'''
        for failure in ('missing_template', 'missing_memory', 'partial_sync', 'partial_rosters'):
            with self.subTest(failure=failure):
                self.template.write_bytes(original)
                if failure == 'missing_template':
                    self.template.unlink()
                elif failure == 'missing_memory':
                    self.template.write_bytes(original + b'__MEMORY_MIB__')
                    self.env.pop('PARTNER_MEMORY_BYTES', None)
                result = self.command('wp-agent', 'create', payload='{"name":"研究员"}', code=1,
                                      launcher={'partial_sync': partial_failure,
                                                'partial_rosters': roster_failure}.get(failure))
                self.assertEqual(result.stdout, '{"ok":false,"error":"failed"}\n')
                self.assertEqual(result.stderr, '')
                self.assertEqual(list((self.base / 'agents').iterdir()), [])
                self.assertEqual(list((self.data / 'agents').iterdir()), [])
                self.assertEqual(self.agent('list')['agents'], [])
                self.assertEqual((self.data / 'work/CLAUDE.md').read_bytes(), self.original)
        self.assertTrue(list((self.data / '.trash/agents').glob('*/work/CLAUDE.md')))
        self.assertTrue(list((self.data / '.trash/agents').glob('*/bridge/agent.json')))

    def test_all_commands_hide_unexpected_exceptions(self):
        launcher = '''import runpy, sys
module = runpy.run_path(sys.argv[1])
def fail(*args, **kwargs): raise RuntimeError('private-secret')
module['main'].__globals__.update(manage=fail, ask=fail)
sys.argv = sys.argv[1:]
sys.exit(module['main']())
'''
        for args in (('create',), ('rename', 's00000000'), ('delete', 's00000000'),
                     ('list',), ('sync',), ('ask', 'main', '--json'), ('ask', 'main')):
            with self.subTest(args=args):
                result = self.command('wp-agent', *args, launcher=launcher, code=1)
                self.assertEqual(result.stdout, '{"ok":false,"error":"failed"}\n')
                self.assertEqual(result.stderr, '')

    def test_delete_does_not_signal_stale_or_inactive_setup_pids(self):
        process = subprocess.Popen(['sleep', '60'], start_new_session=True)
        try:
            cases = [(False, 'preparing', 60), (False, 'waiting', 60),
                     (True, 'preparing', -1), (True, 'waiting', -1),
                     (True, 'connected', 60), (True, 'failed', 60),
                     (True, 'waiting', None)]
            for held, status, expires in cases:
                with self.subTest(held=held, status=status, expires=expires):
                    item = self.create()
                    directory = self.directory(item)
                    state = {'status': status, 'pid': process.pid, 'childPid': process.pid}
                    if expires is not None:
                        state['expiresAt'] = time.time() + expires
                    (directory / '.feishu-setup.json').write_text(json.dumps(state))
                    with (directory / '.feishu-setup.lock').open('w') as lock:
                        if held:
                            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        self.agent('delete', item['id'], timeout=5)
                    self.assertIsNone(process.poll())
                    os.killpg(process.pid, 0)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)

    def test_empty_sync_and_list_leave_all_files_unchanged(self):
        before = self.snapshot()
        self.assertEqual(self.agent('sync'), {'ok': True})
        self.assertEqual(self.agent('list'), {'ok': True, 'agents': [], 'limit': 5})
        self.assertEqual(json.loads(self.command('wp-feishu-bot.py', 'info').stdout),
                         {'ok': True, 'bots': [], 'agents': [], 'limit': 5})
        self.assertEqual(before, self.snapshot())
        self.assertFalse((self.base / 'agents.lock').exists())

    def test_names_limits_and_metadata(self):
        for value in ['', '主助手', 'MAIN', 'Main', 's0123abcd', 'S0123ABCD', ' sABCDEF12 ',
                      'a  b', 'a/b', 'a.b', 'a\tb', '😀', '中' * 17]:
            self.assertEqual(self.agent('create', name=value, code=1), {'ok': False, 'error': 'invalid_name'})
        values = ['  研究员  ', 'AbC', '中' * 16, 'Agent 二-·_9', '\u3400\uf900']
        created = [self.create(name) for name in values]
        self.assertEqual(created[0]['name'], '研究员')
        self.assertEqual(self.agent('rename', created[0]['id'], name='S1234AbCd', code=1),
                         {'ok': False, 'error': 'invalid_name'})
        self.assertEqual(created[4]['name'], '㐀豈')
        self.assertEqual(self.agent('create', name='㐀豈', code=1)['error'], 'name_taken')
        self.assertEqual(set(created[0]), {'id', 'name', 'kind', 'createdAt', 'setup', 'appId'})
        self.assertEqual((created[0]['kind'], created[0]['setup'], created[0]['appId']), ('sub', 'none', None))
        self.assertRegex(created[0]['id'], '^s[0-9a-f]{8}$')
        self.assertEqual(self.agent('create', name='abc', code=1)['error'], 'name_taken')
        self.assertEqual(self.agent('create', name='第六个', code=1)['error'], 'limit_reached')
        self.assertEqual(len(self.agent('list')['agents']), 5)
        for item in created:
            self.assertEqual(self.directory(item).stat().st_mode & 0o777, 0o700)
            self.assertEqual((self.directory(item) / 'agent.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.work(item).stat().st_mode & 0o777, 0o755)
            self.assertIn('你好 同事', (self.work(item) / 'CLAUDE.md').read_text())
            self.assertFalse(self.work(item).is_relative_to(self.data / 'work'))
        self.assertEqual((self.base / 'agents').stat().st_mode & 0o777, 0o700)
        oversized = self.command('wp-agent', 'create', payload='x' * 4097, code=1)
        self.assertEqual(json.loads(oversized.stdout)['error'], 'invalid_name')

    def test_concurrent_creates_do_not_exceed_limit_or_duplicate_names(self):
        for index in range(4):
            self.create(str(index))
        def race(names):
            processes = [subprocess.Popen([sys.executable, '-I', str(BIN / 'wp-agent'), 'create'],
                                          env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True) for _ in names]
            try:
                for process, name in zip(processes, names):
                    process.stdin.write(json.dumps({'name': name}))
                    process.stdin.close()
                    process.stdin = None
                return [json.loads(process.communicate(timeout=9)[0]) for process in processes]
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=3)
        results = race(['Alpha', 'Beta'])
        self.assertEqual(sum(item['ok'] for item in results), 1)
        self.assertEqual(next(item['error'] for item in results if not item['ok']), 'limit_reached')
        for item in self.agent('list')['agents']:
            self.agent('delete', item['id'])
        results = race(['Dup', 'dup'])
        self.assertEqual(sum(item['ok'] for item in results), 1)
        self.assertEqual(next(item['error'] for item in results if not item['ok']), 'name_taken')

    def test_rename_delete_rosters_and_exact_restore(self):
        for original in (self.original, b'with newline\n', b'', b'\n\n'):
            with self.subTest(original=original):
                (self.data / 'work/CLAUDE.md').write_bytes(original)
                first, second = self.create('研究员'), self.create('编辑')
                directory, work = self.directory(first), self.work(first)
                (work / 'personal').write_text('记忆')
                (directory / 'config.toml').write_text('data_dir="private"')
                (directory / 'config.toml').chmod(0o600)
                listing = self.agent('rename', first['id'], name='策划')['agent']
                self.assertEqual(listing['id'], first['id'])
                self.assertTrue(work.exists())
                self.assertTrue(directory.exists())
                self.assertEqual(self.agent('rename', first['id'], name='编辑', code=1)['error'], 'name_taken')
                for target in (work, self.work(second), self.data / 'work'):
                    text = (target / 'CLAUDE.md').read_text()
                    self.assertIn('策划', text)
                    self.assertNotIn('研究员', text)
                    self.assertIn('预计超过 2 分钟', text)
                    self.assertIn('被别的助手调用时不要再调用其他助手', text)
                self.agent('delete', first['id'])
                trash = next((self.data / '.trash/agents').glob(first['id'] + '-*'))
                self.assertRegex(trash.name, first['id'] + r'-\d{8}T\d{6}Z')
                self.assertEqual((trash / 'work/personal').read_text(), '记忆')
                self.assertTrue((trash / 'bridge/config.toml').exists())
                self.assertFalse(work.exists())
                self.assertFalse(directory.exists())
                self.assertNotIn('策划', (self.work(second) / 'CLAUDE.md').read_text())
                self.agent('delete', second['id'])
                self.assertEqual((self.data / 'work/CLAUDE.md').read_bytes(), original)
        for action in ('rename', 'delete'):
            self.assertEqual(self.agent(action, 'main', name='无效' if action == 'rename' else None, code=1)['error'], 'main_agent')
            self.assertEqual(self.agent(action, 's00000000', name='无效' if action == 'rename' else None, code=1)['error'], 'not_found')

    def test_sync_company_and_invalid_rosters(self):
        item = self.create()
        path = self.work(item) / 'CLAUDE.md'
        original = path.read_bytes()
        path.write_bytes('个人前缀\r\n'.encode() + original + '\n个人尾巴'.encode())
        self.template.write_text(self.template.read_text().replace('公司规则', '新版规则'))
        self.agent('sync')
        self.assertTrue(path.read_bytes().startswith('个人前缀\r\n'.encode()))
        self.assertTrue(path.read_bytes().endswith('\n个人尾巴'.encode()))
        self.assertIn('新版规则', path.read_text())
        path.write_bytes(path.read_bytes() + b'<!-- workpartner:agents:begin -->')
        damaged = path.read_bytes()
        self.template.write_text(self.template.read_text().replace('新版规则', '再版规则'))
        self.agent('sync')
        self.assertEqual(path.read_bytes(), damaged)
        for invalid in (b'<!-- workpartner:agents:begin -->',
                        b'<!-- workpartner:agents:end --><!-- workpartner:agents:begin -->',
                        b'<!-- workpartner:agents:begin --><!-- workpartner:agents:end --><!-- workpartner:agents:end -->'):
            main = self.data / 'work/CLAUDE.md'
            main.write_bytes(invalid)
            result = self.command('wp-agent', 'sync')
            self.assertIn('标记残缺或重复', result.stderr)
            self.assertEqual(main.read_bytes(), invalid)


class AskTest(Fixture):
    def setUp(self):
        super().setUp()
        self.item = self.create('研究员')
        self.env['WP_CLAUDE_BIN'] = self.fake('claude',
            'import json, os, sys\nprint(json.dumps({"result": json.dumps({"cwd":os.getcwd(), "depth":os.getenv("WP_AGENT_DEPTH"), "args":sys.argv[1:], "message":sys.stdin.read()}, ensure_ascii=False)}))\n')

    def test_target_cwd_environment_arguments_and_stdin(self):
        result = self.agent('ask', '研究员', '--json', cwd=self.data / 'work')
        observed = json.loads(result['reply'])
        self.assertEqual(observed['cwd'], str(self.work(self.item)))
        self.assertEqual(observed['depth'], '1')
        self.assertEqual(observed['args'][:5], ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions'])
        self.assertEqual(observed['args'][5], '--append-system-prompt')
        self.assertIn('你是「研究员」，正在被「主助手」调用', observed['args'][6])
        result = self.command('wp-agent', 'ask', self.item['id'], '--json', payload='请处理', cwd=self.data / 'work')
        self.assertEqual(json.loads(json.loads(result.stdout)['reply'])['message'], '请处理')
        for alias in ('main', '主助手'):
            result = self.agent('ask', alias, '--json', cwd=self.work(self.item))
            self.assertEqual(json.loads(result['reply'])['cwd'], str(self.data / 'work'))
        other = self.create('EDITOR')
        result = self.agent('ask', 'editor', '--json', cwd=self.work(self.item))
        self.assertEqual(json.loads(result['reply'])['cwd'], str(self.work(other)))
        result = self.command('wp-agent', 'ask', self.item['id'], '--json', '参数消息', cwd=self.data / 'work')
        self.assertEqual(json.loads(json.loads(result.stdout)['reply'])['message'], '参数消息')
        result = self.command('wp-agent', 'ask', self.item['id'], '消息', cwd=self.data / 'work')
        self.assertEqual(json.loads(result.stdout)['message'], '消息')

    def test_exact_id_wins_over_legacy_conflicting_name(self):
        target = self.create('编辑')
        path = self.directory(self.item) / 'agent.json'
        record = json.loads(path.read_text())
        record['name'] = target['id']
        path.write_text(json.dumps(record))
        result = self.agent('ask', target['id'], '--json', cwd=self.data / 'work')
        self.assertEqual(result['agent'], '编辑')
        self.assertEqual(json.loads(result['reply'])['cwd'], str(self.work(target)))

    def test_timeout_remains_timeout_if_process_group_already_exited(self):
        launcher = '''import runpy, subprocess, sys
original = subprocess.Popen.communicate
def communicate(process, *args, **kwargs):
    result = original(process, *args, **kwargs)
    if not getattr(process, 'timeout_injected', False):
        process.timeout_injected = True
        raise subprocess.TimeoutExpired(process.args, 10)
    return result
subprocess.Popen.communicate = communicate
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        self.assertEqual(self.agent('ask', self.item['id'], '--json', '--timeout', '10',
                                    code=1, launcher=launcher), {'ok': False, 'error': 'timeout'})

    def test_errors_and_realpath_caller(self):
        self.assertEqual(self.agent('ask', '不存在', '--json', code=1)['error'], 'not_found')
        self.assertEqual(self.agent('ask', 'main', '--json', code=1)['error'], 'self_call')
        nested = self.work(self.item) / 'project'
        nested.mkdir()
        alias = self.data / 'alias'
        alias.symlink_to(nested)
        self.assertEqual(self.agent('ask', self.item['id'], '--json', code=1, cwd=alias)['error'], 'self_call')
        self.env['WP_AGENT_DEPTH'] = '1'
        self.assertEqual(self.agent('ask', self.item['id'], '--json', code=1)['error'], 'depth_exceeded')
        del self.env['WP_AGENT_DEPTH']
        self.env['WP_CLAUDE_BIN'] = self.fake('failure', 'import sys\nprint("private-secret", file=sys.stderr)\nprint("private-secret")\nsys.exit(1)\n')
        self.assertEqual(self.agent('ask', self.item['id'], '--json', code=1)['error'], 'failed')
        result = self.command('wp-agent', 'ask', self.item['id'], code=1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr.strip(), '助手调用失败')
        self.assertEqual(self.agent('ask', self.item['id'], '--json', '--timeout', '9', code=1)['error'], 'failed')
        result = self.command('wp-agent', 'ask', self.item['id'], '--json', payload='x'*65537, code=1)
        self.assertEqual(json.loads(result.stdout)['error'], 'failed')

    def test_slots_busy_and_timeout_kills_group(self):
        run = self.base / 'run'
        run.mkdir()
        locks = [(run / f'ask-slot-{index}.lock').open('w') for index in range(2)]
        try:
            fcntl.flock(locks[0], fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(self.agent('ask', self.item['id'], '--json')['ok'])
            for stream in locks:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.agent('ask', self.item['id'], '--json', code=1)['error'], 'busy')
        finally:
            for stream in locks:
                stream.close()
        self.env['WP_CLAUDE_BIN'] = self.fake('sleeper',
            'import os, time, subprocess, sys\nfrom pathlib import Path\n'
            'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"])\n'
            'Path(os.environ["WP_DATA_DIR"],"sleep-pids").write_text(str(os.getpid())+" "+str(child.pid))\n'
            'time.sleep(60)\n')
        started = time.monotonic()
        self.assertEqual(self.agent('ask', self.item['id'], '--json', '--timeout', '10', code=1, timeout=16)['error'], 'timeout')
        self.assertLess(time.monotonic() - started, 15)
        for pid in (self.data / 'sleep-pids').read_text().split():
            path = Path('/proc') / pid / 'stat'
            self.assertTrue(not path.exists() or path.read_text().rsplit(')', 1)[1].split()[0] == 'Z')
        self.env['WP_CLAUDE_BIN'] = self.fake('success', 'print(\'{"result":"完成"}\')\n')
        self.assertEqual(self.agent('ask', self.item['id'], '--json')['reply'], '完成')


class OnboardTest(Fixture):
    def setUp(self):
        super().setUp()
        self.item = self.create()
        self.env['WP_CC_CONNECT_BIN'] = self.fake('cc-connect',
            'import sys, os\nfrom pathlib import Path\n'
            'p=Path(sys.argv[sys.argv.index("--config")+1])\n'
            'p.write_text(p.read_text().replace("__APP_ID__","cli_sub").replace("__APP_SECRET__","private-secret").replace(\'allow_from = ""\',\'allow_from = "ou_user"\'))\n'
            'Path(os.environ["WP_DATA_DIR"], "onboard-cwd").write_text(os.getcwd())\n')

    def test_publish_independent_config_and_notify(self):
        main = self.base / 'config.toml'
        main.write_text('main unchanged')
        run = self.base / 'run'
        run.mkdir()
        os.mkfifo(run / 'restart.fifo', 0o600)
        fd = os.open(run / 'restart.fifo', os.O_RDWR | os.O_NONBLOCK)
        try:
            self.command('feishu-onboard.py', 'start', '--agent', self.item['id'])
            self.assertEqual(os.read(fd, 1024), b'rescan\n')
        finally:
            os.close(fd)
        path = self.directory(self.item) / 'config.toml'
        config = tomllib.loads(path.read_text())
        self.assertEqual(config['data_dir'], str(self.directory(self.item) / 'data'))
        self.assertEqual(config['projects'][0]['name'], 'agent-' + self.item['id'])
        self.assertEqual(config['projects'][0]['agent']['options']['work_dir'], str(self.work(self.item)))
        self.assertEqual(config['projects'][0]['agent']['options']['model'], 'test-model')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(main.read_text(), 'main unchanged')
        self.assertEqual((self.data / 'onboard-cwd').read_text(), str(self.work(self.item)))
        self.assertEqual(json.loads((self.directory(self.item) / '.feishu-setup.json').read_text()), {'status': 'connected'})
        self.assertEqual(json.loads(self.command('feishu-onboard.py', 'status', '--agent', self.item['id']).stdout), {'status': 'connected'})
        before = path.read_bytes()
        self.command('feishu-onboard.py', 'start', '--agent', self.item['id'])
        self.assertEqual(path.read_bytes(), before)
        self.command('feishu-onboard.py', 'start', '--agent', 's00000000', code=1)
        self.assertFalse((self.base / 'agents/s00000000').exists())

    def test_missing_agent_status_is_failed(self):
        for agent_id in ('s00000000', '../main'):
            result = self.command('feishu-onboard.py', 'status', '--agent', agent_id)
            self.assertEqual(result.stdout.strip(), '{"status": "failed"}')
        self.assertFalse((self.base / 'agents/s00000000').exists())

    def test_connected_state_without_config_is_unconnected(self):
        for directory, args in ((self.base, ()), (self.directory(self.item), ('--agent', self.item['id']))):
            (directory / '.feishu-setup.json').write_text('{"status":"connected"}')
            self.assertEqual(json.loads(self.command('feishu-onboard.py', 'status', *args).stdout),
                             {'status': 'unconnected'})
        self.assertEqual(self.agent('list')['agents'][0]['setup'], 'none')
        self.assertEqual(json.loads(self.command('wp-feishu-bot.py', 'info').stdout)['agents'],
                         self.agent('list')['agents'])

    def test_optimized_onboard_rejects_each_isolation_violation(self):
        for field in ('data_dir', 'project_count', 'name', 'work_dir'):
            with self.subTest(field=field):
                self.env['BROKEN_FIELD'] = field
                self.env['WP_CC_CONNECT_BIN'] = self.fake('bad-config',
                    'import os, re, sys\nfrom pathlib import Path\n'
                    'p=Path(sys.argv[sys.argv.index("--config")+1])\n'
                    'text=p.read_text().replace("__APP_ID__","cli_sub").replace("__APP_SECRET__","private-secret").replace(\'allow_from = ""\',\'allow_from = "ou_user"\')\n'
                    'field=os.environ["BROKEN_FIELD"]\n'
                    'if field == "project_count": text += \'\\n[[projects]]\\nname="extra"\\n\'\n'
                    'else: text=re.sub(r"(?m)^"+field+r"\\s*=.*$",field+\' = "wrong"\',text)\n'
                    'p.write_text(text)\n')
                self.command('feishu-onboard.py', 'start', '--agent', self.item['id'], optimize=True)
                self.assertFalse((self.directory(self.item) / 'config.toml').exists())
                self.assertFalse((self.directory(self.item) / 'pending-feishu.toml').exists())
                self.assertEqual(json.loads(self.command('feishu-onboard.py', 'status', '--agent', self.item['id']).stdout),
                                 {'status': 'failed'})

    def test_pending_identity_failed_and_status(self):
        directory = self.directory(self.item)
        self.assertEqual(json.loads(self.command('feishu-onboard.py', 'status', '--agent', self.item['id']).stdout), {'status': 'unconnected'})
        self.env['WP_CC_CONNECT_BIN'] = self.fake('identity',
            'import sys\nfrom pathlib import Path\np=Path(sys.argv[sys.argv.index("--config")+1])\n'
            'p.write_text(p.read_text().replace("__APP_ID__","cli_sub").replace("__APP_SECRET__","private-secret"))\n')
        self.command('feishu-onboard.py', 'start', '--agent', self.item['id'])
        self.assertEqual(json.loads(self.command('feishu-onboard.py', 'status', '--agent', self.item['id']).stdout), {'status': 'needs_identity'})
        pending = directory / 'pending-feishu.toml'
        self.assertEqual(pending.stat().st_mode & 0o777, 0o600)
        before = pending.read_bytes()
        self.command('feishu-onboard.py', 'start', '--agent', self.item['id'])
        self.assertEqual(pending.read_bytes(), before)
        pending.unlink()
        self.env['WP_CC_CONNECT_BIN'] = self.fake('failure', 'print("private-secret")\nraise SystemExit(1)\n')
        self.command('feishu-onboard.py', 'start', '--agent', self.item['id'])
        self.assertEqual(json.loads(self.command('feishu-onboard.py', 'status', '--agent', self.item['id']).stdout), {'status': 'failed'})
        qr = directory / '.feishu-qr'
        qr.mkdir()
        (qr / 'qr.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
        state = directory / '.feishu-setup.json'
        state.write_text(json.dumps({'status':'preparing','expiresAt':time.time()+60,'directory':str(qr)}))
        result = json.loads(self.command('feishu-onboard.py', 'status', '--agent', self.item['id']).stdout)
        self.assertEqual(result['status'], 'waiting')
        self.assertTrue(result['qr'].startswith('data:image/png;base64,'))
        state.write_text(json.dumps({'status':'waiting','expiresAt':time.time()-1,'directory':str(qr)}))
        self.assertEqual(json.loads(self.command('feishu-onboard.py', 'status', '--agent', self.item['id']).stdout), {'status': 'expired'})

    def test_setup_worker_expires_and_removes_qr(self):
        self.env['WP_CC_CONNECT_BIN'] = self.fake('expiry',
            'import sys, time\nfrom pathlib import Path\n'
            'Path(sys.argv[sys.argv.index("--qr-image")+1]).write_bytes(b"qr")\ntime.sleep(60)\n')
        launcher = """import runpy, sys
module = runpy.run_path(sys.argv[1])
module['run'].__kwdefaults__['lifetime'] = 0.3
sys.argv = [sys.argv[1], 'start', '--agent', sys.argv[2]]
sys.exit(module['main']())
"""
        result = subprocess.run([sys.executable, '-I', '-c', launcher, str(BIN / 'feishu-onboard.py'), self.item['id']],
                                env=self.env, capture_output=True, text=True, timeout=6)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.command('feishu-onboard.py', 'status', '--agent', self.item['id']).stdout),
                         {'status': 'expired'})
        self.assertFalse(list(self.directory(self.item).rglob('qr.png')))
        self.assertFalse((self.directory(self.item) / 'config.toml').exists())

    def test_delete_stops_in_progress_setup(self):
        self.env['WP_CC_CONNECT_BIN'] = self.fake('waiting', 'import time\ntime.sleep(60)\n')
        process = subprocess.Popen([sys.executable, '-I', str(BIN / 'feishu-onboard.py'), 'start', '--agent', self.item['id']],
                                   env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            state = {}
            while time.monotonic() < deadline:
                try:
                    state = json.loads((self.directory(self.item) / '.feishu-setup.json').read_text())
                except (OSError, ValueError):
                    pass
                if state.get('childPid'):
                    break
                time.sleep(0.02)
            self.assertIn('childPid', state)
            self.agent('delete', self.item['id'])
            process.communicate(timeout=5)
            for pid in (state['pid'], state['childPid']):
                path = Path(f'/proc/{pid}/stat')
                self.assertTrue(not path.exists() or path.read_text().rsplit(')',1)[1].split()[0] == 'Z')
            self.assertFalse(self.directory(self.item).exists())
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=3)


if __name__ == '__main__':
    unittest.main()

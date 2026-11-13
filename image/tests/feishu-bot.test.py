"""通过命令行和本地 HTTP 服务验证机器人信息契约。"""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'bin/wp-feishu-bot.py'
SECRET = 'fixture-secret-never-output'
TOKEN = 'fixture-token-never-output'
PNG = b'\x89PNG\r\n\x1a\nfixture'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, value, status=200):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        self.server.calls.append(self.path)
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.server.delay:
            time.sleep(self.server.delay)
        if (self.path != '/open-apis/auth/v3/tenant_access_token/internal' or
                body.get('app_id') not in ('cli_0', 'cli_1', 'cli_2', 'cli_3') or
                body.get('app_secret') != SECRET or self.server.mode == 'auth'):
            self.reply({'code': 10003, 'msg': SECRET + TOKEN})
        else:
            self.reply({'code': 0, 'tenant_access_token': TOKEN})

    def do_GET(self):
        self.server.calls.append(self.path)
        if self.path == '/avatar':
            if self.server.mode == 'avatar-bad-http':
                self.wfile.write((SECRET + TOKEN + '\r\n').encode())
                self.close_connection = True
                return
            self.send_response(200)
            self.send_header('Content-Type', self.server.mime)
            self.end_headers()
            self.wfile.write(self.server.avatar)
        elif self.server.mode == 'bad-http':
            self.wfile.write((SECRET + TOKEN + '\r\n').encode())
            self.close_connection = True
        elif self.server.mode == 'bot-auth':
            self.reply({'code': 99991663, 'msg': SECRET + TOKEN}, 401)
        elif self.server.mode == 'server-error':
            self.reply({'msg': SECRET + TOKEN}, 503)
        elif self.headers.get('Authorization') != 'Bearer ' + TOKEN:
            self.reply({'code': 99991663}, 401)
        else:
            self.reply({'code': 0, 'bot': {'app_name': '测试机器人',
                        'avatar_url': self.server.base + '/avatar',
                        'activate_status': self.server.activate}})


class CommandFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.run = self.base / 'run'
        self.run.mkdir()
        self.env = dict(os.environ, WP_CC_CONNECT_DIR=str(self.base), NO_PROXY='*', no_proxy='*')

    def config(self, count=1):
        (self.base / 'config.toml').write_text(''.join(
            f'[[projects]]\nname="project-{i}"\n[[projects.platforms]]\ntype="feishu"\n'
            f'[projects.platforms.options]\napp_id="cli_{i}"\napp_secret="{SECRET}"\n'
            for i in range(count)))

    def call(self, *args, code=0, launcher=None):
        command = ([sys.executable, '-c', launcher, str(SCRIPT)] if launcher else
                   [sys.executable, str(SCRIPT)])
        result = subprocess.run([*command, *args], env=self.env,
                                capture_output=True, text=True, timeout=9)
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1, result.stdout)
        for secret in (SECRET, TOKEN, 'app_secret', 'tenant_access_token'):
            self.assertNotIn(secret, result.stdout + result.stderr)
        return json.loads(result.stdout)


class CommandTest(CommandFixture):
    def test_empty_and_unreadable_config(self):
        self.assertEqual(self.call('info'), {'ok': True, 'bots': []})
        (self.base / 'config.toml').write_text('[[broken')
        self.assertEqual(self.call('info', code=1), {'ok': False, 'error': 'config_unreadable'})
        (self.base / 'config.toml').unlink()
        (self.base / 'config.toml').mkdir()
        self.assertEqual(self.call('info', code=1), {'ok': False, 'error': 'config_unreadable'})

    def test_online_branches_and_untrusted_state(self):
        self.config()
        (self.run / 'bot-cache.json').write_text(json.dumps({'cli_0': {
            'name': 'cached bot', 'avatar': None, 'activate': True, 'at': time.time()}}))
        pid = self.run / 'bridge.pid'
        state = self.run / 'bridge-state.json'
        at = '2026-11-13T00:00:00+00:00'
        for event, want in [(None, 'unknown'), ('connected', 'online'), ('disconnected', 'offline'),
                            ('reconnecting', 'offline'), ('exhausted', 'offline')]:
            pid.write_text(str(os.getpid()))
            state.write_text(json.dumps({'event': event, 'at': at if event else None}))
            bot = self.call('info')['bots'][0]
            self.assertEqual((bot['online'], bot['lastEvent'], bot['lastEventAt']),
                             (want, event, at if event else None))
        pid.write_text('2147483647')
        self.assertEqual(self.call('info')['bots'][0]['online'], 'offline')
        pid.write_text('-1')
        state.write_text(json.dumps({'event': SECRET, 'at': TOKEN}))
        bot = self.call('info')['bots'][0]
        self.assertEqual((bot['online'], bot['lastEvent'], bot['lastEventAt']), ('offline', None, None))
        pid.write_text(str(os.getpid()))
        state.write_text('not json ' + SECRET)
        self.assertEqual(self.call('info')['bots'][0]['online'], 'unknown')

    def test_restart_without_supervisor(self):
        self.assertEqual(self.call('restart', code=1), {'ok': False, 'error': 'no_supervisor'})

    def test_blocked_dns_obeys_total_deadline(self):
        self.config(4)
        self.env['WP_FEISHU_API_BASE'] = 'http://dns.test'
        launcher = '''import os, runpy, socket, sys, time
from pathlib import Path
def blocked_dns(*args, **kwargs):
    with Path(os.environ['WP_CC_CONNECT_DIR'], 'dns-calls').open('a') as stream:
        stream.write('resolve\\n')
    time.sleep(60)
socket.getaddrinfo = blocked_dns
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        started = time.monotonic()
        bots = self.call('info', launcher=launcher)['bots']
        self.assertLess(time.monotonic() - started, 8)
        self.assertEqual(len(bots), 4)
        self.assertTrue(all(bot['error'] == 'feishu_unreachable' for bot in bots))
        self.assertEqual((self.base / 'dns-calls').read_text().splitlines(), ['resolve'] * 3)


class ApiTest(CommandFixture):
    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.base = f'http://127.0.0.1:{self.server.server_port}'
        self.server.calls = []
        self.server.mode = 'ok'
        self.server.avatar = PNG
        self.server.mime = 'image/png'
        self.server.activate = 2
        self.server.delay = 0
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.env['WP_FEISHU_API_BASE'] = self.server.base

    def test_fields_cache_refresh_and_expiration(self):
        self.config()
        expected = {'project': 'project-0', 'appId': 'cli_0', 'name': '测试机器人',
                    'avatar': 'data:image/png;base64,' + base64.b64encode(PNG).decode(),
                    'activate': True, 'online': 'offline', 'lastEvent': None,
                    'lastEventAt': None, 'error': None}
        self.assertEqual(self.call('info'), {'ok': True, 'bots': [expected]})
        self.assertEqual(self.server.calls, ['/open-apis/auth/v3/tenant_access_token/internal',
                                          '/open-apis/bot/v3/info', '/avatar'])
        self.assertEqual(self.call('info')['bots'][0], expected)
        self.assertEqual(len(self.server.calls), 3)
        cache = self.run / 'bot-cache.json'
        self.assertEqual(cache.stat().st_mode & 0o777, 0o600)
        content = json.loads(cache.read_text())
        self.assertEqual(set(content['cli_0']), {'name', 'avatar', 'activate', 'at'})
        self.assertNotIn(SECRET, cache.read_text())
        self.assertNotIn(TOKEN, cache.read_text())
        self.server.activate = 1
        self.assertFalse(self.call('info', '--refresh')['bots'][0]['activate'])
        self.assertEqual(len(self.server.calls), 6)
        content['cli_0']['at'] = time.time() - 601
        cache.write_text(json.dumps(content))
        self.call('info')
        self.assertEqual(len(self.server.calls), 9)

    def test_dns_thread_resolves_real_http_requests(self):
        self.config()
        launcher = '''import runpy, socket, sys, threading, time
original = socket.getaddrinfo
def resolve(*args, **kwargs):
    assert threading.current_thread().daemon
    time.sleep(0.05)
    return original(*args, **kwargs)
socket.getaddrinfo = resolve
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        bot = self.call('info', launcher=launcher)['bots'][0]
        self.assertEqual((bot['name'], bot['error']), ('测试机器人', None))
        self.assertEqual(len(self.server.calls), 3)

    def test_multiple_projects_and_non_feishu(self):
        self.config(2)
        with (self.base / 'config.toml').open('a') as stream:
            stream.write('[[projects]]\nname="other"\n[[projects.platforms]]\ntype="slack"\n')
        bots = self.call('info')['bots']
        self.assertEqual([(b['project'], b['appId']) for b in bots],
                         [('project-0', 'cli_0'), ('project-1', 'cli_1')])
        self.assertTrue(all(b['name'] == '测试机器人' for b in bots))

    def test_api_errors_do_not_escape_or_get_cached(self):
        self.config()
        for mode, error in [('auth', 'feishu_auth_failed'), ('bot-auth', 'feishu_auth_failed'),
                            ('server-error', 'feishu_unreachable'), ('bad-http', 'feishu_unreachable')]:
            with self.subTest(mode=mode):
                self.server.mode = mode
                bot = self.call('info')['bots'][0]
                self.assertEqual(bot['error'], error)
                self.assertIsNone(bot['name'])
        self.server.mode = 'ok'
        self.assertIsNone(self.call('info')['bots'][0]['error'])
        self.server.shutdown()
        self.server.server_close()
        self.assertEqual(self.call('info', '--refresh')['bots'][0]['error'], 'feishu_unreachable')

    def test_corrupt_cache_is_replaced_without_leaking(self):
        self.config()
        cache = self.run / 'bot-cache.json'
        cache.write_text('broken ' + SECRET)
        self.assertEqual(self.call('info')['bots'][0]['name'], '测试机器人')
        self.assertEqual(len(self.server.calls), 3)
        self.assertNotIn(SECRET, cache.read_text())

    def test_avatar_size_and_type(self):
        self.config()
        for avatar, mime, present in [(b'x' * 65536, 'image/png', True),
                                     (b'x' * 65537, 'image/png', False),
                                     (b'<html>', 'text/html', False)]:
            self.server.avatar, self.server.mime = avatar, mime
            bot = self.call('info', '--refresh')['bots'][0]
            self.assertEqual(bot['avatar'] is not None, present)

    def test_avatar_protocol_error_preserves_bot_metadata(self):
        self.config()
        self.server.mode = 'avatar-bad-http'
        bot = self.call('info')['bots'][0]
        self.assertEqual((bot['name'], bot['activate'], bot['avatar'], bot['error']),
                         ('测试机器人', True, None, None))

    def test_total_deadline_for_multiple_slow_projects(self):
        self.config(4)
        self.server.delay = 3.5
        started = time.monotonic()
        bots = self.call('info')['bots']
        self.assertLess(time.monotonic() - started, 8)
        self.assertEqual(len(bots), 4)
        self.assertTrue(all(b['error'] == 'feishu_unreachable' for b in bots))


if __name__ == '__main__':
    unittest.main()

"""Read the bridge model from its configuration and switch it through the local bridge socket."""
import http.server
import json
import os
from pathlib import Path
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'bin' / 'wp-bridge-model.py'
CONFIG = '''data_dir = "{data}"
[[projects]]
name = "person"
[projects.agent.options]
model = "default-model"
provider = "{active}"
[[projects.agent.providers]]
name = "workpartner"
model = "chosen-model"
models = [{{ model = "chosen-model", alias = "Chosen" }}]
[[projects.platforms]]
type = "feishu"
[projects.platforms.options]
app_secret = "fixture-private-value"
'''


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def run(base, *args):
    result = subprocess.run([sys.executable, '-I', str(SCRIPT), *args], capture_output=True, text=True,
                            env={**os.environ, 'WP_CC_CONNECT_DIR': str(base)}, timeout=20)
    return result.returncode, json.loads(result.stdout)


class BridgeModelTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        (self.base / 'data' / 'run').mkdir(parents=True)

    def write(self, active):
        (self.base / 'config.toml').write_text(CONFIG.format(data=self.base / 'data', active=active))

    def test_get_reads_the_active_provider_choice_or_the_agent_option(self):
        self.write('workpartner')
        self.assertEqual(run(self.base, 'get'), (0, {'ok': True, 'model': 'chosen-model'}))
        self.write('')
        self.assertEqual(run(self.base, 'get'), (0, {'ok': True, 'model': 'default-model'}))

    def test_set_posts_the_project_and_model_to_the_bridge(self):
        self.write('workpartner')
        received, status = [], [200]

        class Handler(http.server.BaseHTTPRequestHandler):
            def address_string(self):
                return 'bridge'

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers['content-length']))
                received.append((self.path, json.loads(body)))
                self.send_response(status[0])
                self.send_header('content-length', '2')
                self.end_headers()
                self.wfile.write(b'{}')

        server = Server(str(self.base / 'data' / 'run' / 'api.sock'), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.assertEqual(run(self.base, 'set', 'other/model'), (0, {'ok': True}))
        self.assertEqual(received, [('/model', {'project': 'person', 'model': 'other/model'})])
        # An older bridge without the endpoint is reported as a failure.
        status[0] = 404
        self.assertEqual(run(self.base, 'set', 'other/model'), (1, {'ok': False}))

    def test_missing_bridge_reports_only_the_error_type(self):
        self.write('workpartner')
        code, result = run(self.base, 'set', 'other/model')
        self.assertEqual((code, result['ok']), (1, False))
        self.assertNotIn('fixture-private-value', json.dumps(result))
        self.assertEqual(run(self.base, 'nope')[0], 2)


if __name__ == '__main__':
    unittest.main()

"""Keys without the organization's Claude models start Claude Code and the bridge on the fallback models."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'bin/wp-model-access.py'
spec = importlib.util.spec_from_file_location('wp_bridge_defaults', ROOT / 'bin/wp-bridge-defaults.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

CONFIG = {'defaults': {'claudePrefix': 'claude/'},
          'fallbackDefaults': {'claude': 'codex/gpt-large', 'haiku': 'codex/gpt-small'},
          'catalog': {'claude': [{'id': 'opus', 'key': 'claude/opus', 'name': 'Opus', 'also': []},
                                 {'id': 'haiku', 'key': 'claude/haiku', 'name': 'Haiku', 'also': []}]}}
MODELS = {'ANTHROPIC_MODEL': 'claude/opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL': 'claude/opus',
          'ANTHROPIC_DEFAULT_SONNET_MODEL': 'claude/sonnet', 'ANTHROPIC_DEFAULT_HAIKU_MODEL': 'claude/haiku',
          'CLAUDE_CODE_SUBAGENT_MODEL': 'claude/haiku', 'PARTNER_BRIDGE_MODEL': 'claude/opus'}


class Endpoint(http.server.BaseHTTPRequestHandler):
    models = []

    def do_GET(self):
        body = json.dumps({'data': [{'id': model} for model in Endpoint.models]}).encode()
        self.send_response(200 if self.path == '/v1/models' and self.headers['x-api-key'] == 'fixture-key' else 404)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class ModelAccessTest(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.directory = tempfile.TemporaryDirectory()
        self.marker = Path(self.directory.name) / '.wp-model-fallback.json'
        self.env = dict(MODELS, PATH=os.environ['PATH'], WORKPARTNER_MODEL_CONFIG=json.dumps(CONFIG),
                        WP_MODEL_FALLBACK_FILE=str(self.marker), ANTHROPIC_API_KEY='fixture-key',
                        ANTHROPIC_BASE_URL=f'http://127.0.0.1:{self.server.server_port}')

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def startup(self, env=None):
        """Run the startup step the way start.sh does and return the resulting model variables."""
        command = f'eval "$({sys.executable} -I {SCRIPT})" && env'
        result = subprocess.run(['bash', '-c', command], env=env or self.env, capture_output=True, text=True, check=True)
        values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        return {name: values.get(name) for name in MODELS}

    def test_key_without_claude_models_uses_fallback_for_every_claude_code_model(self):
        Endpoint.models = ['mp-cx/codex/gpt-large', 'codex/gpt-small', 'gemini/flash']
        self.assertEqual(self.startup(), {
            'ANTHROPIC_MODEL': 'codex/gpt-large', 'ANTHROPIC_DEFAULT_OPUS_MODEL': 'codex/gpt-large',
            'ANTHROPIC_DEFAULT_SONNET_MODEL': 'codex/gpt-large', 'ANTHROPIC_DEFAULT_HAIKU_MODEL': 'codex/gpt-small',
            'CLAUDE_CODE_SUBAGENT_MODEL': 'codex/gpt-small', 'PARTNER_BRIDGE_MODEL': 'codex/gpt-large'})
        self.assertTrue(self.marker.exists())
        # A deployment override that is not a Claude model stays.
        self.assertEqual(self.startup(dict(self.env, CLAUDE_CODE_SUBAGENT_MODEL='other/small'))['CLAUDE_CODE_SUBAGENT_MODEL'],
                         'other/small')

    def test_key_with_claude_models_is_unchanged_and_clears_an_earlier_fallback(self):
        Endpoint.models = ['codex/gpt-small']
        self.startup()
        Endpoint.models = ['mp-q/claude/claude-opus', 'codex/gpt-small']
        self.assertEqual(self.startup(), MODELS)
        self.assertFalse(self.marker.exists())

    def test_unreachable_endpoint_keeps_the_last_result(self):
        Endpoint.models = ['codex/gpt-small']
        self.startup()
        offline = dict(self.env, ANTHROPIC_BASE_URL='http://127.0.0.1:9')
        self.assertEqual(self.startup(offline)['PARTNER_BRIDGE_MODEL'], 'codex/gpt-large')
        self.marker.unlink()
        self.assertEqual(self.startup(offline), MODELS)

    def test_without_fallback_configuration_nothing_changes(self):
        Endpoint.models = ['codex/gpt-small']
        self.marker.write_text(json.dumps({'prefix': 'claude/', 'claude': 'x', 'haiku': 'y'}))
        config = dict(CONFIG)
        del config['fallbackDefaults']
        self.assertEqual(self.startup(dict(self.env, WORKPARTNER_MODEL_CONFIG=json.dumps(config))), MODELS)
        self.assertFalse(self.marker.exists())

    def test_bridge_started_later_uses_and_lists_only_the_fallback(self):
        """Onboarding runs through exec without startup exports; the recorded result still applies."""
        Endpoint.models = ['codex/gpt-small']
        self.startup()
        template = (ROOT / 'home/cc-connect-feishu.toml').read_text()
        exec_env = {'WORKPARTNER_MODEL_CONFIG': json.dumps(dict(CONFIG, defaults=dict(CONFIG['defaults'], claude='claude/opus',
                                                                                     effort='medium'))),
                    'WP_MODEL_FALLBACK_FILE': str(self.marker)}
        target = Path(self.directory.name) / 'config.toml'
        target.write_text(template.replace('__CLAUDE_MODEL__', 'claude/opus').replace('__EFFORT__', 'medium')
                          .replace('__APP_SECRET__', 'fixture').replace('__PROJECT__', 'p').replace('__ALLOW_FROM__', ''))
        with patch.dict(os.environ, exec_env, clear=True):
            self.assertTrue(bridge.refresh(target))
        agent = tomllib.loads(target.read_text())['projects'][0]['agent']
        self.assertEqual(agent['options']['model'], 'codex/gpt-large')
        self.assertEqual(agent['providers'], [{'name': 'workpartner', 'model': 'codex/gpt-large',
                                               'models': [{'model': 'codex/gpt-large', 'alias': 'gpt-large'}]}])
        # Once the key gains Claude models the bridge returns to the organization default and catalog.
        Endpoint.models = ['claude/opus']
        self.startup()
        with patch.dict(os.environ, exec_env, clear=True):
            self.assertTrue(bridge.refresh(target))
        agent = tomllib.loads(target.read_text())['projects'][0]['agent']
        self.assertEqual(agent['options']['model'], 'claude/opus')
        self.assertEqual([entry['model'] for entry in agent['providers'][0]['models']], ['claude/opus', 'claude/haiku'])

    def test_messaging_list_keeps_the_fallback_when_key_permissions_are_unreadable(self):
        """With no answer from the model service, the messaging-app list drops the models the fallback ruled out."""
        Endpoint.models = ['codex/gpt-small']
        self.startup()
        feishu = [{'name': 'Opus', 'key': 'claude/opus'}, {'name': 'Large', 'key': 'codex/gpt-large'},
                  {'name': 'Small', 'key': 'codex/gpt-small'}]
        config = dict(CONFIG, defaults=dict(CONFIG['defaults'], claude='claude/opus', effort='medium'),
                      catalog=dict(CONFIG['catalog'], feishu=feishu))
        exec_env = {'WORKPARTNER_MODEL_CONFIG': json.dumps(config), 'WP_MODEL_FALLBACK_FILE': str(self.marker)}
        template = (ROOT / 'home/cc-connect-feishu.toml').read_text()
        target = Path(self.directory.name) / 'config.toml'
        target.write_text(template.replace('__CLAUDE_MODEL__', 'claude/opus').replace('__EFFORT__', 'medium')
                          .replace('__APP_SECRET__', 'fixture').replace('__PROJECT__', 'p').replace('__ALLOW_FROM__', ''))
        with patch.dict(os.environ, exec_env, clear=True), patch.object(bridge, 'key_models', return_value=None):
            self.assertTrue(bridge.refresh(target))
        provider = tomllib.loads(target.read_text())['projects'][0]['agent']['providers'][0]
        self.assertEqual(provider['model'], 'codex/gpt-large')
        self.assertEqual([entry['model'] for entry in provider['models']], ['codex/gpt-large', 'codex/gpt-small'])
        # A list of only ruled-out models leaves the fallback catalog in place.
        config['catalog']['feishu'] = feishu[:1]
        with patch.dict(os.environ, dict(exec_env, WORKPARTNER_MODEL_CONFIG=json.dumps(config)), clear=True), \
                patch.object(bridge, 'key_models', return_value=None):
            bridge.refresh(target)
        provider = tomllib.loads(target.read_text())['projects'][0]['agent']['providers'][0]
        self.assertEqual(provider, {'name': 'workpartner', 'model': 'codex/gpt-large',
                                    'models': [{'model': 'codex/gpt-large', 'alias': 'gpt-large'}]})


if __name__ == '__main__':
    unittest.main()

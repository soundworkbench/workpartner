"""Exercise template, onboarding, startup and administrator migration behavior."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'bin' / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


bridge = module('wp-bridge-defaults')
onboard = module('feishu-onboard')
ENV = {'PARTNER_BRIDGE_MODEL': 'fixture-claude', 'PARTNER_DEFAULT_EFFORT': 'high'}


class BridgeDefaultsTest(unittest.TestCase):
    def template(self):
        return (ROOT / 'home/cc-connect-feishu.toml').read_bytes()

    def old_config(self):
        return self.template().replace(b'type = "claudecode"', b'type = "codex"') \
            .replace(b'mode = "bypassPermissions"', b'mode = "yolo"') \
            .replace(b'__CLAUDE_MODEL__', b'old-codex').replace(b'__EFFORT__', b'low') \
            .replace(b'__APP_SECRET__', b'fixture-private-value') \
            .replace(b'model = "old-codex"', b'"model" = \'old-codex\' # keep comment')

    def check_agent(self, content):
        projects = tomllib.loads(content.decode())['projects']
        for project in projects:
            self.assertEqual(project['agent']['type'], 'claudecode')
            self.assertEqual(project['agent']['options']['mode'], 'bypassPermissions')
            self.assertEqual(project['agent']['options']['model'], ENV['PARTNER_BRIDGE_MODEL'])
            self.assertEqual(project['agent']['options']['reasoning_effort'], 'high')

    def expected(self, source):
        return source.replace(b'type = "codex"', b'type = "claudecode"') \
            .replace(b'mode = "yolo"', b'mode = "bypassPermissions"') \
            .replace(b'\'old-codex\' # keep comment', b'"fixture-claude" # keep comment') \
            .replace(b'reasoning_effort = "low"', b'reasoning_effort = "high"')

    def test_template_and_existing_configs_preserve_every_unmanaged_byte(self):
        template = tomllib.loads(self.template().decode())
        self.assertEqual(template['projects'][0]['agent']['type'], 'claudecode')
        self.assertNotIn('agent_session_idle_timeout_mins', template)
        self.assertNotIn('agent_session_idle_timeout_mins', template['projects'][0])
        for newline in (b'\n', b'\r\n'):
            with self.subTest(newline=newline), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / 'real.toml'
                source = self.old_config().replace(b'\n', newline)
                target.write_bytes(source)
                target.chmod(0o640)
                link = root / 'config.toml'
                link.symlink_to(target)
                with patch.dict(os.environ, ENV):
                    self.assertTrue(bridge.refresh(link))
                    self.assertEqual(target.read_bytes(), self.expected(source))
                    self.check_agent(target.read_bytes())
                    metadata = target.stat()
                    self.assertFalse(bridge.refresh(link))
                    self.assertEqual(target.stat(), metadata)
                self.assertTrue(link.is_symlink())
                self.assertEqual(target.stat().st_mode & 0o777, 0o640)
                self.assertEqual(list(root.glob('.bridge-*')), [])

    def test_missing_keys_multiple_projects_and_string_lookalikes(self):
        source = '''note = """
[projects.agent.options]
model = "decoy"
"""
[[projects]]
name = "first"
[projects.agent]
type = "codex"
[projects.agent.options]
work_dir = "/data/work"
[[projects.platforms]]
type = "feishu"
[projects.platforms.options]
model = "platform-model"
allow_from = "fixture-person"
[[projects]]
name = "second"
'''
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, ENV):
            target = Path(directory) / 'config.toml'
            target.write_text(source)
            self.assertTrue(bridge.refresh(target))
            self.check_agent(target.read_bytes())
            parsed = tomllib.loads(target.read_text())
            original = tomllib.loads(source)
            self.assertEqual(parsed['note'], original['note'])
            self.assertEqual(parsed['projects'][0]['platforms'], original['projects'][0]['platforms'])
            self.assertFalse(bridge.refresh(target))

    def test_failure_never_partially_writes_or_prints_credentials(self):
        for source in (b'[broken fixture-private-value', self.old_config()):
            with self.subTest(source=source[:20]), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / 'config.toml'
                target.write_bytes(source)
                error = io.StringIO()
                with patch.dict(os.environ, ENV), patch.object(bridge.os, 'replace', side_effect=OSError('fixture-private-value')):
                    with contextlib.redirect_stderr(error):
                        self.assertFalse(bridge.refresh(target))
                self.assertEqual(target.read_bytes(), source)
                self.assertIn('Warning:', error.getvalue())
                self.assertNotIn('fixture-private-value', error.getvalue())
                self.assertEqual(list(Path(directory).glob('.bridge-*')), [])

    def test_existing_onboarding_refreshes_before_early_return(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, ENV):
            base = Path(directory)
            config = base / 'config.toml'
            source = self.old_config()
            config.write_bytes(source)
            with patch.object(onboard, 'CONFIG', config):
                onboard.run('partner-fixture', base=base, command='/does-not-run')
                self.assertEqual(config.read_bytes(), self.expected(source))
                metadata = config.stat()
                onboard.run('partner-fixture', base=base, command='/does-not-run')
                self.assertEqual(config.stat(), metadata)

    def test_new_onboarding_uses_runtime_defaults_even_with_a_legacy_template(self):
        runtime = dict(os.environ, WORKPARTNER_MODEL_CONFIG=json.dumps({'defaults': {'claude': 'fixture-claude', 'effort': 'high'}}))
        runtime.pop('PARTNER_BRIDGE_MODEL', None)
        runtime.pop('PARTNER_DEFAULT_EFFORT', None)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, runtime, clear=True):
            base = Path(directory)
            config = base / 'config.toml'
            template = base / 'template.toml'
            template.write_bytes(self.old_config())
            command = base / 'fake-bridge'
            command.write_text('''#!/usr/bin/env python3
import sys, tomllib
from pathlib import Path
config = Path(sys.argv[sys.argv.index('--config') + 1])
agent = tomllib.loads(config.read_text())['projects'][0]['agent']
assert agent['type'] == 'claudecode'
assert agent['options']['model'] == 'fixture-claude'
text = config.read_text().replace('__APP_ID__', 'fixture-app').replace('allow_from = ""', 'allow_from = "fixture-person"')
# A bridge CLI may rewrite agent keys while provisioning; reapply after it exits.
config.write_text(text.replace('type = "claudecode"', 'type = "codex"'))
''')
            command.chmod(0o700)
            with patch.object(onboard, 'CONFIG', config), patch.object(onboard, 'BASE', base), \
                    patch.object(onboard, 'STATE', base / 'state.json'):
                onboard.run('partner-fixture', base=base, template=template, command=str(command))
                self.check_agent(config.read_bytes())
                self.assertEqual(tomllib.loads(config.read_text())['projects'][0]['platforms'][0]['options']['allow_from'], 'fixture-person')
                self.assertEqual(onboard.read()['status'], 'needs_restart')
                self.assertEqual(config.stat().st_mode & 0o777, 0o600)

    def test_container_exec_without_runtime_injection_uses_embedded_organization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'config.toml'
            target.write_bytes(self.old_config())
            (root / 'organization.json').write_text(json.dumps({'model': {'defaults': {'claude': 'fixture-claude', 'effort': 'high'}}}))
            with patch.dict(os.environ, {'WORKPARTNER_ORG_DIR': directory}, clear=True):
                self.assertTrue(bridge.refresh(target))
            self.check_agent(target.read_bytes())

    def test_administrator_tool_previews_applies_and_repeats(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.toml'
            source = self.old_config()
            config.write_bytes(source)
            command = ['python3', '-I', '-B', str(ROOT.parent / 'tools/migrate-bridge.py'), str(config),
                       '--model', ENV['PARTNER_BRIDGE_MODEL'], '--effort', 'high']
            preview = subprocess.run(command, capture_output=True, text=True, check=True)
            self.assertIn('Would update', preview.stdout)
            self.assertEqual(config.read_bytes(), source)
            subprocess.run(command + ['--apply'], capture_output=True, check=True)
            self.assertEqual(config.read_bytes(), self.expected(source))
            metadata = config.stat()
            subprocess.run(command + ['--apply'], capture_output=True, check=True)
            self.assertEqual(config.stat(), metadata)

    def test_startup_failure_warns_and_continues(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, ENV):
            config = Path(directory) / 'config.toml'
            config.write_text('[broken fixture-private-value')
            shell = (ROOT / 'bin/start.sh').read_text()
            shell = shell[shell.index('# Refresh existing bridge'):shell.index('# 首次写整份说明；')]
            shell = shell.replace('/opt/workpartner', str(ROOT)).replace('/data/.cc-connect/config.toml', str(config))
            result = subprocess.run(['bash', '-euc', shell + '\necho services-can-start'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertIn('services-can-start', result.stdout)
            self.assertIn('Warning:', result.stderr)
            self.assertNotIn('fixture-private-value', result.stderr)


if __name__ == '__main__':
    unittest.main()

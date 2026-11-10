"""Exercise engine settings and startup markers without services or personal data."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('defaults', ROOT / 'bin/wp-model-defaults.py')
defaults = importlib.util.module_from_spec(spec)
spec.loader.exec_module(defaults)


class ModelDefaultsTest(unittest.TestCase):
    def run_case(self, engine, personal=False):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / ('settings.json' if engine == 'claude' else 'config.toml')
            template = ROOT / 'home' / ('claude-settings.json' if engine == 'claude' else 'codex-config.toml')
            def sync(model):
                return defaults.sync(engine, template, target, model, 'medium', 'https://models.example.test/v1')
            def read():
                return json.loads(target.read_bytes()) if engine == 'claude' else tomllib.loads(target.read_text())
            self.assertEqual(sync('first-model'), 'first-model')
            self.assertEqual(read()['model'], 'first-model')
            if personal:
                if engine == 'claude':
                    config = read()
                    config.update(model='my-model', permissions={'allow': ['Read']})
                    target.write_text(json.dumps(config))
                else:
                    target.write_text(target.read_text().replace('model = "first-model"', 'model = "my-model" # my choice'))
                target.chmod(0o640)
                before = target.read_bytes()
            for _ in range(2):
                self.assertEqual(sync('second-model'), 'my-model' if personal else 'second-model')
            self.assertEqual(read()['model'], 'my-model' if personal else 'second-model')
            self.assertEqual(json.loads(target.with_name('.wp-organization-model.json').read_text()),
                             {'model': 'first-model' if personal else 'second-model'})
            if personal:
                sync('my-model')
                sync('third-model')
                self.assertEqual(target.read_bytes(), before)
                self.assertEqual(target.stat().st_mode & 0o777, 0o640)

    def test_first_start_and_changed_organization_default_for_both_engines(self):
        for engine in ('claude', 'codex'):
            with self.subTest(engine=engine):
                self.run_case(engine)

    def test_personal_choices_survive_changed_default_and_restarts(self):
        for engine in ('claude', 'codex'):
            with self.subTest(engine=engine):
                self.run_case(engine, personal=True)

    def test_markerless_released_defaults_adopt_new_default(self):
        for engine, old in [('claude', 'claude/claude-opus-5-5'), ('codex', 'gpt-6.1-sol')]:
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary) / 'settings'
                target.write_text(json.dumps({'model': old}) if engine == 'claude' else f'model = "{old}"\n')
                template = ROOT / 'home' / ('claude-settings.json' if engine == 'claude' else 'codex-config.toml')
                defaults.sync(engine, template, target, 'new-default', 'medium')
                self.assertIn('new-default', target.read_text())

    def test_markerless_personal_selection_is_preserved(self):
        for engine in ('claude', 'codex'):
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary) / 'settings'
                before = '{"model":"my-model"}' if engine == 'claude' else 'model = "my-model" # mine\n'
                target.write_text(before)
                defaults.sync(engine, target, target, 'new-default', 'medium')
                self.assertEqual(target.read_text(), before)

    def test_toml_preserves_tables_comments_crlf_and_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real = root / 'real.toml'
            before = b'# mine\r\nmodel = "old" # top\r\n[other]\r\nmodel = "old"\r\n'
            real.write_bytes(before)
            real.chmod(0o640)
            target = root / 'config.toml'
            target.symlink_to(real)
            target.with_name('.wp-organization-model.json').write_text('{"model":"old"}')
            defaults.sync('codex', real, target, 'new', 'medium')
            self.assertEqual(real.read_bytes(), before.replace(b'model = "old" # top', b'model = "new" # top'))
            self.assertTrue(target.is_symlink())
            self.assertEqual(real.stat().st_mode & 0o777, 0o640)

    def test_interrupted_update_can_finish_after_either_settings_value(self):
        for current in ('old', 'new'):
            with self.subTest(current=current), tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary) / 'settings'
                target.write_text(json.dumps({'model': current}))
                target.with_name('.wp-organization-model.json').write_text('{"model":"old","pending":"new"}')
                defaults.sync('claude', target, target, 'newer', 'medium')
                self.assertEqual(json.loads(target.read_text())['model'], 'newer')

    def test_invalid_settings_stop_without_altering_them(self):
        for engine in ('claude', 'codex'):
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary) / 'settings'
                target.write_text('{invalid')
                with self.assertRaises(ValueError):
                    defaults.sync(engine, target, target, 'new', 'medium')
                self.assertEqual(target.read_text(), '{invalid')
                self.assertFalse(target.with_name('.wp-organization-model.json').exists())


if __name__ == '__main__':
    unittest.main()

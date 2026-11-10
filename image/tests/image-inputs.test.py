"""Check official source repacking, references, licenses and instruction preservation."""
import gzip
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'bin' / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


skills = module('wp-feishu-skills')
instructions = module('wp-sync-instructions')


class InputsTest(unittest.TestCase):
    def test_baseline_install_preserves_personal_settings_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings = root / 'settings.json'
            settings.write_text(json.dumps({'model': 'personal', 'permissions': {'allow': ['Read']},
                                            'hooks': {'PreToolUse': [{'matcher': 'Bash', 'hooks': [
                                                {'type': 'command', 'command': 'personal-hook'}]}]}}))
            for _ in range(2):
                subprocess.run(['bash', str(ROOT / 'agent-baseline/install.sh'), str(root), '/data/.claude/hooks'],
                               check=True, capture_output=True)
                current = json.loads(settings.read_text())
                self.assertEqual(current['model'], 'personal')
                self.assertEqual(current['permissions'], {'allow': ['Read']})
                bash = next(entry for entry in current['hooks']['PreToolUse'] if entry['matcher'] == 'Bash')
                self.assertEqual(len(bash['hooks']), 3)
                self.assertEqual(bash['hooks'][0]['command'], 'personal-hook')
                self.assertTrue((root / 'hooks/no-long-sleep.py').is_file())

    def upstream(self, path, files):
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo('upstream-commit/' + name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))

    def test_pack_is_repeatable_and_retains_only_skills_and_licenses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sources = [root / 'one.tgz', root / 'two.tgz']
            self.upstream(sources[0], {'skills/lark-doc/SKILL.md': b'official document skill',
                                     'skills/lark-doc/references/read.md': b'reference', 'LICENSE': b'license one',
                                     'main.go': b'not a skill'})
            self.upstream(sources[1], {'skills/meegle/SKILL.md': b'project skill', 'LICENSE': b'license two'})
            first, second = root / 'first.tgz', root / 'second.tgz'
            skills.pack(sources, first)
            skills.pack(sources, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first) as bundle:
                self.assertEqual(set(bundle.getnames()), {'lark-doc/SKILL.md', 'lark-doc/references/read.md',
                                                         'meegle/SKILL.md', 'LICENSE-lark', 'LICENSE-meegle'})
            destination = root / 'skills'
            skills.install(first, destination)
            self.assertEqual((destination / 'lark-doc/references/read.md').read_bytes(), b'reference')
            self.assertEqual((destination / 'LICENSE-meegle').read_bytes(), b'license two')
            self.assertEqual(json.loads((destination / '.wp-feishu-skills.json').read_text()), ['feishu', 'lark-doc', 'meegle'])
            self.assertEqual((destination / 'feishu/SKILL.md').read_bytes(), (ROOT / 'home/feishu-SKILL.md').read_bytes())
            custom = root / 'policy.md'
            custom.write_text('organization policy')
            skills.install(first, destination, custom)
            self.assertEqual((destination / 'feishu/SKILL.md').read_text(), 'organization policy')

    def test_invalid_archive_does_not_write_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'bad.tgz'
            self.upstream(source, {'../escape': b'bad'})
            with self.assertRaises(ValueError):
                skills.install(source, root / 'skills')
            self.assertEqual(list((root / 'skills').iterdir()), [])

    def test_instruction_block_update_keeps_personal_bytes_and_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            work = root / 'work'
            work.mkdir()
            template = root / 'CLAUDE.md'
            template.write_bytes((ROOT / 'home/CLAUDE.md').read_bytes())
            personal = b'Personal instructions\r\nKeep this exactly.\r\n'
            target = work / 'CLAUDE.md'
            target.write_bytes(personal)
            instructions.sync(template, work, 'Colleague')
            self.assertTrue(target.read_bytes().startswith(personal))
            first = target.read_bytes()
            instructions.sync(template, work, 'Colleague')
            self.assertEqual(target.read_bytes(), first)
            self.assertTrue((work / 'AGENTS.md').is_symlink())


if __name__ == '__main__':
    unittest.main()

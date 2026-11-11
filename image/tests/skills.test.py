"""Keyless skill lifecycle tests on isolated personal volumes; no running containers."""
import concurrent.futures
import importlib.machinery
import importlib.util
import json
import os
from unittest.mock import patch
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import zipfile

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[1] / 'bin/wp-skill'
loader = importlib.machinery.SourceFileLoader('wp_skill', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


def skill(name, description='Personal skill'):
    return f'---\nname: {name}\ndescription: |\n  {description}\n---\n\n# Instructions\n'


class SkillsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wp-skills-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home, self.builtin, self.uploads = [self.root / p for p in ['home', 'builtin', 'uploads']]
        self.builtin.mkdir(); self.uploads.mkdir()
        self.zh = self.root / 'skills-zh.json'
        self.zh.write_text((SCRIPT.parent.parent / 'skills-zh.json').read_text())
        self.store = self.open_store()
        self.store.skills.mkdir(parents=True)
        for name in json.loads(self.zh.read_text()):
            (self.builtin / name).mkdir()
            directory = self.store.skills / name
            directory.mkdir()
            (directory / 'SKILL.md').write_text(skill(name))

    def open_store(self):
        return module.SkillStore(self.home, self.builtin, self.zh, self.uploads)

    def archive(self, entries, filename='skill.zip'):
        archive = self.uploads / filename
        with zipfile.ZipFile(archive, 'w') as target:
            for name, value in entries.items():
                target.writestr(name, value)
        return archive

    def rejected(self, code, action, value, overwrite=False):
        with self.assertRaises(module.SkillError) as caught:
            self.store.run(action, str(value), overwrite)
        self.assertEqual(caught.exception.result['error'], code)
        return caught.exception.result

    def test_list_preinstalled_chinese_names_and_personal_frontmatter(self):
        rows = self.store.run('list')['skills']
        self.assertEqual({row['displayName'] for row in rows}, {'办公文件', '演示文稿', '文字文档', '电子表格', '飞书', '分享技能'})
        self.assertTrue(all(row['preinstalled'] for row in rows))
        # AionUi built-ins live elsewhere and do not appear in this personal store.
        (self.home / '.aionui/skills/builtin').mkdir(parents=True)
        upload = self.uploads / 'SKILL.md'; upload.write_text(skill('my-skill', 'Multiline description'))
        self.store.run('install', str(upload))
        row = self.store.run('list')['skills'][-1]
        self.assertEqual(row['name'], 'my-skill'); self.assertEqual(row['displayName'], 'my-skill')
        self.assertEqual(row['description'], 'Multiline description\n'); self.assertFalse(row['preinstalled'])
        self.assertEqual(len(self.store.run('list')['skills']), 7)

    def test_list_returns_only_a_named_https_source(self):
        head = '---\nname: {}\ndescription: Data\nmetadata:\n  source-name: "Example Data"\n  source-url: "{}"\n---\n'
        for name, url in [('sourced', 'https://data.example.com'), ('plain-link', 'http://data.example.com')]:
            upload = self.uploads / 'SKILL.md'; upload.write_text(head.format(name, url))
            self.store.run('install', str(upload))
        rows = {row['name']: row for row in self.store.run('list')['skills']}
        self.assertEqual(rows['sourced']['source'], {'name': 'Example Data', 'url': 'https://data.example.com'})
        self.assertNotIn('source', rows['plain-link']); self.assertNotIn('source', rows['feishu'])

    def test_zip_root_and_one_folder_install_link_persist_overwrite_and_delete(self):
        for prefix in ['', 'bundle/']:
            with self.subTest(prefix=prefix):
                upload = self.archive({prefix + 'SKILL.md': skill('personal'), prefix + 'scripts/run.py': 'print(1)', **({'__MACOSX/info': 'zip metadata'} if prefix else {})})
                self.store.run('install', str(upload))
                directory, link = self.store.skills / 'personal', self.store.codex / 'personal'
                self.assertFalse(directory.is_symlink()); self.assertEqual(link.resolve(), directory)
                self.assertEqual((link / 'scripts/run.py').read_text(), 'print(1)')
                result = self.rejected('exists', 'install', upload)
                self.assertEqual(result['name'], 'personal')
                self.assertEqual((directory / 'scripts/run.py').read_text(), 'print(1)')
                upload = self.archive({prefix + 'SKILL.md': skill('personal', 'Updated')})
                self.store.run('install', str(upload), overwrite=True)
                self.assertFalse((directory / 'scripts').exists())
                # A fresh process/store sees the same mounted volume and links.
                self.assertEqual(self.open_store().run('list')['skills'][-1]['description'], 'Updated\n')
                self.open_store().run('delete', 'personal')
                self.assertFalse(directory.exists()); self.assertFalse(link.is_symlink())

    def test_preinstalled_cannot_be_replaced_or_deleted(self):
        upload = self.archive({'SKILL.md': skill('officecli')})
        original = (self.store.skills / 'officecli/SKILL.md').read_text()
        self.rejected('preinstalled', 'install', upload, True)
        self.rejected('preinstalled', 'delete', 'officecli')
        self.assertEqual((self.store.skills / 'officecli/SKILL.md').read_text(), original)

    def test_bad_archives_rejected_before_visible_changes(self):
        cases = [
            ('missing_skill', {'readme.md': 'nothing'}),
            ('missing_skill', {'a/b/SKILL.md': skill('deep')}),
            ('missing_skill', {'a/SKILL.md': skill('a'), 'b/SKILL.md': skill('b')}),
            ('unsafe_archive', {'../escape': 'bad', 'SKILL.md': skill('bad')}),
            ('unsafe_archive', {'a/../../escape': 'bad', 'SKILL.md': skill('bad')}),
            ('unsafe_archive', {'/absolute': 'bad', 'SKILL.md': skill('bad')}),
            ('unsafe_archive', {'a\\escape': 'bad', 'SKILL.md': skill('bad')}),
            ('invalid_name', {'SKILL.md': skill('Bad_Name')}),
            ('invalid_name', {'SKILL.md': '# no frontmatter'}),
            ('invalid_name', {'SKILL.md': '---\nname: !!python/object:danger {}\n---\n'}),
            ('too_many_files', {**{f'file-{n}': '' for n in range(200)}, 'SKILL.md': skill('many')}),
        ]
        for code, entries in cases:
            with self.subTest(code=code, names=list(entries)[:2]):
                self.rejected(code, 'install', self.archive(entries))
                self.assertEqual(len(self.store.run('list')['skills']), 6)
        self.assertFalse((self.root / 'escape').exists())
        self.assertFalse(list(self.store.skills.parent.glob('.wp-skill-*')))

    def test_symlink_and_oversize_rejected(self):
        info = zipfile.ZipInfo('link'); info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        upload = self.archive({'SKILL.md': skill('linked')})
        with zipfile.ZipFile(upload, 'a') as archive:
            archive.writestr(info, '/somewhere')
        self.rejected('unsafe_archive', 'install', upload)
        with upload.open('wb') as output: output.truncate(module.MAX_UPLOAD + 1)
        self.rejected('too_large', 'install', upload)
        expanded = self.uploads / 'expanded.zip'
        with zipfile.ZipFile(expanded, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('SKILL.md', skill('expanded'))
            with archive.open('large.txt', 'w') as writer:
                for _ in range(101): writer.write(b'0' * (1024 * 1024))
        self.assertLess(expanded.stat().st_size, module.MAX_UPLOAD)
        self.rejected('too_large', 'install', expanded)
        upload = self.archive({'SKILL.md': skill('limit'), **{f'file-{n}': '' for n in range(199)}})
        self.store.run('install', str(upload))
        self.assertEqual(len(list((self.store.skills / 'limit').iterdir())), 200)

    def test_upload_escape_and_real_codex_directory_preserved(self):
        outside = self.root / 'SKILL.md'; outside.write_text(skill('escaped'))
        link = self.uploads / 'SKILL.md'; link.symlink_to(outside)
        self.rejected('invalid_upload', 'install', link)
        self.rejected('invalid_name', 'delete', '../outside')
        upload = self.archive({'SKILL.md': skill('personal')})
        target = self.store.codex / 'personal'; target.mkdir(parents=True)
        (target / 'keep').write_text('existing')
        self.rejected('unsafe_target', 'install', upload)
        self.assertEqual((target / 'keep').read_text(), 'existing')
        self.assertFalse((self.store.skills / 'personal').exists())

    def test_two_simultaneous_installs_require_confirmation_and_keep_one_complete_skill(self):
        upload = self.archive({'SKILL.md': skill('parallel'), 'data.txt': 'intact'})
        def install(_):
            try: return self.open_store().run('install', str(upload))
            except module.SkillError as error: return error.result
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(install, range(2)))
        self.assertEqual(sum(row.get('error') == 'exists' for row in results), 1)
        self.assertEqual((self.store.codex / 'parallel/data.txt').read_text(), 'intact')


    def test_promoted_shared_skill_is_installed_in_both_engines_and_cannot_be_removed(self):
        shared = self.root / 'shared'
        target = shared / 'live/promoted'
        target.mkdir(parents=True)
        (target / 'SKILL.md').write_text(skill('promoted'))
        with patch.dict(os.environ, {'WORKPARTNER_MARKET_PREINSTALLED': '["promoted"]', 'WORKPARTNER_SHARED_SKILLS': str(shared)}):
            store = self.open_store()
            self.assertTrue(store.run('shared-install', 'promoted')['changed'])
            self.assertFalse(store.run('shared-install', 'promoted')['changed'])
            row = next(row for row in store.run('list')['skills'] if row['name'] == 'promoted')
            self.assertTrue(row['preinstalled'])
            self.assertEqual((store.codex / 'promoted/SKILL.md').read_text(), skill('promoted'))
            with self.assertRaises(module.SkillError) as caught:
                store.run('delete', 'promoted')
            self.assertEqual(caught.exception.result['error'], 'preinstalled')


if __name__ == '__main__':
    unittest.main()

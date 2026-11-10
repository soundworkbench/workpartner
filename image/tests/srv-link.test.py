"""Check service paths without building or running an image."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'bin/wp-init-hooks.sh'


class SrvLinkTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wp-srv-')
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name) / 'data'
        self.data.mkdir()
        self.srv = self.data / 'srv'

    def ensure_srv(self):
        result = subprocess.run(
            ['bash', '-euo', 'pipefail', '-c',
             '. "$1"; wp_ensure_srv_directory "$2"; echo continued',
             'srv-test', str(HELPER), str(self.data)],
            capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'continued\n')
        return result

    def test_dockerfile_prepares_service_paths_as_root_before_runtime_user(self):
        lines = (ROOT / 'Dockerfile').read_text().replace('\\\n', ' ').splitlines()
        user = None
        link_at = mysqld_at = runtime_at = None
        for index, line in enumerate(lines):
            fields = line.strip().split(maxsplit=1)
            if not fields or fields[0].startswith('#'):
                continue
            instruction = fields[0].upper()
            if instruction == 'FROM':
                user = None
                link_at = mysqld_at = None
            elif instruction == 'USER':
                user = fields[1]
                if user == '1001:1001':
                    runtime_at = index
                    break
            elif instruction == 'RUN' and fields[1] == 'rmdir /srv && ln -s /data/srv /srv':
                self.assertEqual(user, 'root')
                link_at = index
            elif instruction == 'RUN' and fields[1] == 'install -d -o 1001 -g 1001 -m 755 /run/mysqld':
                self.assertEqual(user, 'root')
                mysqld_at = index
        self.assertIsNotNone(link_at, 'missing fail-safe /srv link creation')
        self.assertIsNotNone(mysqld_at, 'missing /run/mysqld creation with owner 1001:1001 and mode 755')
        self.assertIsNotNone(runtime_at, 'missing runtime USER')
        self.assertLess(link_at, runtime_at)
        self.assertLess(mysqld_at, runtime_at)

    def test_missing_directory_is_created(self):
        result = self.ensure_srv()
        self.assertTrue(self.srv.is_dir())
        self.assertFalse(self.srv.is_symlink())
        self.assertEqual(result.stderr, '')

    def test_existing_directory_and_contents_are_unchanged(self):
        self.srv.mkdir(mode=0o750)
        nested = self.srv / 'service'
        nested.mkdir()
        content = nested / 'data'
        content.write_bytes(b'keep service data\x00\n')
        before = {path: path.stat() for path in (self.srv, nested, content)}
        for _ in range(2):
            self.assertEqual(self.ensure_srv().stderr, '')
            for path, stat in before.items():
                current = path.stat()
                self.assertEqual((current.st_ino, current.st_mode, current.st_mtime_ns),
                                 (stat.st_ino, stat.st_mode, stat.st_mtime_ns))
            self.assertEqual(list(self.srv.iterdir()), [nested])
            self.assertEqual(list(nested.iterdir()), [content])
            self.assertEqual(content.read_bytes(), b'keep service data\x00\n')

    def test_file_warns_and_is_preserved(self):
        self.srv.write_text('keep file')
        before = self.srv.stat()
        result = self.ensure_srv()
        self.assertIn('warning:', result.stderr)
        self.assertIn(str(self.srv), result.stderr)
        self.assertEqual(self.srv.stat(), before)
        self.assertEqual(self.srv.read_text(), 'keep file')

    def test_symlinks_warn_and_leave_links_and_targets_unchanged(self):
        for kind in ('directory', 'file', 'dangling'):
            with self.subTest(kind=kind):
                target = self.data / kind
                if kind == 'directory':
                    target.mkdir()
                    (target / 'keep').write_text('keep directory content')
                elif kind == 'file':
                    target.write_text('keep target file')
                self.srv.symlink_to(kind)
                before = self.srv.lstat()
                result = self.ensure_srv()
                self.assertIn('warning:', result.stderr)
                self.assertIn(str(self.srv), result.stderr)
                self.assertEqual(self.srv.lstat(), before)
                self.assertEqual(os.readlink(self.srv), kind)
                if kind == 'directory':
                    self.assertEqual(list(target.iterdir()), [target / 'keep'])
                    self.assertEqual((target / 'keep').read_text(), 'keep directory content')
                elif kind == 'file':
                    self.assertEqual(target.read_text(), 'keep target file')
                else:
                    self.assertFalse(target.exists())
                self.srv.unlink()


if __name__ == '__main__':
    unittest.main()

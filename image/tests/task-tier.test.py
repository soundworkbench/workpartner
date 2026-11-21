"""Render live task tiers and preserve personal instruction bytes without a cluster."""
import importlib.util
import json
import os
from pathlib import Path
import runpy
import select
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('instructions', ROOT / 'bin/wp-sync-instructions.py')
instructions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(instructions)


class TaskTierTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.tier = self.root / 'tier.json'
        self.target = self.root / 'CLAUDE.md'
        self.template = ROOT / 'home/CLAUDE.md'

    def sync(self, memory=8 * 2 ** 30):
        instructions.sync(self.template, self.root, 'Colleague', memory_bytes=memory, tier_path=self.tier)
        return self.target.read_text()

    def test_three_tiers_and_overrides_with_half_memory_cap(self):
        for config, memory, tasks, budget in (
            ({'tier': 'standard'}, 4 * 2 ** 30, '同时最多运行 3 个', 512),
            ({'tier': 'open'}, 6 * 2 ** 30, '同时最多运行 5 个', 1024),
            ({'tier': 'unlimited', 'tasks': None, 'taskMemoryMiB': 1024}, 8 * 2 ** 30, '同时运行的后台任务个数不限', 1024),
            ({'tier': 'open'}, 2 ** 30, '同时最多运行 5 个', 512),
            ({'tier': 'standard', 'tasks': None, 'taskMemoryMiB': 3072}, 4 * 2 ** 30, '同时运行的后台任务个数不限', 2048),
            ({'tasks': 7, 'taskMemoryMiB': 1536}, 8 * 2 ** 30, '同时最多运行 7 个', 1536),
        ):
            with self.subTest(config=config, memory=memory):
                self.tier.write_text(json.dumps(config))
                rendered = self.sync(memory)
                self.assertIn(tasks, rendered)
                self.assertIn(f'后台任务最多使用 {budget} MiB', rendered)
                self.assertIn(f'内存上限为 {memory // 2 ** 20} MiB', rendered)
                self.assertIn('合计内存不要超过上限减 1 GiB', rendered)
                self.assertNotIn('__BACKGROUND_', rendered)

    def test_missing_unreadable_corrupt_and_invalid_tiers_use_standard(self):
        cases = [None, b'{broken', b'\xff', b'[]', b'null', b'false', b'{}', b'[' * 2000 + b']' * 2000]
        cases += [json.dumps(value).encode() for value in (
            {'tier': 'unknown', 'tasks': 9}, {'tier': None}, {'tier': []},
            *({'tier': 'open', 'tasks': value} for value in (0, -1, 1.5, True, '5', [], {}, 2 ** 53)),
            *({'tier': 'unlimited', 'taskMemoryMiB': value} for value in (None, 0, -1, 1.5, False, '1024', [])),
        )]
        for content in cases:
            with self.subTest(content=content):
                if content is None:
                    self.tier.unlink(missing_ok=True)
                else:
                    self.tier.write_bytes(content)
                rendered = self.sync()
                self.assertIn('同时最多运行 3 个', rendered)
                self.assertIn('后台任务最多使用 512 MiB', rendered)
        self.tier.unlink()
        self.tier.mkdir()
        self.assertIn('同时最多运行 3 个', self.sync())

    def test_only_exact_legacy_section_is_removed_outside_company_block(self):
        heading = instructions.LEGACY_TIER
        block = instructions.BEGIN + b'\nOld rules\n' + instructions.END
        personal = '## 个人特殊设置\r\n保留全部空白  \r\n'.encode() + b'\xff'
        prefix = b'Personal\r\n\n'
        near_match = heading + b' extra\nKeep this heading\n'
        for original, expected_prefix, expected_suffix in (
            (prefix + block + b'\n' + heading + b'\r\nOld tier\r\n### detail\r\nOld detail\r\n' + personal,
             prefix, b'\n' + personal),
            (prefix + heading + b'\nOld tier\n' + block + b'\n' + personal,
             prefix, b'\n' + personal),
            (prefix + block + b'\n' + near_match + heading + b'\nOld tier at EOF',
             prefix, b'\n' + near_match),
            (prefix + block + b'\n' + heading, prefix, b'\n'),
        ):
            with self.subTest(original=original):
                self.target.write_bytes(original)
                instructions.sync(self.template, self.root, 'Colleague', memory_bytes=8 * 2 ** 30, tier_path=self.tier)
                content = self.target.read_bytes()
                start, end = instructions.block_span(content)
                self.assertEqual(content[:start], expected_prefix)
                self.assertEqual(content[end:], expected_suffix)
        self.target.write_bytes(prefix + heading + b'\nOld tier\n' + personal)
        instructions.sync(self.template, self.root, 'Colleague', memory_bytes=8 * 2 ** 30, tier_path=self.tier)
        content = self.target.read_bytes()
        start, _ = instructions.block_span(content)
        self.assertEqual(content[:start], prefix + personal + b'\n\n')

    def test_watcher_detects_projected_file_replacement_and_retries_failed_sync(self):
        self.tier.symlink_to('projected.json')
        projected = self.root / 'projected.json'
        watcher = instructions.TierWatcher(self.template, self.root, 'Colleague', self.tier)
        with patch.object(instructions, 'memory_budget', return_value=8 * 2 ** 30), \
                patch.object(instructions, 'sync', wraps=instructions.sync) as sync:
            watcher.poll()
            self.assertIn('同时最多运行 3 个', self.target.read_text())
            before = self.target.stat()
            watcher.poll()
            self.assertEqual(sync.call_count, 1)
            self.assertEqual(self.target.stat(), before)
            projected.write_text('{"tier":"open"}')
            watcher.poll()
            self.assertIn('同时最多运行 5 个', self.target.read_text())
            before = self.target.stat()
            projected.write_text('{ "tier": "open" }')
            watcher.poll()
            self.assertEqual(self.target.stat(), before)
            replacement = self.root / 'next.json'
            replacement.write_text('{"tier":"unlimited","tasks":null,"taskMemoryMiB":1024}')
            replacement.replace(projected)
            with patch.object(instructions.os, 'replace', side_effect=OSError('retry')):
                with self.assertRaises(OSError):
                    watcher.poll()
            self.assertEqual(self.target.stat(), before)
            watcher.poll()
            self.assertIn('同时运行的后台任务个数不限', self.target.read_text())
            self.assertIn('后台任务最多使用 1024 MiB', self.target.read_text())
            projected.write_bytes(b'broken')
            watcher.poll()
            self.assertIn('同时最多运行 3 个', self.target.read_text())
            projected.unlink()
            before = self.target.stat()
            watcher.poll()
            self.assertEqual(self.target.stat(), before)
            self.assertEqual({p.name for p in self.root.iterdir()},
                             {'CLAUDE.md', '.CLAUDE.md.lock', 'AGENTS.md', 'tier.json'})

    def test_watcher_and_agent_sync_serialize_reads_and_preserve_both_updates(self):
        # Pause real processes before their read and atomic replace, testing both lock orders.
        launcher = '''
import os, runpy, sys
from pathlib import Path
from unittest.mock import patch
role, bin_dir, template, work, tier = sys.argv[1:]
target = Path(work) / 'CLAUDE.md'
read_bytes, replace = Path.read_bytes, os.replace
def gate(stage):
    print(stage, flush=True)
    if sys.stdin.readline() != 'continue\\n':
        raise RuntimeError('missing test signal')
def read(path):
    if path == target:
        gate('reading')
    return read_bytes(path)
def write(source, destination):
    if Path(destination) == target:
        gate('writing')
    return replace(source, destination)
with patch.object(Path, 'read_bytes', read), patch.object(os, 'replace', write):
    print('ready', flush=True)
    if role == 'watcher':
        module = runpy.run_path(str(Path(bin_dir) / 'wp-sync-instructions.py'))
        module['TierWatcher'](Path(template), Path(work), 'Colleague', Path(tier)).poll()
    else:
        sys.argv = [str(Path(bin_dir) / 'wp-agent'), 'sync']
        runpy.run_path(sys.argv[0], run_name='__main__')
'''

        def stage(process, expected):
            self.assertTrue(select.select([process.stdout], [], [], 5)[0],
                            f'timed out waiting for {expected}')
            self.assertEqual(process.stdout.readline(), (expected + '\n').encode())

        def resume(process):
            process.stdin.write(b'continue\n')
            process.stdin.flush()

        for first_role in ('watcher', 'agent'):
            with self.subTest(first=first_role):
                data = self.root / first_role
                work = data / 'work'
                work.mkdir(parents=True)
                target = work / 'CLAUDE.md'
                personal = '## 个人说明\r\n保留空白  \r\n'.encode() + b'\xff\n'
                target.write_bytes(personal)
                instructions.sync(self.template, work, 'Colleague', memory_bytes=8 * 2 ** 30,
                                  tier_path=self.tier)
                base = data / '.cc-connect'
                record = base / 'agents/s1234abcd/agent.json'
                record.parent.mkdir(parents=True)
                record.write_text(json.dumps({'id': 's1234abcd', 'name': 'Helper',
                                              'createdAt': '2026-01-01T00:00:00Z'}))
                (data / 'agents/s1234abcd').mkdir(parents=True)
                self.tier.write_text('{"tier":"open"}')
                env = dict(os.environ, WP_DATA_DIR=str(data), WP_CC_CONNECT_DIR=str(base),
                           WP_INSTRUCTIONS_TEMPLATE=str(self.template), PARTNER_MEMORY_BYTES=str(8 * 2 ** 30))
                processes = []
                try:
                    for role in (first_role, 'agent' if first_role == 'watcher' else 'watcher'):
                        process = subprocess.Popen(
                            [sys.executable, '-I', '-B', '-c', launcher, role, str(ROOT / 'bin'),
                             str(self.template), str(work), str(self.tier)],
                            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, bufsize=0)
                        processes.append(process)
                        stage(process, 'ready')
                        if len(processes) == 1:
                            stage(process, 'reading')
                            # A fresh personal edit must be included in both subsequent snapshots.
                            fresh = b'\n## User addition\nKeep this new paragraph.\n'
                            with target.open('ab') as stream:
                                stream.write(fresh)
                            resume(process)
                            stage(process, 'writing')
                    first, second = processes
                    self.assertFalse(select.select([second.stdout], [], [], 0.2)[0],
                                     'second writer read CLAUDE.md before the first writer released its lock')
                    resume(first)
                    output, error = first.communicate(timeout=5)
                    self.assertEqual(first.returncode, 0, output + error)
                    stage(second, 'reading')
                    resume(second)
                    stage(second, 'writing')
                    resume(second)
                    output, error = second.communicate(timeout=5)
                    self.assertEqual(second.returncode, 0, output + error)
                    content = target.read_bytes()
                    self.assertTrue(content.startswith(personal))
                    self.assertEqual(content.count(fresh), 1)
                    self.assertIn(f'- Helper：{data / "agents/s1234abcd"}'.encode(), content)
                    self.assertIn('同时最多运行 5 个'.encode(), content)
                    self.assertEqual(content.count(b'<!-- workpartner:agents:begin -->'), 1)
                finally:
                    for process in processes:
                        if process.poll() is None:
                            process.kill()
                        process.communicate(timeout=5)
                self.tier.unlink()

    def test_atomic_update_preserves_personal_symlink_and_mode(self):
        actual = self.root / 'personal.md'
        actual.write_bytes(b'Personal\r\n')
        actual.chmod(0o640)
        self.target.symlink_to(actual.name)
        self.sync()
        self.assertTrue(self.target.is_symlink())
        self.assertEqual(actual.stat().st_mode & 0o777, 0o640)
        self.assertTrue(actual.read_bytes().startswith(b'Personal\r\n'))
        before = actual.read_bytes()
        self.tier.write_text('{"tier":"open"}')
        with patch.object(instructions.os, 'replace', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                self.sync()
        self.assertEqual(actual.read_bytes(), before)

    def test_watch_command_refreshes_after_each_five_minute_interval(self):
        original_read = Path.read_bytes
        snapshots = []

        class StopWatch(Exception):
            pass

        def read(path):
            return original_read(self.tier if path == instructions.TIER_FILE else path)

        def sleep(seconds):
            self.assertEqual(seconds, 300)
            snapshots.append(self.target.read_text())
            if len(snapshots) == 2:
                raise StopWatch()
            self.tier.write_text('{"tier":"unlimited"}')

        self.tier.write_text('{"tier":"open"}')
        script = ROOT / 'bin/wp-sync-instructions.py'
        with patch.object(Path, 'read_bytes', read), patch('time.sleep', sleep), \
                patch.dict(os.environ, PARTNER_MEMORY_BYTES=str(8 * 2 ** 30)), \
                patch('sys.argv', [str(script), str(self.template), str(self.root), 'Colleague', '--watch']):
            with self.assertRaises(StopWatch):
                runpy.run_path(str(script), run_name='__main__')
        self.assertIn('同时最多运行 5 个', snapshots[0])
        self.assertIn('同时运行的后台任务个数不限', snapshots[1])


if __name__ == '__main__':
    unittest.main()

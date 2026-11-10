"""Exercise startup hooks, projected files and service supervision offline."""
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'bin/wp-init-hooks.sh'
PUBLISHED = ('.zp-market-token', '.wp-feishu-cli.json', '.zp-preview-relay-key')


class InitHooksTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wp-init-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.hooks = self.data / '.zp-init.d'
        self.hooks.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.published = self.root / 'published'
        self.published.mkdir()
        self.output = self.root / 'output'
        self.output.mkdir()
        self.env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin', TMPDIR=str(self.output))
        self.env.pop('WORKPARTNER_PUBLISHED_DIR', None)

    def write(self, path, text, mode=0o600):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(mode)
        return path

    def executable(self, name, text):
        return self.write(self.bin / name, '#!/bin/bash\n' + text, 0o700)

    def kill_group(self, pid):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def run_hooks(self, after='', published=True, strict=True, timeout=10):
        env = dict(self.env)
        if published:
            env['WORKPARTNER_PUBLISHED_DIR'] = str(self.published)
        options = ['-euo', 'pipefail'] if strict else ['-u']
        process = subprocess.Popen(
            ['bash', *options, '-c', '. "$1"; wp_init_hooks "$2"; ' + after,
             'init-test', str(HELPER), str(self.data)],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True)
        self.addCleanup(self.kill_group, process.pid)
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.kill_group(process.pid)
            process.communicate(timeout=5)
            raise
        return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)

    def test_links_replace_files_old_links_and_missing_paths_atomically(self):
        old = self.write(self.root / 'old', 'keep old target')
        self.write(self.data / PUBLISHED[0], 'old file')
        (self.data / PUBLISHED[1]).symlink_to(old)
        for name in PUBLISHED:
            self.write(self.published / name, 'fixture ' + name, 0o444)
        mv = shutil.which('mv')
        self.executable('mv', '''[ "$1" = -fT ] && [ "$2" = -- ] || exit 90
[ -L "$3" ] || exit 91
printf '%s\\n' "$4" >> "$MOVES"
exec ''' + shlex.quote(mv) + ' "$@"\n')
        self.env['MOVES'] = str(self.root / 'moves')
        for _ in range(2):
            result = self.run_hooks()
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in PUBLISHED:
                link = self.data / name
                self.assertTrue(link.is_symlink())
                self.assertEqual(os.readlink(link), str(self.published / name))
                self.assertEqual(link.read_text(), 'fixture ' + name)
            self.assertEqual(list(self.data.glob('.wp-published.*')), [])
        self.assertEqual(old.read_text(), 'keep old target')
        self.assertEqual(len((self.root / 'moves').read_text().splitlines()), 6)

    def test_empty_secret_links_follow_later_projection_and_rotation(self):
        result = self.run_hooks()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in PUBLISHED:
            self.assertTrue((self.data / name).is_symlink())
            self.assertFalse((self.data / name).exists())
        for version in ('one', 'two'):
            snapshot = self.published / ('..' + version)
            snapshot.mkdir()
            for name in PUBLISHED:
                self.write(snapshot / name, version, 0o444)
            pending = self.published / '..next'
            pending.symlink_to(snapshot.name)
            pending.replace(self.published / '..data')
            for name in PUBLISHED:
                projection = self.published / name
                if not projection.is_symlink():
                    projection.symlink_to('..data/' + name)
                self.assertEqual((self.data / name).read_text(), version)

    def test_extra_published_files_ignore_projection_metadata_and_directories(self):
        for name in ('extra.json', '.extra-token'):
            self.write(self.published / name, 'fixture')
        self.write(self.published / '..metadata', 'internal')
        (self.published / 'directory').mkdir()
        (self.published / '..data').symlink_to('directory')
        self.assertEqual(self.run_hooks().returncode, 0)
        self.assertEqual({p.name for p in self.data.iterdir()},
                         {'.zp-init.d', *PUBLISHED, 'extra.json'})

    def test_extra_published_names_are_safe_and_projected_regular_files_are_linked(self):
        valid = ('config_2.json', 'A-Z_09.key', '-token')
        for name in valid:
            self.write(self.published / name, 'fixture')
        for name in ('has space', 'line\nbreak', 'semi;colon', '$(command)', 'é.key', '.hidden'):
            self.write(self.published / name, 'ignored')
        snapshot = self.published / '..snapshot'
        self.write(snapshot / 'projected.json', 'projected')
        (self.published / '..data').symlink_to(snapshot.name)
        (self.published / 'projected.json').symlink_to('..data/projected.json')
        (self.published / 'dangling').symlink_to('missing')
        os.mkfifo(self.published / 'pipe')
        result = self.run_hooks()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({p.name for p in self.data.iterdir()},
                         {'.zp-init.d', *PUBLISHED, *valid, 'projected.json'})
        for name in (*valid, 'projected.json'):
            self.assertEqual(os.readlink(self.data / name), str(self.published / name))
        self.assertEqual((self.data / 'projected.json').read_text(), 'projected')

    def test_unset_or_empty_published_directory_preserves_docker_files(self):
        old = self.write(self.data / PUBLISHED[0], 'keep')
        link = self.data / PUBLISHED[1]
        link.symlink_to('missing')
        for value in (None, ''):
            if value is not None:
                self.env['WORKPARTNER_PUBLISHED_DIR'] = value
            before = {p.name: p.lstat().st_ino for p in self.data.iterdir()}
            result = self.run_hooks(published=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(old.read_text(), 'keep')
            self.assertEqual(os.readlink(link), 'missing')
            self.assertEqual({p.name: p.lstat().st_ino for p in self.data.iterdir()}, before)

    def test_failed_link_preserves_existing_directory_and_cleans_temporary_link(self):
        target = self.data / PUBLISHED[0]
        target.mkdir()
        self.write(target / 'keep', 'keep')
        self.write(self.hooks / '00-after.sh', 'echo after\n')
        result = self.run_hooks('echo ready')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('cannot link published file', result.stderr)
        self.assertIn('cannot link published file ' + PUBLISHED[0], result.stderr)
        self.assertTrue(target.is_dir())
        self.assertFalse(target.is_symlink())
        self.assertEqual((target / 'keep').read_text(), 'keep')
        self.assertEqual(list(self.data.glob('.wp-published.*')), [])
        for name in PUBLISHED[1:]:
            self.assertEqual(os.readlink(self.data / name), str(self.published / name))
        self.assertEqual(result.stdout, '[wp-init:00-after.sh] after\nready\n')

    def test_temporary_link_directory_failure_warns_and_continues(self):
        mktemp = shutil.which('mktemp')
        self.executable('mktemp', '''if [ "$1" = -d ] && [ ! -f "$FAILED_ONCE" ]; then
  touch "$FAILED_ONCE"
  exit 1
fi
exec ''' + shlex.quote(mktemp) + ' "$@"\n')
        self.env['FAILED_ONCE'] = str(self.root / 'failed-once')
        self.write(self.data / PUBLISHED[0], 'keep')
        result = self.run_hooks('echo ready')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('cannot link published file ' + PUBLISHED[0], result.stderr)
        self.assertEqual((self.data / PUBLISHED[0]).read_text(), 'keep')
        for name in PUBLISHED[1:]:
            self.assertTrue((self.data / name).is_symlink())
        self.assertEqual(list(self.data.glob('.wp-published.*')), [])
        self.assertEqual(result.stdout, 'ready\n')

    def test_hooks_are_sorted_isolated_prefixed_and_continue_after_failure(self):
        self.write(self.hooks / '20-last.sh', 'echo last\n')
        self.write(self.hooks / '10-fail.sh', 'echo failure >&2; exit 7\n')
        self.write(self.hooks / '00-first.sh', 'echo first; cd /; export HOOK_VALUE=changed\n')
        self.write(self.hooks / '15-partial.sh', "printf 'no newline'\n")
        self.env['HOOK_VALUE'] = 'original'
        result = self.run_hooks('printf "value=%s\\n" "$HOOK_VALUE"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            '[wp-init:00-first.sh] first', '[wp-init:10-fail.sh] failure',
            '[wp-init:15-partial.sh] no newline', '[wp-init:20-last.sh] last',
            'value=original'])
        self.assertIn('10-fail.sh exited with status 7; continuing', result.stderr)

    def test_unsafe_modes_owner_symlinks_and_nonregular_hooks_are_skipped(self):
        for name, mode in (('00-group.sh', 0o620), ('01-other.sh', 0o602),
                           ('02-owner.sh', 0o600), ('10-safe.sh', 0o640)):
            self.write(self.hooks / name, 'echo ' + name + '\n', mode)
        outside = self.write(self.root / 'outside.sh', 'echo unsafe\n')
        (self.hooks / '03-link.sh').symlink_to(outside)
        (self.hooks / '04-directory.sh').mkdir()
        os.mkfifo(self.hooks / '05-pipe.sh')
        (self.hooks / '06-dangling.sh').symlink_to('missing')
        stat = shutil.which('stat')
        self.executable('stat', '''if [[ "${@: -1}" == */02-owner.sh ]]; then
  printf '%s 600\\n' "$((EUID + 1))"
else
  exec ''' + shlex.quote(stat) + ' "$@"\nfi\n')
        result = self.run_hooks()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '[wp-init:10-safe.sh] 10-safe.sh\n')
        self.assertEqual(result.stderr.count('skipping'), 7)

    def test_failure_is_warned_without_pipefail_as_in_entrypoint(self):
        self.write(self.hooks / '00-fail.sh', 'exit 9\n')
        self.write(self.hooks / '01-after.sh', 'echo after\n')
        result = self.run_hooks('echo ready', strict=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '[wp-init:01-after.sh] after\nready\n')
        self.assertIn('00-fail.sh exited with status 9; continuing', result.stderr)

    def test_timeout_terminates_hooks_then_continues(self):
        timeout = shutil.which('timeout')
        self.executable('timeout', '''[ "$1" = --foreground ] && [ "$2" = --kill-after=5s ] && [ "$3" = 60s ] || exit 90
shift 3
exec ''' + shlex.quote(timeout) + ' --foreground --kill-after=0.2s 0.2s "$@"\n')
        self.write(self.hooks / '00-timeout.sh',
                   'trap \'echo terminated; exit 0\' TERM\nsleep 30 & wait\n')
        self.write(self.hooks / '01-stubborn.sh',
                   'trap "" TERM\nwhile :; do :; done\necho survived\n')
        self.write(self.hooks / '02-after.sh', 'echo after\n')
        result = self.run_hooks()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('[wp-init:00-timeout.sh] terminated', result.stdout)
        self.assertIn('00-timeout.sh exited with status 124', result.stderr)
        self.assertIn('01-stubborn.sh exited with status 137', result.stderr)
        self.assertIn('[wp-init:02-after.sh] after', result.stdout)
        self.assertNotIn('survived', result.stdout)

    def exercise_background_hook(self, command, ending=''):
        timeout = shutil.which('timeout')
        self.executable('timeout', '''[ "$1" = --foreground ] && [ "$2" = --kill-after=5s ] && [ "$3" = 60s ] || exit 90
shift 3
exec ''' + shlex.quote(timeout) + ' --foreground --kill-after=0.2s 1s "$@"\n')
        pid_file = self.root / 'background.pid'
        self.env['BACKGROUND_PID'] = str(pid_file)
        self.write(self.hooks / '00-background.sh',
                   command + '\necho "$!" > "$BACKGROUND_PID"\necho launched\n' + ending)
        self.write(self.hooks / '01-after.sh', 'echo after\n')
        started = time.monotonic()
        result = self.run_hooks('echo ready', timeout=4)
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '[wp-init:00-background.sh] launched\n'
                         '[wp-init:01-after.sh] after\nready\n')
        pid = int(pid_file.read_text())
        os.kill(pid, 0)
        self.assertNotEqual(Path(f'/proc/{pid}/stat').read_text().split()[2], 'Z')
        self.assertEqual(list(self.output.iterdir()), [])
        return result

    def test_inherited_background_output_does_not_delay_later_hooks(self):
        result = self.exercise_background_hook('sleep 30 &')
        self.assertEqual(result.stderr, '')

    def test_nohup_background_service_does_not_delay_later_hooks(self):
        result = self.exercise_background_hook('nohup sleep 30 >/dev/null 2>&1 &')
        self.assertEqual(result.stderr, '')

    def test_timeout_preserves_background_service_and_continues(self):
        result = self.exercise_background_hook('sleep 30 &', 'trap "" TERM\nwhile :; do :; done\n')
        self.assertIn('00-background.sh exited with status 137; continuing', result.stderr)

    def test_hook_locale_is_preserved_while_sorting_in_c_order(self):
        self.env['LC_ALL'] = 'C.UTF-8'
        for name in ('a', 'Z', 'A', '_'):
            self.write(self.hooks / (name + '.sh'), 'printf "%s\\n" "$LC_ALL"\n')
        result = self.run_hooks('printf "parent=%s\\n" "$LC_ALL"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            '[wp-init:A.sh] C.UTF-8', '[wp-init:Z.sh] C.UTF-8',
            '[wp-init:_.sh] C.UTF-8', '[wp-init:a.sh] C.UTF-8', 'parent=C.UTF-8'])

    def test_personal_bin_precedes_image_commands_for_hooks_and_services(self):
        self.executable('fixture-command', 'echo image\n')
        personal = self.hooks / 'bin'
        self.write(personal / 'fixture-command', '#!/bin/bash\necho personal\n', 0o700)
        self.write(self.hooks / '00-path.sh', 'fixture-command\n')
        result = self.run_hooks('fixture-command; printf "%s\\n" "$PATH"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            '[wp-init:00-path.sh] personal', 'personal', f'{personal}:{self.env["PATH"]}'])

    def test_absent_hook_directory_keeps_path_and_shell_options(self):
        self.hooks.rmdir()
        result = self.run_hooks('printf "%s\\n" "$PATH"; shopt -p nullglob || :', published=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [self.env['PATH'], 'shopt -u nullglob'])
        self.assertEqual(list(self.data.iterdir()), [])

    def wait_for(self, predicate, process):
        deadline = time.monotonic() + 5
        while not predicate():
            if process.poll() is not None or time.monotonic() >= deadline:
                self.fail('startup did not reach expected state')
            time.sleep(0.02)

    def test_startup_order_and_only_service_exits_end_the_entrypoint(self):
        for services, exiting in ((('aionui',), 'aionui'),
                                  (('aionui', 'bridge', 'relay'), 'bridge'),
                                  (('aionui', 'bridge', 'relay'), 'relay')):
            with self.subTest(services=services, exiting=exiting):
                self.exercise_startup(services, exiting)

    def test_startup_continues_after_published_link_failure(self):
        self.exercise_startup(('aionui', 'bridge', 'relay'), 'bridge', published=True)

    def exercise_startup(self, services, exiting, published=False):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            root = Path(temporary)
            data, app, ui, state = (root / name for name in ('data', 'app', 'ui', 'state'))
            for directory in (data, app, ui, state):
                directory.mkdir()
            self.write(data / 'model-key', 'fixture')
            if 'bridge' in services:
                self.write(data / '.cc-connect/config.toml', '')
            if 'relay' in services:
                self.write(data / '.zp-preview-relay-key', 'fixture')
            self.write(app / 'skills/fixture/SKILL.md', 'fixture')
            self.write(app / 'agent-baseline/install.sh', 'touch "$STATE/baseline"\n')
            helper = HELPER.read_text().replace('/data', str(data)) + '''
( sleep 0.2; touch "$STATE/auxiliary-exited"; exit 19 ) &
'''
            self.write(app / 'bin/wp-init-hooks.sh', helper)
            self.write(data / '.zp-init.d/00-order.sh', '''
[ -f "$STATE/baseline" ] || exit 91
[ -d "$HOME/srv" ] && [ ! -L "$HOME/srv" ] || exit 93
touch "$STATE/hooks"
''')
            service = '''#!/bin/bash
[ -f "$STATE/hooks" ] || exit 92
touch "$STATE/$SERVICE-ready"
while [ ! -e "$STATE/$SERVICE-exit" ]; do sleep 0.02; done
exit 23
'''
            self.write(ui / 'aionui-web', service.replace('$SERVICE', 'aionui'), 0o700)
            self.write(app / 'bin/cc-connect', service.replace('$SERVICE', 'bridge'), 0o700)
            self.executable('node', '''if [[ "$1" == */resolve.mjs ]]; then
  printf 'export PARTNER_MODEL_KEY_FILE=%q\\n' "$FIXTURE_DATA/model-key"
  echo 'export PARTNER_MODEL_KEY_ENV=ANTHROPIC_API_KEY ANTHROPIC_MODEL=fixture PARTNER_DEFAULT_EFFORT=medium PARTNER_CODEX_MODEL=fixture PARTNER_GATEWAY_ORIGIN=http://gateway.example.test'
else
  exec bash "$RELAY"
fi
''')
            relay = self.write(root / 'relay', service.replace('$SERVICE', 'relay'), 0o700)
            self.executable('python3', 'exit 0\n')
            self.executable('curl', 'exit 0\n')
            source = (ROOT / 'bin/start.sh').read_text()
            source = source.replace('/opt/workpartner', str(app)).replace('/opt/aionui', str(ui))
            source = source.replace('/tmp/aionui', str(root / 'uploads')).replace('/data', str(data))
            script = self.write(root / 'start.sh', source)
            env = dict(self.env, STATE=str(state), FIXTURE_DATA=str(data), RELAY=str(relay))
            if published:
                env['WORKPARTNER_PUBLISHED_DIR'] = str(self.published)
                for name in PUBLISHED:
                    self.write(self.published / name, 'fixture')
                self.write(data / PUBLISHED[0] / 'keep', 'keep')
            log = root / 'startup.log'
            with log.open('w') as output:
                process = subprocess.Popen(['bash', str(script)], env=env, stdout=output,
                                           stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    self.wait_for(lambda: all((state / (name + '-ready')).exists() for name in services), process)
                    self.wait_for(lambda: (state / 'auxiliary-exited').exists(), process)
                    time.sleep(0.1)
                    self.assertIsNone(process.poll(), log.read_text())
                    if published:
                        self.assertIn('cannot link published file ' + PUBLISHED[0], log.read_text())
                        self.assertEqual((data / PUBLISHED[0] / 'keep').read_text(), 'keep')
                        for name in PUBLISHED[1:]:
                            self.assertEqual(os.readlink(data / name), str(self.published / name))
                        self.assertEqual(list(data.glob('.wp-published.*')), [])
                    (state / (exiting + '-exit')).touch()
                    self.assertEqual(process.wait(timeout=5), 23, log.read_text())
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()

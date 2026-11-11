#!/usr/bin/env python3
import json, os, subprocess, sys, unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'no-blocking-foreground.py')


BRIDGE = dict(os.environ, CC_SESSION_KEY='feishu:fixture')
WEB = {k: v for k, v in os.environ.items() if k != 'CC_SESSION_KEY'}


def decision(tool, mode='bypassPermissions', env=BRIDGE, **ti):
    """返回 (exit code, 钩子输出的 JSON 或 None)；默认按消息桥会话运行。"""
    p = subprocess.run([sys.executable, HOOK], input=json.dumps({'tool_name': tool, 'tool_input': ti, 'permission_mode': mode}),
                       capture_output=True, text=True, env=env)
    return p.returncode, (json.loads(p.stdout) if p.stdout.strip() else None)


class T(unittest.TestCase):
    def test_non_bypass_denies(self):
        for mode in ('default', 'acceptEdits', 'plan', None):
            code, out = decision('Bash', mode=mode, command='docker build -t x .')
            self.assertEqual(code, 2, mode)
            self.assertIsNone(out, mode)
            code, out = decision('Agent', mode=mode, prompt='x', run_in_background=False)
            self.assertEqual(code, 2, mode)
        code, out = decision('Bash', mode='default', command='ls')
        self.assertEqual(code, 0)

    def ok(self, tool, **ti):
        code, out = decision(tool, **ti)
        self.assertEqual(code, 0, ti)
        self.assertIsNone(out, ti)

    def converted(self, tool, **ti):
        code, out = decision(tool, **ti)
        self.assertEqual(code, 0, ti)
        h = out['hookSpecificOutput']
        self.assertEqual(h['hookEventName'], 'PreToolUse')
        self.assertEqual(h['permissionDecision'], 'allow')
        self.assertEqual(h['updatedInput'], dict(ti, run_in_background=True), ti)
        self.assertIn('已自动转后台', h['permissionDecisionReason'])
        self.assertIn('已自动转后台', h['additionalContext'])

    def test_allow(self):
        self.ok('Bash', command='docker build -t x .', run_in_background=True)
        self.ok('Bash', command='ls -la /tmp')
        self.ok('Bash', command='timeout 60 go test ./...')
        self.ok('Bash', command='cd /x && timeout 120s npm test')
        self.ok('Bash', command='git commit -m "make docker build faster"')
        self.ok('Bash', command='ls', timeout=120000)
        self.ok('Agent', prompt='x')
        self.ok('Agent', prompt='x', run_in_background=True)
        self.ok('Read', file_path='/x')
        self.ok('Bash', command='grep -E "a|npm|make" f.txt')
        self.ok('Bash', command="cat >> log.md <<'EOF'\nnpm ci and make\nEOF")
        self.ok('Bash', command='git commit -m "run npm ci; make"')

    def test_convert(self):
        self.converted('Bash', command='docker build -t x .')
        self.converted('Bash', command='ls', timeout=600000)
        self.converted('Bash', command='cd /srv/app && FOO=1 npm ci', description='装依赖')
        self.converted('Bash', command='sudo apt-get install -y foo')
        self.converted('Bash', command='timeout 600 pytest')
        self.converted('Bash', command='docker compose up -d --build')
        self.converted('Bash', command='make -j4 && echo ok', run_in_background=False)
        self.converted('Bash', command='codex exec "x" </dev/null')
        self.converted('Bash', command='claude -p "hi"')
        self.converted('Bash', command='ffmpeg -i a.mp4 b.mp4')
        self.converted('Agent', prompt='x', run_in_background=False)
        self.converted('Task', prompt='x', description='d', run_in_background=False)

    def test_web_session_waits_in_the_same_turn(self):
        for mode in ('bypassPermissions', 'default'):
            for tool, ti in (('Bash', {'command': 'docker build -t x .'}), ('Bash', {'command': 'ls', 'timeout': 600000}),
                             ('Agent', {'prompt': 'x', 'run_in_background': False}),
                             ('Task', {'prompt': 'x', 'run_in_background': False})):
                self.assertEqual(decision(tool, mode=mode, env=WEB, **ti), (0, None), (mode, tool, ti))

    def test_broken_input_allows(self):
        p = subprocess.run([sys.executable, HOOK], input='not json', capture_output=True, text=True)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout, '')


if __name__ == '__main__':
    unittest.main()

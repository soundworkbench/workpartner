#!/usr/bin/env python3
import json, os, subprocess, sys, tempfile, unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'no-repeat-poll.py')
OUT = '/tmp/claude-1001/-x/sess/tasks/%s.output'


def user(text):
    return {'type': 'user', 'message': {'role': 'user', 'content': text}}


def notice(tid):
    return user('<task-notification>\n<task-id>%s</task-id>\n<status>completed</status>\n</task-notification>' % tid)


def result():
    return {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'content': 'x'}]}}


def use(name, uid='u', **ti):
    return {'type': 'assistant', 'message': {'role': 'assistant',
            'content': [{'type': 'tool_use', 'id': uid, 'name': name, 'input': ti}]}}


def read(tid, uid='u'):
    return use('Read', uid, file_path=OUT % tid)


def run(rows, tool, current_id='cur', **ti):
    with tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False) as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')
    try:
        p = subprocess.run([sys.executable, HOOK], capture_output=True, text=True, input=json.dumps(
            {'tool_name': tool, 'tool_input': ti, 'transcript_path': f.name, 'tool_use_id': current_id}))
    finally:
        os.unlink(f.name)
    return p.returncode, p.stderr


class T(unittest.TestCase):
    def test_third_read_denied(self):
        rows = [user('hi'), read('b1', 'a'), result(), read('b1', 'b'), result()]
        code, err = run(rows, 'Read', file_path=OUT % 'b1')
        self.assertEqual(code, 2)
        self.assertIn('不要再查', err)

    def test_second_read_allowed(self):
        rows = [user('hi'), read('b1', 'a'), result()]
        self.assertEqual(run(rows, 'Read', file_path=OUT % 'b1')[0], 0)

    def test_current_call_in_transcript_not_counted(self):
        rows = [user('hi'), read('b1', 'a'), result(), read('b1', 'cur')]
        self.assertEqual(run(rows, 'Read', file_path=OUT % 'b1')[0], 0)

    def test_other_task_not_counted(self):
        rows = [user('hi'), read('b1', 'a'), read('b1', 'b'), read('b1', 'c')]
        self.assertEqual(run(rows, 'Read', file_path=OUT % 'b2')[0], 0)

    def test_new_user_turn_resets(self):
        rows = [user('hi'), read('b1', 'a'), read('b1', 'b'), user('再说一句')]
        self.assertEqual(run(rows, 'Read', file_path=OUT % 'b1')[0], 0)

    def test_other_task_notice_does_not_reset(self):
        rows = [user('hi'), read('b1', 'a'), read('b1', 'b'), notice('zzz')]
        self.assertEqual(run(rows, 'Read', file_path=OUT % 'b1')[0], 2)

    def test_own_notice_allows(self):
        rows = [user('hi'), read('b1', 'a'), read('b1', 'b'), read('b1', 'c'), notice('b1')]
        self.assertEqual(run(rows, 'Read', file_path=OUT % 'b1')[0], 0)

    def test_tools_and_bash(self):
        rows = [user('hi'), use('TaskOutput', 'a', task_id='t9'), use('BashOutput', 'b', bash_id='t9')]
        self.assertEqual(run(rows, 'TaskOutput', task_id='t9')[0], 2)
        self.assertEqual(run(rows, 'BashOutput', bash_id='t9')[0], 2)
        self.assertEqual(run(rows, 'TaskOutput', task_id='other')[0], 0)
        rows = [user('hi'), read('t9', 'a'), use('Bash', 'b', command='tail -n 20 ' + OUT % 't9')]
        self.assertEqual(run(rows, 'Bash', command='cat ' + OUT % 't9')[0], 2)

    def test_unrelated_tools_allowed(self):
        rows = [user('hi')] + [read('b1', str(i)) for i in range(5)]
        self.assertEqual(run(rows, 'Read', file_path='/etc/hosts')[0], 0)
        self.assertEqual(run(rows, 'Bash', command='ls /tmp')[0], 0)

    def test_broken_input_allows(self):
        p = subprocess.run([sys.executable, HOOK], input='not json', capture_output=True, text=True)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(run([], 'Read', file_path=OUT % 'b1')[0], 0)
        p = subprocess.run([sys.executable, HOOK], capture_output=True, text=True, input=json.dumps(
            {'tool_name': 'Read', 'tool_input': {'file_path': OUT % 'b1'}, 'transcript_path': '/nonexistent'}))
        self.assertEqual(p.returncode, 0)


if __name__ == '__main__':
    unittest.main()

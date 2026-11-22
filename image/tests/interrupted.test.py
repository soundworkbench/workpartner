"""网页对话中断提示：按命令边界在 AionUi 结构的临时库上验证，只对进行中被杀的对话加一行。"""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'bin/wp-interrupted.py'
SCHEMA = """
CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, msg_id TEXT, type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '{}', position TEXT CHECK(position IN ('left', 'right', 'center', 'pop')),
  status TEXT CHECK(status IN ('finish', 'pending', 'error', 'work')), hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, backend_turn_id TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
"""


class Interrupted(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Path(temp.name) / 'aionui-backend.db'
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            conn.executemany('INSERT INTO conversations VALUES (?, ?, ?)',
                             [('busy', 'u', 'mid-turn'), ('done', 'u', 'finished'), ('asked', 'u', 'only asked')])
            self.rows(conn, [
                ('busy', 'text', 'right', 'finish', '{"content":"hi"}', 1),
                ('busy', 'thinking', 'left', 'work', '{"content":"..."}', 2),
                ('busy', 'tool_call', 'left', 'work', '{"status":"running"}', 3),
                ('busy', 'text', 'left', 'pending', '{"content":""}', 4),
                ('done', 'text', 'right', 'finish', '{"content":"hi"}', 1),
                ('done', 'text', 'left', 'finish', '{"content":"hello"}', 2),
                ('asked', 'text', 'right', 'work', '{"content":"user row"}', 5),
            ])

    def connect(self):
        return sqlite3.connect(self.db)

    def rows(self, conn, rows):
        conn.executemany(
            'INSERT INTO messages (id, conversation_id, type, position, status, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [(f'{r[0]}-{r[5]}-{r[1]}', *r) for r in rows])

    def run_script(self, db=None):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), str(db or self.db)], capture_output=True, text=True, check=True)

    def tips(self):
        with self.connect() as conn:
            return conn.execute(
                "SELECT conversation_id, content, position, status, hidden, created_at FROM messages WHERE type = 'tips' ORDER BY created_at").fetchall()

    def test_one_line_per_interrupted_conversation_only(self):
        result = self.run_script()
        self.assertIn('1 个网页对话', result.stderr)
        [(conversation, content, position, status, hidden, created)] = self.tips()
        self.assertEqual(conversation, 'busy')
        self.assertEqual((position, status, hidden), ('center', 'finish', 0))
        body = json.loads(content)
        self.assertEqual(body['type'], 'warning')
        self.assertIn('被中断', body['content'])
        self.assertGreater(created, 4)

    def test_repeat_start_before_backend_settles_adds_nothing(self):
        self.run_script()
        result = self.run_script()
        self.assertEqual(result.stderr, '')
        self.assertEqual(len(self.tips()), 1)

    def test_settled_conversation_is_quiet_and_a_later_cut_gets_a_new_line(self):
        self.run_script()
        with self.connect() as conn:
            conn.execute("UPDATE messages SET status = 'finish' WHERE status IN ('work', 'pending') AND position = 'left'")
        self.assertEqual(self.run_script().stderr, '')
        later = self.tips()[0][5] + 10
        with self.connect() as conn:
            self.rows(conn, [('busy', 'text', 'left', 'work', '{"content":"partial"}', later)])
        self.run_script()
        self.assertEqual([t[0] for t in self.tips()], ['busy', 'busy'])

    def test_clean_state_and_first_start_are_quiet(self):
        with self.connect() as conn:
            conn.execute("UPDATE messages SET status = 'finish'")
        self.assertEqual(self.run_script().stderr, '')
        self.assertEqual(self.tips(), [])
        missing = self.db.with_name('none.db')
        self.assertEqual(self.run_script(missing).stderr, '')
        self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()

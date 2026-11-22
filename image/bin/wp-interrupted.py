"""网页对话：上次进程退出时还在回复的对话，各加一行“被中断”提示。
容器启动、AionUi 起来之前运行：python3 -I wp-interrupted.py /data/aionui-data/aionui-backend.db 。
判断条件和 AionUi 后端启动时收尾残留回复的条件一致（左侧、work/pending、文字/思考/工具行）：
这些行只在回复进行中、进程被杀时才留下，正常结束或无人对话时重启不会有。
后端随后会把残留行收尾；如果它没来得及收尾就再次退出，已加过提示的对话不重复加。
数据库不存在或读写失败时只打印警告，不影响启动。"""
import json
import secrets
import sqlite3
import sys
import time

TEXT = '上一轮回复因重启被中断，没有完成。需要的话请再发一次。'
SOURCE = 'restart_interrupted'
STALE = ("m.position = 'left' AND m.status IN ('work', 'pending') "
         "AND m.type IN ('text', 'thinking', 'tool_call', 'tool_group')")


def mark(db):
    conn = sqlite3.connect(f'file:{db}?mode=rw', uri=True, timeout=10)
    try:
        with conn:
            rows = conn.execute(
                f'SELECT m.conversation_id, MAX(m.created_at) FROM messages m '
                f'JOIN conversations c ON c.id = m.conversation_id WHERE {STALE} GROUP BY m.conversation_id').fetchall()
            added = 0
            now = int(time.time() * 1000)
            for conversation, last in rows:
                noted = conn.execute(
                    "SELECT 1 FROM messages WHERE conversation_id = ? AND type = 'tips' AND created_at >= ? "
                    "AND json_extract(content, '$.source') = ?", (conversation, last, SOURCE)).fetchone()
                if noted:
                    continue
                content = json.dumps({'content': TEXT, 'type': 'warning', 'source': SOURCE}, ensure_ascii=False)
                conn.execute(
                    'INSERT INTO messages (id, conversation_id, type, content, position, status, hidden, created_at) '
                    "VALUES (?, ?, 'tips', ?, 'center', 'finish', 0, ?)",
                    (secrets.token_hex(4), conversation, content, max(now, last + 1)))
                added += 1
        return added
    finally:
        conn.close()


def main():
    db = sys.argv[1]
    try:
        added = mark(db)
    except sqlite3.OperationalError as error:
        if 'unable to open' in str(error):
            return  # 第一次启动，还没有网页对话
        print(f'警告：未检查被中断的网页对话（{error}），继续启动', file=sys.stderr)
        return
    except sqlite3.Error as error:
        print(f'警告：未检查被中断的网页对话（{error}），继续启动', file=sys.stderr)
        return
    if added:
        print(f'[startup] {added} 个网页对话的上一轮回复被重启中断，已加提示', file=sys.stderr)


if __name__ == '__main__':
    main()

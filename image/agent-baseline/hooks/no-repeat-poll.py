#!/usr/bin/env python3
"""拦截反复查后台任务进度（后台任务结束会自动通知，不用轮询）。
同一回合（自最近一条真正的用户消息起）里，对同一个后台任务的读取已有 2 次，第 3 次起拒绝。
读取指：TaskOutput / BashOutput 工具（task_id、bash_id、shell_id），
Read 或 Bash（cat、tail 等）访问 `.../tasks/<任务号>.output` 这类输出文件。
该任务的完成通知已经到达（transcript 里有对应 <task-notification>）后的读取不拦。
钩子自身出错、读不到 transcript 都放行。
只在消息桥会话（环境里有 CC_SESSION_KEY）生效：网页会话没有完成通知，要在同一轮里查到完成为止。"""
import json, os, re, sys

MAX_READS = 2
TAIL_BYTES = 4 * 1024 * 1024
_OUT = re.compile(r'/tasks/([A-Za-z0-9_-]+)\.output\b')
ID_KEYS = ('task_id', 'bash_id', 'shell_id')
HINT = '完成会自动通知，先回复用户，不要再查；收到完成通知后再读结果。'


def task_id_of(name, ti):
    """这次工具调用读取的是哪个后台任务；不是读取返回 None。"""
    if not isinstance(ti, dict):
        return None
    if name in ('TaskOutput', 'BashOutput'):
        for k in ID_KEYS:
            if isinstance(ti.get(k), str) and ti[k]:
                return ti[k]
        return None
    if name == 'Read':
        m = _OUT.search(str(ti.get('file_path') or ''))
        return m.group(1) if m else None
    if name == 'Bash':
        m = _OUT.search(str(ti.get('command') or ''))
        return m.group(1) if m else None
    return None


def tail_lines(path):
    try:
        with open(path, 'rb') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            return f.read().decode('utf-8', 'replace').splitlines()
    except OSError:
        return None


def user_text(row):
    """真正的用户文字（含完成通知）；工具结果返回 None。"""
    content = (row.get('message') or {}).get('content')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [x.get('text', '') for x in content if isinstance(x, dict) and x.get('type') == 'text']
        return '\n'.join(texts) if texts else None
    return None


def prior_reads(lines, tid, current_use_id):
    """返回（本回合已有读取次数, 完成通知是否已到达）。从后往前数到最近一条真正的用户消息为止。"""
    count, notified, in_turn = 0, False, True
    marker = f'<task-id>{tid}</task-id>'
    for line in reversed(lines):
        if marker in line and 'task-notification' in line and '"type":"tool_use"' not in line:
            if '"type":"user"' in line or '"type": "user"' in line:
                notified = True
        if not in_turn:
            if notified:
                break
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        t = row.get('type')
        if t == 'user' and not row.get('isMeta'):
            text = user_text(row)
            if text is not None and not text.lstrip().startswith('<task-notification>'):
                in_turn = False
            continue
        if t != 'assistant':
            continue
        content = (row.get('message') or {}).get('content')
        for x in content if isinstance(content, list) else []:
            if not (isinstance(x, dict) and x.get('type') == 'tool_use'):
                continue
            if current_use_id and x.get('id') == current_use_id:
                continue
            if task_id_of(x.get('name'), x.get('input')) == tid:
                count += 1
    return count, notified


def main():
    if not os.environ.get('CC_SESSION_KEY'):
        return 0
    d = json.load(sys.stdin)
    tid = task_id_of(d.get('tool_name'), d.get('tool_input'))
    if not tid:
        return 0
    lines = tail_lines(d.get('transcript_path') or '')
    if lines is None:
        return 0
    count, notified = prior_reads(lines, tid, d.get('tool_use_id'))
    if notified or count < MAX_READS:
        return 0
    print(f'拒绝：本回合已查看后台任务 {tid} 的输出 {count} 次，它还没发完成通知。' + HINT, file=sys.stderr)
    return 2


if __name__ == '__main__':
    try:
        code = main()
    except Exception:
        code = 0
    sys.exit(code)

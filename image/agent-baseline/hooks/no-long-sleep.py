#!/usr/bin/env python3
"""拦截会话里的长等待（不在会话里 sleep 等后台任务）。
- 单条 Bash 命令里 sleep 超过 60 秒：拒绝。
- 多次短 sleep 能绕过单次上限，所以同一回合（自最近一条真正的用户消息起）累计 sleep 超过 300 秒也拒绝。
  循环里的 sleep 按次数估算：能从 seq 看出次数就按次数乘；while/until 等看不出次数的按 300 秒计。
消息桥会话（环境里有 CC_SESSION_KEY）提示改用后台运行，完成会唤醒会话；
网页会话没有完成通知，提示在前台运行并设好超时，同一轮里等完再答复。"""
import json, os, re, sys
from pathlib import Path

PER_CALL, PER_TURN = 60, 300
d = json.load(sys.stdin)
ti = d.get('tool_input') or {}
if ti.get('run_in_background') is True:
    sys.exit(0)
_HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n.*?\n\s*\1\s*(?=\n|$)", re.S)
_QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
cmd = _QUOTED.sub("''", _HEREDOC.sub('<<HEREDOC', ti.get('command', '') or ''))
sleeps = [int(x) for x in re.findall(r'\bsleep\s+(\d+)', cmd)]
if not sleeps:
    sys.exit(0)
if os.environ.get('CC_SESSION_KEY'):
    hint = '要等的事改用后台运行（run_in_background: true），跑完会自动通知；先回复用户。'
else:
    hint = '要等的命令在前台运行并设好超时，子代理在前台运行；同一轮里等完再给最终答复。'
for s in sleeps:
    if s > PER_CALL:
        print(f'拒绝：会话里不要等待超过 {PER_CALL} 秒（sleep {s}）。' + hint, file=sys.stderr)
        sys.exit(2)

# 估算本条命令的等待秒数
estimate = sum(sleeps)
if re.search(r'\b(for|while|until)\b', cmd):
    seqs = [int(x) for x in re.findall(r'\bseq\s+(?:\d+\s+)?(\d+)', cmd)]
    if seqs:
        estimate = sum(sleeps) * max(seqs)
    elif re.search(r'\b(while|until)\b', cmd):
        estimate = max(estimate, PER_TURN)


def turn_key(transcript):
    """最近一条真正的用户消息（不是工具结果）的 uuid，作为本回合标识。只读文件末尾 4MB。"""
    try:
        with open(transcript, 'rb') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 4 * 1024 * 1024))
            lines = f.read().decode('utf-8', 'replace').splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if '"type":"user"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        content = (row.get('message') or {}).get('content')
        if isinstance(content, str) or (isinstance(content, list) and any(
                isinstance(x, dict) and x.get('type') == 'text' for x in content)):
            return row.get('uuid')
    return None


state_dir = Path.home() / '.local/state/no-long-sleep'
session = re.sub(r'[^A-Za-z0-9_-]', '', str(d.get('session_id') or 'unknown'))[:80]
state_file = state_dir / (session + '.json')
key = turn_key(d.get('transcript_path') or '')
try:
    state = json.loads(state_file.read_text())
except (OSError, ValueError):
    state = {}
if state.get('turn') != key:
    state = {'turn': key, 'total': 0}
if state['total'] + estimate > PER_TURN:
    print(f'拒绝：本回合累计等待将达 {state["total"] + estimate} 秒，超过 {PER_TURN} 秒（多次短 sleep 也算）。' + hint, file=sys.stderr)
    sys.exit(2)
state['total'] += estimate
try:
    state_dir.mkdir(parents=True, exist_ok=True)
    tmp = state_file.with_suffix('.tmp')
    tmp.write_text(json.dumps(state))
    tmp.replace(state_file)
except OSError:
    pass
sys.exit(0)

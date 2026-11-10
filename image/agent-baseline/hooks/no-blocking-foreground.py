#!/usr/bin/env python3
"""把会堵住会话的前台调用自动转成后台。
一轮里在前台跑长命令或前台等子代理，用户这段时间收不到回复。
- 只在 permission_mode 为 bypassPermissions 时改写成后台并放行（不会因此少掉确认）；
  其他权限模式维持拒绝，并提示加 run_in_background: true。
- Bash：run_in_background 为 true 放行；否则 timeout 参数超过 180000 毫秒，
  或命令命中 SLOW_PATTERNS，就用 PreToolUse 的 updatedInput 加上 run_in_background: true
  并放行（Claude Code 2.1.319 实测生效）。命令带 `timeout N`（N<=120 秒）视为有上限，不动。
- Agent|Task：run_in_background 明确为 false 时同样转后台；不写或为 true 不动。
- 其他一律放行；钩子自身出错也放行。"""
import json, re, sys

MAX_TIMEOUT_MS = 180000
MAX_BOUNDED_SEC = 120

# 规则表：命令（单段，已去掉 sudo、环境变量前缀、timeout 前缀）开头匹配即视为“会跑很久”。
SLOW_PATTERNS = [
    r'docker(-|\s+)compose\s+up\b.*--build',
    r'docker\s+build\b',
    r'docker\s+buildx\s+build\b',
    r'docker\s+pull\b',
    r'go\s+(build|test)\b',
    r'(npm|pnpm|yarn)\s+(install|i|ci|build|test|run\s+(build|test))\b',
    r'(npm|pnpm|yarn)\s*$',          # 裸 yarn / pnpm 即 install
    r'npx\s+(-\S+\s+)*playwright\b',
    r'(python3?\s+-m\s+)?pytest\b',
    r'cargo\s+(build|test)\b',
    r'make\b',
    r'mvn\b',
    r'gradlew?\b',
    r'(\./)?gradlew\b',
    r'apt(-get)?\s+(\S+\s+)*install\b',
    r'(pip3?|python3?\s+-m\s+pip)\s+install\b',
    r'git\s+clone\b',
    r'codex\s+exec\b',
    r'claude\s+(.*\s)?-p\b',
    r'(npx\s+)?hyperframes\s+render\b',
    r'ffmpeg\b',
]
_SLOW = [re.compile(p) for p in SLOW_PATTERNS]
_PREFIX = re.compile(r'^(?:(?:sudo(?:\s+-\S+)*|nohup|time|nice(?:\s+-n\s+\d+)?|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)+')
_TIMEOUT = re.compile(r'^timeout\s+(?:-\S+\s+)*(\d+(?:\.\d+)?)([smh]?)\s+')

NOTE = ('已自动转后台：{why}完成时会自动通知，不要 sleep 或反复查进度；先回复用户，'
        '收到完成通知后再读结果。')
DENY = ('拒绝：{why}请加 run_in_background: true 放到后台，完成时会自动通知；'
        '先回复用户，收到完成通知后再读结果。')

_HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n.*?\n\s*\1\s*(?=\n|$)", re.S)
_QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")


def strip_literals(cmd):
    """去掉 heredoc 正文和引号内文字：其中的 npm、make 等是数据，不是要执行的命令。"""
    cmd = _HEREDOC.sub('<<HEREDOC', cmd)
    return _QUOTED.sub("''", cmd)


def bounded_seconds(m):
    n = float(m.group(1))
    return n * {'': 1, 's': 1, 'm': 60, 'h': 3600}[m.group(2)]


def check_bash(ti):
    if ti.get('run_in_background') is True:
        return None
    t = ti.get('timeout')
    if isinstance(t, (int, float)) and not isinstance(t, bool) and t > MAX_TIMEOUT_MS:
        return f'前台 Bash 的 timeout={int(t)} 毫秒，超过 {MAX_TIMEOUT_MS} 毫秒。'
    cmd = strip_literals(ti.get('command') or '')
    for seg in re.split(r'&&|\|\||[;|\n]', cmd):
        seg = seg.strip().lstrip('(').strip()
        seg = _PREFIX.sub('', seg)
        m = _TIMEOUT.match(seg)
        if m:
            if bounded_seconds(m) <= MAX_BOUNDED_SEC:
                continue
            seg = seg[m.end():]
            seg = _PREFIX.sub('', seg)
        for rx in _SLOW:
            if rx.match(seg):
                return f'前台命令“{seg[:60]}”通常要跑很久。'
    return None


def check_agent(ti):
    if ti.get('run_in_background') is False:
        return '前台子代理会让会话一直等到它结束。'
    return None


def main():
    d = json.load(sys.stdin)
    ti = d.get('tool_input') or {}
    name = d.get('tool_name') or ''
    if name == 'Bash':
        why = check_bash(ti)
    elif name in ('Agent', 'Task'):
        why = check_agent(ti)
    else:
        why = None
    if why and d.get('permission_mode') != 'bypassPermissions':
        print(DENY.format(why=why), file=sys.stderr)
        return 2
    if why:
        ti = dict(ti)
        ti['run_in_background'] = True
        note = NOTE.format(why=why)
        print(json.dumps({'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'permissionDecisionReason': note,
            'updatedInput': ti,
            'additionalContext': note}}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        code = main()
    except Exception:
        code = 0
    sys.exit(code)

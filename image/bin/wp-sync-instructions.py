"""从镜像模板同步公司统一说明，块外内容逐字节保留；已有 AGENTS.md 不动。"""

import json
import os
from pathlib import Path
import stat
import sys
import tempfile

BEGIN = b'<!-- workpartner:company-instructions:begin -->'
END = b'<!-- workpartner:company-instructions:end -->'


def block_span(content):
    """返回唯一完整标记块的位置；无标记返回 None，残缺或重复标记拒绝写入。"""
    if BEGIN not in content and END not in content:
        return None
    if content.count(BEGIN) != 1 or content.count(END) != 1:
        raise ValueError('公司统一说明标记残缺或重复，未修改说明文件')
    start = content.index(BEGIN)
    stop = content.index(END) + len(END)
    if start >= content.index(END):
        raise ValueError('公司统一说明标记顺序错误，未修改说明文件')
    return start, stop


def sync(template, workspace, name):
    """首次或原样旧模板整份更新；个人说明只同步标记块，无块则追加一次。"""
    source = template.read_bytes()
    span = block_span(source)
    if span is None:
        raise ValueError('镜像模板缺少公司统一说明块，未修改说明文件')
    block = source[span[0]:span[1]]
    if b'__NAME__' in block:
        raise ValueError('公司统一说明块不能包含姓名占位符')

    # 跟随本人已有的 CLAUDE.md 软链，不把软链替换为普通文件。
    target = (workspace / 'CLAUDE.md').resolve()
    current = target.read_bytes() if target.exists() else None
    personalized = source.replace(b'__NAME__', name.encode('utf-8'))
    if current is None:
        updated = personalized
    else:
        span = block_span(current)
        if span is None:
            # 清单保存主分支已发布的原文；逐字节匹配，不能归一化本人改动。
            versions = json.loads(Path(__file__).with_name('legacy-instructions.json').read_bytes())
            if any(current == version['template'].replace('__NAME__', name).encode('utf-8')
                   for version in versions):
                updated = personalized
            else:
                separator = b'\n' if not current or current.endswith(b'\n') else b'\n\n'
                updated = current + separator + block + b'\n'
        else:
            updated = current[:span[0]] + block + current[span[1]:]

    if updated != current:
        # 同目录替换避免中途退出留下半份说明；保留已有文件权限。
        mode = stat.S_IMODE(target.stat().st_mode) if current is not None else 0o644
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as pending:
            pending_path = Path(pending.name)
            try:
                pending.write(updated)
                pending.flush()
                os.fchmod(pending.fileno(), mode)
                os.replace(pending_path, target)
            finally:
                pending_path.unlink(missing_ok=True)

    agents = workspace / 'AGENTS.md'
    if not agents.exists() and not agents.is_symlink():
        agents.symlink_to('CLAUDE.md')


if __name__ == '__main__':
    try:
        sync(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
    except (OSError, ValueError) as error:
        sys.exit(f'同步公司统一说明失败：{error}')

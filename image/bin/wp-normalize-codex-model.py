"""校正早期 Codex 模型名、补齐原生搜索开关，保留其他配置、注释和文件权限。"""

import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import tomllib


MODELS = {
    'codex/gpt-6.1-sol': 'gpt-6.1-sol',
    'codex/gpt-6.1-terra': 'gpt-6.1-terra',
}
ASSIGNMENT = re.compile(
    rb'''(?m)^[ \t]*(?:model|"model"|'model')[ \t]*=[ \t]*(["'])(codex/gpt-6\.1-(?:sol|terra))\1'''
)
TABLE_HEADER = re.compile(rb'(?m)^[ \t]*\[(?!\[)[^\r\n]*(?:\r?\n|$)')
SEARCH_KEY = 'supports_standalone_web_search'


def enable_web_search(source, config):
    """只为组织选择的提供方补缺失开关；解析比对排除其他表和多行字符串示例。"""
    providers = config.get('model_providers', {})
    provider_name = os.environ.get('PARTNER_CODEX_PROVIDER', '')
    provider = providers.get(provider_name)
    if provider is None or SEARCH_KEY in provider:
        return source
    expected = dict(config, model_providers=dict(providers, **{provider_name: dict(provider, **{SEARCH_KEY: True})}))
    candidates = []
    for match in TABLE_HEADER.finditer(source):
        newline = b'\r\n' if match[0].endswith(b'\r\n') else b'\n'
        addition = (b'' if match[0].endswith(b'\n') else newline) + SEARCH_KEY.encode() + b' = true' + newline
        updated = source[:match.end()] + addition + source[match.end():]
        try:
            parsed = tomllib.loads(updated.decode('utf-8'))
        except ValueError:
            # 其他表中的同名键可能导致重复；该位置不属于目标表。
            continue
        if parsed == expected:
            candidates.append(updated)
    if len(candidates) != 1:
        raise ValueError('无法唯一定位组织提供方配置表')
    return candidates[0]


def normalize(path):
    """仅改已知旧模型名和缺失搜索开关；无需更新不写盘，失败不改原件。"""
    target = path.resolve(strict=True)
    source = target.read_bytes()
    config = tomllib.loads(source.decode('utf-8'))
    model = MODELS.get(config.get('model'))
    updated = source
    if model is not None:
        expected = dict(config, model=model)
        candidates = []
        for match in ASSIGNMENT.finditer(source):
            candidate = source[:match.start(2)] + model.encode() + source[match.end(2):]
            # 解析比对避免误改同名表字段或多行字符串里的示例。
            if tomllib.loads(candidate.decode('utf-8')) == expected:
                candidates.append(candidate)
        if len(candidates) != 1:
            raise ValueError('无法唯一定位旧模型配置')
        updated = candidates[0]
        config = expected
    updated = enable_web_search(updated, config)
    if updated == source:
        return False
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as pending:
        pending_path = Path(pending.name)
        try:
            pending.write(updated)
            pending.flush()
            os.fchmod(pending.fileno(), stat.S_IMODE(target.stat().st_mode))
            os.replace(pending_path, target)
        finally:
            pending_path.unlink(missing_ok=True)
    return True


if __name__ == '__main__':
    try:
        if normalize(Path(sys.argv[1])):
            print('已更新 Codex 模型名或原生网页搜索配置')
    except (OSError, ValueError) as error:
        sys.exit(f'无法更新 Codex 配置（{type(error).__name__}），原件未改动')

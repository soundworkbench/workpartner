#!/usr/bin/env python3
"""Update owned MCP entries, preserving personal bytes outside the managed entries."""
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import tomllib

BEGIN = '# BEGIN WORKPARTNER MCP'
END = '# END WORKPARTNER MCP'
OWNER = '_workpartnerMcp'


def members(text):
    """Property value spans of a validated JSON object (including nested values)."""
    decoder = json.JSONDecoder()
    at = text.index('{') + 1
    rows = []
    while True:
        while text[at].isspace():
            at += 1
        if text[at] == '}':
            return rows, at
        start = at
        key, at = decoder.raw_decode(text, at)
        while text[at].isspace() or text[at] == ':':
            at += 1
        value_start = at
        _, at = decoder.raw_decode(text, at)
        rows.append((key, start, value_start, at))
        while text[at].isspace():
            at += 1
        if text[at] == ',':
            at += 1


def property_value(text, key, value):
    rows, close = members(text)
    match = next((row for row in rows if row[0] == key), None)
    if match:
        _, start, val, end = match
        if value is not None:
            return text[:val] + value + text[end:]
        index = rows.index(match)
        if index + 1 < len(rows):
            end = text.index(',', end) + 1
        elif index:
            start = text.rfind(',', rows[index - 1][3], start)  # comma preceding this property
        return text[:start] + text[end:]
    if value is None:
        return text
    # Keep every existing property byte; only add a comma and the managed entry.
    insert = (',' if rows else '') + '\n  ' + json.dumps(key) + ': ' + value + '\n'
    at = rows[-1][3] if rows else close
    return text[:at] + insert + text[at:]


def update_claude(text, configs):
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get('mcpServers', {}), dict):
        raise ValueError('Invalid personal MCP configuration')
    servers = data.get('mcpServers', {})
    owner = data.get(OWNER, {})
    if not isinstance(owner, dict):
        raise ValueError('Invalid ownership record')
    owned = owner.get('names', [owner['name']] if owner.get('name') else [])
    if not isinstance(owned, list) or not all(isinstance(name, str) for name in owned):
        raise ValueError('Invalid ownership record')
    names = [config['name'] for config in configs]
    if any(not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+', name) for name in names):
        raise ValueError('Invalid managed MCP name')
    if len(set(names)) != len(names):
        raise ValueError('Duplicate managed MCP name')
    for name in names:
        if name in servers and name not in owned:
            raise ValueError('Personal MCP name collision')
    rows, _ = members(text)
    span = next((row for row in rows if row[0] == 'mcpServers'), None)
    server_text = text[span[2]:span[3]] if span else '{}'
    for name in owned:
        if name not in names:
            server_text = property_value(server_text, name, None)
    for config in configs:
        script = config.get('headerScript', 'wp-mcp-headers.py')
        if script not in ('wp-mcp-headers.py', 'wp-desktop-mcp-headers.py'):
            raise ValueError('Unsupported header helper')
        helper = 'python3 -I ' + shlex.quote(str(Path(__file__).with_name(script).resolve()))
        if script == 'wp-mcp-headers.py':
            environment = config['keyEnvironment']
            if not re.fullmatch(r'[A-Z_][A-Z0-9_]*', environment):
                raise ValueError('Invalid header environment')
            helper += ' ' + environment
        entry = {'type': 'http', 'url': config['url'], 'headersHelper': helper, 'alwaysLoad': True}
        server_text = property_value(server_text, config['name'], json.dumps(entry, ensure_ascii=False))
    if span or configs:
        text = property_value(text, 'mcpServers', server_text)
    text = property_value(text, OWNER, json.dumps({'names': names}) if configs else None)
    json.loads(text)
    return text


def update_codex(text, configs):
    pattern = re.compile(r'\n' + re.escape(BEGIN) + r'\n.*?\n' + re.escape(END) + r'\n', re.S)
    clean = pattern.sub('', text)
    if BEGIN in clean or END in clean:
        raise ValueError('Incomplete MCP marker block')
    personal = tomllib.loads(clean)
    blocks = []
    for config in configs:
        name = config['name']
        if name in personal.get('mcp_servers', {}):
            raise ValueError('Personal MCP name collision')
        blocks.append(f'[mcp_servers.{name}]\nurl = {json.dumps(config["url"])}\n'
                      f'bearer_token_env_var = {json.dumps(config["keyEnvironment"])}\n')
    if blocks:
        clean += f'\n{BEGIN}\n' + ''.join(blocks) + f'{END}\n'
    tomllib.loads(clean)
    return clean


def replace(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    options = json.load(sys.stdin)
    home = Path(options['home'])
    codex = home / '.codex/config.toml'
    claude = home / '.claude.json'
    configs = options.get('configs')
    if configs is None:
        configs = [options['config']] if options.get('enabled') else []
    # Desktop uses dynamic file headers, unsupported by Codex at this stage.
    codex_configs = [config for config in configs if config.get('headerScript') != 'wp-desktop-mcp-headers.py']
    updates = []
    for path, default in [(codex, ''), (claude, '{}\n')]:
        if path.exists():
            with path.open(encoding='utf-8', newline='') as stream:
                before = stream.read()
        else:
            before = default
        after = update_claude(before, configs) if path == claude else update_codex(before, codex_configs)
        if after != before:
            updates.append((path, after))
    # Parse and detect collisions in both engines before changing either file.
    for path, after in updates:
        replace(path, after)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # A malformed personal file could contain credentials. Never echo it or a parser error.
        print('Managed MCP update failed; personal configuration needs review.', file=sys.stderr)
        sys.exit(1)

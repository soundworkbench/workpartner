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


def update_claude(text, config, enabled):
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get('mcpServers', {}), dict):
        raise ValueError('Invalid personal MCP configuration')
    servers = data.get('mcpServers', {})
    owned = data.get(OWNER, {}).get('name')
    name = config['name'] if config else None
    if enabled and name in servers and name != owned:
        raise ValueError('Personal MCP name collision')
    rows, _ = members(text)
    span = next((row for row in rows if row[0] == 'mcpServers'), None)
    server_text = text[span[2]:span[3]] if span else '{}'
    if owned and (not enabled or owned != name):
        server_text = property_value(server_text, owned, None)
    if enabled:
        helper = 'python3 -I ' + shlex.quote(str(Path(__file__).with_name('wp-mcp-headers.py').resolve())) + ' ' + config['keyEnvironment']
        entry = {'type': 'http', 'url': config['url'], 'headersHelper': helper, 'alwaysLoad': True}
        server_text = property_value(server_text, name, json.dumps(entry, ensure_ascii=False))
    if span or enabled:
        text = property_value(text, 'mcpServers', server_text)
    text = property_value(text, OWNER, json.dumps({'name': name}) if enabled else None)
    json.loads(text)
    return text


def update_codex(text, config, enabled):
    pattern = re.compile(r'\n' + re.escape(BEGIN) + r'\n.*?\n' + re.escape(END) + r'\n', re.S)
    clean = pattern.sub('', text)
    if BEGIN in clean or END in clean:
        raise ValueError('Incomplete MCP marker block')
    personal = tomllib.loads(clean)
    if enabled:
        name = config['name']
        if name in personal.get('mcp_servers', {}):
            raise ValueError('Personal MCP name collision')
        block = (f'\n{BEGIN}\n[mcp_servers.{name}]\nurl = {json.dumps(config["url"])}\n'
                 f'bearer_token_env_var = {json.dumps(config["keyEnvironment"])}\n{END}\n')
        clean += block
    tomllib.loads(clean)
    return clean


def replace(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    options = json.load(sys.stdin)
    home = Path(options['home'])
    codex = home / '.codex/config.toml'
    claude = home / '.claude.json'
    updates = []
    for path, default, update in [(codex, '', update_codex), (claude, '{}\n', update_claude)]:
        before = path.read_text() if path.exists() else default
        after = update(before, options.get('config'), options['enabled'])
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

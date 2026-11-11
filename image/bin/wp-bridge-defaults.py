#!/usr/bin/env python3
"""Migrate only managed bridge agent keys; retain every other TOML byte."""
import copy
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import tomllib


def replace_key(source, project, table, key, value):
    """Accept a textual edit only when TOML proves it changes exactly one key."""
    parsed = tomllib.loads(source)
    expected = copy.deepcopy(parsed)
    agent = expected['projects'][project].setdefault('agent', {})
    target = agent.setdefault('options', {}) if table == 'options' else agent
    if target.get(key) == value:
        return source
    exists = key in target
    target[key] = value
    encoded = json.dumps(value, ensure_ascii=False)
    candidates = []
    if exists:
        pattern = re.compile(r'(?m)^[ \t]*(?:' + key + r'|"' + key + r'"|\x27' + key
                             + r'\x27)[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\.)*"|\x27[^\x27\r\n]*\x27)')
        edits = ((match.start(1), match.end(1), encoded) for match in pattern.finditer(source))
    else:
        newline = '\r\n' if '\r\n' in source else '\n'
        assignment = f'{key} = {encoded}{newline}'
        header = '[projects.agent' + ('.options' if table == 'options' else '') + ']'
        # Try table boundaries, including noncanonical/quoted table headers. Parsing
        # rejects insertions in strings, other projects or unrelated nested tables.
        boundaries = [match.start() for match in re.finditer(r'(?m)^[ \t]*\[', source)] + [len(source)]
        edits = ((pos, pos, prefix + assignment) for pos in boundaries
                 for prefix in (newline, newline + header + newline))
    for start, end, replacement in edits:
        candidate = source[:start] + replacement + source[end:]
        try:
            if tomllib.loads(candidate) == expected and candidate not in candidates:
                candidates.append(candidate)
        except ValueError:
            pass
    if not candidates:
        raise ValueError('Cannot safely locate managed bridge key')
    # For missing keys several positions in the same table may be equivalent.
    if exists and len(candidates) != 1:
        raise ValueError('Ambiguous managed bridge key')
    return candidates[0]


def migrate(target, model, effort, *, apply=True):
    """Atomically update all projects, or leave the original untouched on failure."""
    target = Path(target).resolve()
    if not target.exists():
        return False
    if not model or not effort or model.startswith('__') or effort.startswith('__'):
        raise ValueError('Missing organization bridge defaults')
    original = target.read_bytes()
    source = original.decode('utf-8')
    projects = tomllib.loads(source).get('projects')
    if not isinstance(projects, list) or not projects:
        raise ValueError('Missing bridge projects')
    for index in range(len(projects)):
        for table, key, value in [('', 'type', 'claudecode'), ('options', 'mode', 'bypassPermissions'),
                                  ('options', 'model', model), ('options', 'reasoning_effort', effort)]:
            source = replace_key(source, index, table, key, value)
    updated = source.encode('utf-8')
    if updated == original:
        return False
    if apply:
        metadata = target.stat()
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.bridge-', delete=False) as pending:
            name = Path(pending.name)
            try:
                pending.write(updated)
                pending.flush()
                if (metadata.st_uid, metadata.st_gid) != (os.geteuid(), os.getegid()):
                    os.fchown(pending.fileno(), metadata.st_uid, metadata.st_gid)
                os.fchmod(pending.fileno(), stat.S_IMODE(metadata.st_mode))
                os.replace(name, target)
            finally:
                name.unlink(missing_ok=True)
    return True


def refresh(target, model=None, effort=None, *, apply=True):
    """Startup and onboarding must keep working after a migration failure."""
    try:
        if not Path(target).exists():
            return False
        model = model or os.environ.get('PARTNER_BRIDGE_MODEL')
        effort = effort or os.environ.get('PARTNER_DEFAULT_EFFORT')
        if not model or not effort:
            # Container exec inherits its creation environment, not exports made
            # by PID 1. Onboarding must also resolve the injected runtime config.
            if os.environ.get('WORKPARTNER_MODEL_CONFIG'):
                defaults = json.loads(os.environ['WORKPARTNER_MODEL_CONFIG'])['defaults']
            else:
                directory = Path(os.environ.get('WORKPARTNER_ORG_DIR', '/opt/workpartner/organization/selected'))
                defaults = json.loads((directory / 'organization.json').read_bytes())['model']['defaults']
            model = model or os.environ.get('ANTHROPIC_MODEL') or defaults['claude']
            effort = effort or defaults['effort']
        return migrate(target, model, effort, apply=apply)
    except Exception as error:
        # Parser and OS exception messages can contain credentials; print type only.
        print(f'Warning: bridge defaults unchanged ({type(error).__name__}); continuing', file=sys.stderr)
        return False


if __name__ == '__main__':
    refresh(sys.argv[1])

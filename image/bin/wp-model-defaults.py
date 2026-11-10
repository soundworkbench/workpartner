"""Refresh organization defaults while preserving personal model selections.

Each engine records its last organization model beside its settings. Settings are
replaced atomically before the marker: interrupted updates can be retried without
mistaking a personal value for an organization default. Invalid files stop startup.
"""
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import tomllib


def atomic_write(path, content):
    """Replace a resolved settings file, preserving its permissions and symlink."""
    path = path.resolve()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as pending:
        temporary = Path(pending.name)
        try:
            pending.write(content)
            pending.flush()
            os.fchmod(pending.fileno(), stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def replace_toml_model(source, model):
    """Change only the top-level model assignment, retaining other TOML bytes."""
    parsed = tomllib.loads(source)
    expected = dict(parsed, model=model)
    pattern = re.compile(r'''(?m)^[ \t]*(?:model|"model"|'model')[ \t]*=[ \t]*(?:"(?:[^"\\\n]|\\.)*"|'[^'\n]*')''')
    candidates = []
    for match in pattern.finditer(source):
        candidate = source[:match.start()] + 'model = ' + json.dumps(model) + source[match.end():]
        try:
            if tomllib.loads(candidate) == expected:
                candidates.append(candidate)
        except ValueError:
            continue
    if 'model' not in parsed:
        candidate = 'model = ' + json.dumps(model) + '\n' + source
        if tomllib.loads(candidate) == expected:
            candidates.append(candidate)
    if len(candidates) != 1:
        raise ValueError('Cannot uniquely locate the top-level model assignment')
    return candidates[0]


def sync(engine, template, target, default, effort, base_url=''):
    """Seed settings or advance the previously managed model; return the selection.

    Markerless installations adopt the current default or the released initial
    model. A different personal model is retained, including on later restarts.
    """
    marker = target.with_name('.wp-organization-model.json')
    history = json.loads(marker.read_bytes()) if marker.exists() else None
    previous = history['model'] if history else None
    pending = history.get('pending') if history else None
    exists = target.exists()
    source = target.read_bytes().decode() if exists else template.read_text()
    if engine == 'claude':
        config = json.loads(source)
        current = config.get('model') if exists else None
        if not exists:
            config['effortLevel'] = effort
    elif engine == 'codex':
        if not exists:
            source = source.replace('__MODEL_BASE_URL__', json.dumps(base_url)[1:-1])
            source = source.replace('__CODEX_MODEL__', default).replace('__EFFORT__', effort)
            source = re.sub(r'(?m)^model_reasoning_effort = .*$',
                            lambda _: 'model_reasoning_effort = ' + json.dumps(effort), source, count=1)
        config = tomllib.loads(source)
        current = config.get('model') if exists else None
    else:
        raise ValueError('Unknown engine')
    legacy = {'claude': 'claude/claude-opus-5-5', 'codex': 'gpt-6.1-sol'}[engine]
    managed = current is None or (current in (previous, pending) if history else current in (default, legacy))
    selected = default if managed else current
    if managed and (not exists or current != selected):
        if engine == 'claude':
            config['model'] = selected
            updated = (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode()
        else:
            updated = replace_toml_model(source, selected).encode()
        # Record both sides before replacing settings, so a crash remains retryable.
        atomic_write(marker, (json.dumps({'model': previous or current or default, 'pending': default}) + '\n').encode())
        if not exists or updated != target.read_bytes():
            atomic_write(target, updated)
    atomic_write(marker, (json.dumps({'model': default if managed else previous}) + '\n').encode())
    return selected


if __name__ == '__main__':
    try:
        sync(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5], os.environ.get('MODEL_BASE_URL', ''))
    except (OSError, ValueError, KeyError) as error:
        sys.exit(f'Cannot update engine model defaults ({type(error).__name__}); startup stopped')

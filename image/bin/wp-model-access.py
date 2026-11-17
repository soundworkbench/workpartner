#!/usr/bin/env python3
"""Claude Code model settings for a key that cannot use the organization's Claude models.

When model.fallbackDefaults is configured and the endpoint's model list for this
key has no model.defaults.claudePrefix model, every Claude Code model setting that
names such a model is replaced: subagent and small-model settings by the fallback
haiku, the others by the fallback claude. Startup records the result in a marker file so
processes started later with `docker exec` (onboarding) apply the same choice; an
unreachable endpoint keeps the last recorded result.

Startup: eval "$(python3 -I wp-model-access.py)" prints the replacement exports.
"""
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import urllib.request

SMALL = ('ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL')
VARIABLES = ('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
             'PARTNER_BRIDGE_MODEL') + SMALL


def model_names(model_id):
    """Route names plus provider-qualified and bare names, as the web picker matches them."""
    parts = model_id.split('/')
    if len(parts) > 1 and parts[0].startswith('mp-'):
        parts = parts[1:]
    base = parts[-1]
    names = {model_id, '/'.join(parts), base}
    if base.startswith('claude-'):
        names.add('claude/' + base)
    return names


def has_prefix(prefix):
    """True or False from the key's model list; None when the endpoint cannot be read."""
    try:
        request = urllib.request.Request(os.environ['ANTHROPIC_BASE_URL'] + '/v1/models', headers={
            'x-api-key': os.environ['ANTHROPIC_API_KEY'], 'anthropic-version': '2023-06-01',
            'User-Agent': 'WorkPartner/1 (+https://github.com/soundworkbench/workpartner)'})
        with urllib.request.urlopen(request, timeout=10) as response:
            models = json.loads(response.read() or b'{}').get('data', [])
    except Exception as error:
        print(f'Model permissions unavailable ({type(error).__name__}); keeping the last result', file=sys.stderr)
        return None
    return any(name.startswith(prefix) for model in models for name in model_names(str(model.get('id', ''))))


def marker():
    return Path(os.environ.get('WP_MODEL_FALLBACK_FILE', '/data/.wp-model-fallback.json'))


def config():
    return json.loads(os.environ.get('WORKPARTNER_MODEL_CONFIG') or '{}')


def active(selected=None):
    """The recorded fallback ({prefix, claude, haiku}) or None when Claude models are usable."""
    selected = config() if selected is None else selected
    if not selected.get('fallbackDefaults'):
        return None
    try:
        return json.loads(marker().read_bytes())
    except (OSError, ValueError):
        return None


def substitute(variable, model, fallback):
    if not fallback or not model or not model.startswith(fallback['prefix']):
        return model
    return fallback['haiku' if variable in SMALL else 'claude']


def update():
    """Check the key at startup, record the result, and return the active fallback."""
    selected = config()
    fallback = selected.get('fallbackDefaults')
    if not fallback:
        marker().unlink(missing_ok=True)
        return None
    prefix = selected['defaults']['claudePrefix']
    access = has_prefix(prefix)
    if access:
        marker().unlink(missing_ok=True)
    elif access is False:
        content = json.dumps({'prefix': prefix, 'claude': fallback['claude'], 'haiku': fallback['haiku']}) + '\n'
        target = marker()
        with tempfile.NamedTemporaryFile('w', dir=target.parent, prefix='.wp-model-', delete=False) as pending:
            pending.write(content)
        os.replace(pending.name, target)
    return active(selected)


if __name__ == '__main__':
    try:
        fallback = update()
    except Exception as error:
        sys.exit(f'Model fallback unchanged ({type(error).__name__})')
    for variable in VARIABLES:
        model = os.environ.get(variable)
        replaced = substitute(variable, model, fallback)
        if replaced != model:
            print(f'export {variable}={shlex.quote(replaced)}')

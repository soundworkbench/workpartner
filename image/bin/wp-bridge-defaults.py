#!/usr/bin/env python3
"""Migrate managed bridge agent keys and organization template upgrades; retain every other TOML byte."""
import copy
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import tomllib

# Only the bridge resumes the agent when background work finishes, so only the
# bridge may end a turn early; the shared instructions wait in the same turn.
BACKGROUND_PROMPT = ('本会话来自消息应用，后台任务完成时会唤醒你。预计超过 2 分钟的工作'
                     '（批处理、长时间转换、大文件下载、深入调研）交给后台子代理或后台命令；'
                     '用一句话说明已开始、完成后会回报，然后结束本轮。被唤醒时读取结果并主动回报；'
                     '有新消息时先回答新消息。这条优先于说明文件中“在同一轮里等子代理完成”的要求，'
                     '内存和并发上限照旧。')
# Rendered organization template in the image; bridge.upgradeKeys take their values from it.
TEMPLATE = Path('/opt/workpartner/home/cc-connect-feishu.toml')
# Bridge provider whose model list mirrors the web picker catalog; it sets no key or
# base URL, so the agent keeps the container's model endpoint and key.
PROVIDER = 'workpartner'
HEADER = re.compile(r'(?m)^[ \t]*\[')


def replace_key(source, path, key, value):
    """Accept a textual edit only when TOML proves it changes exactly one key."""
    parsed = tomllib.loads(source)
    expected = copy.deepcopy(parsed)
    target = expected
    for part in path:
        target = target[part] if isinstance(part, int) else target.setdefault(part, {})
    if target.get(key) == value:
        return source
    exists = key in target
    target[key] = value
    encoded = json.dumps(value, ensure_ascii=False)
    candidates = []
    if exists:
        pattern = re.compile(r'(?m)^[ \t]*(?:' + key + r'|"' + key + r'"|\x27' + key
                             + r'\x27)[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\.)*"|\x27[^\x27\r\n]*\x27|[-+]?[0-9A-Za-z_.:]+)')
        edits = ((match.start(1), match.end(1), encoded) for match in pattern.finditer(source))
    else:
        newline = '\r\n' if '\r\n' in source else '\n'
        assignment = f'{key} = {encoded}{newline}'
        header = '[' + '.'.join(part for part in path if isinstance(part, str)) + ']'
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


def provider_block(provider, newline):
    lines = ['[[projects.agent.providers]]', f'name = {json.dumps(provider["name"])}']
    if 'model' in provider:
        lines.append(f'model = {json.dumps(provider["model"], ensure_ascii=False)}')
    lines.append('models = [')
    lines += [f'  {{ model = {json.dumps(entry["model"], ensure_ascii=False)}, alias = {json.dumps(entry["alias"], ensure_ascii=False)} }},'
              for entry in provider['models']]
    lines.append(']')
    return newline.join(lines) + newline


def set_provider(source, index, catalog, original_model):
    """Replace only the managed provider of one project and make it active unless another is chosen."""
    parsed = tomllib.loads(source)
    agent = parsed['projects'][index]['agent']
    providers = agent.get('providers', [])
    if not isinstance(providers, list):
        raise ValueError('Unsupported bridge providers')
    previous = next((p for p in providers if p.get('name') == PROVIDER), {})
    models = [{'model': entry['key'], 'alias': entry['name']} for entry in catalog]
    provider = {'name': PROVIDER, 'models': models}
    # A model chosen with /model is kept while listed; one that only followed the
    # previous default follows the current option.
    chosen = previous.get('model')
    if chosen and chosen != original_model and chosen in [entry['model'] for entry in models]:
        provider['model'] = chosen
    elif 'model' in agent.get('options', {}):
        provider['model'] = agent['options']['model']
    if previous != provider:
        while any(p.get('name') == PROVIDER for p in tomllib.loads(source)['projects'][index]['agent'].get('providers', [])):
            source = remove_provider(source, index)
        expected = tomllib.loads(source)
        expected['projects'][index]['agent'].setdefault('providers', []).append(provider)
        newline = '\r\n' if '\r\n' in source else '\n'
        block = provider_block(provider, newline)
        candidates = (source[:pos] + prefix + block + source[pos:]
                      for pos in reversed([m.start() for m in HEADER.finditer(source)] + [len(source)]) for prefix in ('', newline))
        for candidate in candidates:
            try:
                if tomllib.loads(candidate) == expected:
                    source = candidate
                    break
            except ValueError:
                pass
        else:
            raise ValueError('Cannot safely place managed bridge provider')
    if not tomllib.loads(source)['projects'][index]['agent'].get('options', {}).get('provider'):
        source = replace_key(source, ('projects', index, 'agent', 'options'), 'provider', PROVIDER)
    return source


def remove_provider(source, index):
    """Remove the first managed provider table (with its subtables) of one project."""
    expected = tomllib.loads(source)
    agent = expected['projects'][index]['agent']
    agent['providers'] = [p for p in agent['providers'] if p.get('name') != PROVIDER] + \
        [p for p in agent['providers'] if p.get('name') == PROVIDER][1:]
    if not agent['providers']:
        del agent['providers']
    bounds = [m.start() for m in HEADER.finditer(source)] + [len(source)]
    for i, start in enumerate(bounds):
        for end in bounds[i + 1:]:
            try:
                if tomllib.loads(source[:start] + source[end:]) == expected:
                    return source[:start] + source[end:]
            except ValueError:
                pass
    raise ValueError('Cannot safely remove managed bridge provider')


def template_upgrades(config, template, upgrades):
    """Yield template values for declared keys a person has not set or still has at a superseded default."""
    for entry in upgrades:
        *table, key = entry['key'].split('.')
        previous = entry.get('from', [])
        if table == ['projects', 'platforms', 'options']:
            # Platforms take the values of the template platform of the same type.
            wanted = {}
            for platform in template.get('projects', [{}])[0].get('platforms', []):
                wanted.setdefault(platform.get('type'), platform.get('options', {}))
            targets = [(('projects', i, 'platforms', j, 'options'), platform.get('options', {}),
                        wanted.get(platform.get('type'), {}))
                       for i, project in enumerate(config.get('projects', []))
                       for j, platform in enumerate(project.get('platforms', []))]
        elif table == ['projects', 'agent', 'options']:
            # Every project takes the template project's agent options.
            wanted = template.get('projects', [{}])[0].get('agent', {}).get('options', {})
            targets = [(('projects', i, 'agent', 'options'), project.get('agent', {}).get('options', {}), wanted)
                       for i, project in enumerate(config.get('projects', []))]
        else:
            current, source = config, template
            for part in table:
                current, source = current.get(part, {}), source.get(part, {})
            targets = [(tuple(table), current, source)]
        for path, current, source in targets:
            if key in source and current.get(key) != source[key] and (key not in current or current[key] in previous):
                yield path, key, source[key]


def migrate(target, model, effort, *, apply=True, template=None, upgrades=(), catalog=None):
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
    original_models = [project.get('agent', {}).get('options', {}).get('model') for project in projects]
    for index in range(len(projects)):
        for table, key, value in [('', 'type', 'claudecode'), ('options', 'mode', 'bypassPermissions'),
                                  ('options', 'model', model), ('options', 'reasoning_effort', effort),
                                  ('options', 'append_system_prompt', BACKGROUND_PROMPT)]:
            path = ('projects', index, 'agent') + (('options',) if table else ())
            source = replace_key(source, path, key, value)
    for path, key, value in template_upgrades(tomllib.loads(source), template or {}, upgrades):
        source = replace_key(source, path, key, value)
    if catalog:
        for index, original_model in enumerate(original_models):
            source = set_provider(source, index, catalog, original_model)
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


def organization():
    """The organization embedded in the image, or None outside a personal container."""
    directory = Path(os.environ.get('WORKPARTNER_ORG_DIR', '/opt/workpartner/organization/selected'))
    try:
        return json.loads((directory / 'organization.json').read_bytes())
    except FileNotFoundError:
        return None


def refresh(target, model=None, effort=None, *, apply=True):
    """Startup and onboarding must keep working after a migration failure."""
    try:
        if not Path(target).exists():
            return False
        model = model or os.environ.get('PARTNER_BRIDGE_MODEL')
        effort = effort or os.environ.get('PARTNER_DEFAULT_EFFORT')
        selected = organization()
        runtime = json.loads(os.environ.get('WORKPARTNER_MODEL_CONFIG') or '{}')
        if not model or not effort:
            # Container exec inherits its creation environment, not exports made
            # by PID 1. Onboarding must also resolve the injected runtime config.
            if runtime:
                defaults = runtime['defaults']
            else:
                if selected is None:
                    raise FileNotFoundError('organization.json')
                defaults = selected['model']['defaults']
            model = model or os.environ.get('ANTHROPIC_MODEL') or defaults['claude']
            effort = effort or defaults['effort']
        upgrades = ((selected or {}).get('bridge') or {}).get('upgradeKeys') or []
        template = tomllib.loads(TEMPLATE.read_text()) if upgrades and TEMPLATE.is_file() else None
        # The injected catalog already carries this user's model.userCatalog entries.
        catalog = (runtime.get('catalog') or {}).get('claude')
        return migrate(target, model, effort, apply=apply, template=template, upgrades=upgrades, catalog=catalog)
    except Exception as error:
        # Parser and OS exception messages can contain credentials; print type only.
        print(f'Warning: bridge defaults unchanged ({type(error).__name__}); continuing', file=sys.stderr)
        return False


if __name__ == '__main__':
    refresh(sys.argv[1])

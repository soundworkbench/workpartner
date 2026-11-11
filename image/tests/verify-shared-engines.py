#!/usr/bin/env python3
"""Verify pinned engines discover linked skills, updates and withdrawal without a model request."""
import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time


def rpc(binary, args, messages, wanted, environment, directory):
    process = subprocess.Popen([str(binary), *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=environment, cwd=directory)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        for message in messages:
            process.stdin.write((json.dumps(message) + '\n').encode())
        process.stdin.flush()
        buffer = b''
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if not selector.select(0.5):
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('Engine exited before discovery completed')
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                message = json.loads(line)
                if wanted(message):
                    return message
        raise TimeoutError('Engine skill discovery timed out')
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdin.close()
        process.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    args = parser.parse_args()
    binaries = {key: value.resolve() for key, value in vars(args).items()}
    versions = {key: subprocess.check_output([str(value), '--version'], stderr=subprocess.DEVNULL, text=True).strip()
                for key, value in binaries.items()}
    assert versions['claude'].startswith('2.1.319 '), versions
    assert versions['codex'] == 'codex-cli 0.167.0', versions
    results = []
    with tempfile.TemporaryDirectory(prefix='shared-engine-check-') as temporary:
        root = Path(temporary)
        live = root / 'shared/live/market-probe'
        live.parent.mkdir(parents=True)
        for folder in ['.claude/skills', '.codex/skills']:
            target = root / folder
            target.mkdir(parents=True)
            (target / 'market-probe').symlink_to(live)
        environment = {**os.environ, 'HOME': str(root), 'CODEX_HOME': str(root / '.codex'),
                       'CLAUDE_CONFIG_DIR': str(root / '.claude'), 'DISABLE_AUTOUPDATER': '1'}
        for stage in ['first', 'updated', 'withdrawn']:
            if stage == 'withdrawn':
                live.unlink()
            else:
                release = root / 'shared/releases' / stage
                release.mkdir(parents=True)
                (release / 'SKILL.md').write_text(f'---\nname: market-probe\ndescription: {stage} shared probe\n---\nOnly used for offline discovery.\n')
                if live.is_symlink():
                    live.unlink()
                live.symlink_to(release)
            claude = rpc(binaries['claude'], ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
                         [{'type': 'control_request', 'request_id': 'probe', 'request': {'subtype': 'initialize'}}],
                         lambda m: m.get('type') == 'control_response', environment, root)
            assert claude['response']['subtype'] == 'success'
            commands = claude['response']['response']['commands']
            codex = rpc(binaries['codex'], ['app-server'], [
                {'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'skill-probe', 'version': '1'}}},
                {'method': 'initialized', 'params': {}},
                {'id': 2, 'method': 'skills/list', 'params': {'cwds': [str(root)]}},
            ], lambda m: m.get('id') == 2, environment, root)
            assert 'error' not in codex, codex.get('error')
            skills = codex['result']['data'][0]['skills']
            for engine, rows in [('claude', commands), ('codex', skills)]:
                found = [row for row in rows if row['name'] == 'market-probe']
                assert bool(found) == (stage != 'withdrawn'), (engine, stage)
                if found:
                    assert stage + ' shared probe' in found[0]['description'], (engine, stage)
                results.append({'engine': engine, 'stage': stage, 'passed': True})
    print(json.dumps({'versions': versions, 'modelRequests': 0, 'checks': results}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Run bounded Feishu setup inside the caller's own container."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import tomllib

BASE = Path('/data/.cc-connect')
CONFIG = BASE / 'config.toml'
STATE = BASE / '.feishu-setup.json'
LIFETIME = 600


def save(state):
    """Replace only the setup status; never put credentials in this document."""
    fd, name = tempfile.mkstemp(dir=BASE, prefix='.status-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(state, stream)
        os.replace(name, STATE)
    finally:
        Path(name).unlink(missing_ok=True)


def read():
    try:
        return json.loads(STATE.read_text())
    except FileNotFoundError:
        return {'status': 'unconnected'}


def status():
    state = read()
    kind = state['status']
    if CONFIG.is_file() and kind not in ('needs_restart', 'restarting', 'restart_failed'):
        return {'status': 'connected'}
    if kind == 'connected':
        return {'status': 'unconnected'}
    result = {'status': kind}
    if kind in ('preparing', 'waiting'):
        result['expiresAt'] = state['expiresAt']
        # A killed worker cannot leave a usable QR beyond the advertised deadline.
        if time.time() >= state['expiresAt']:
            Path(state['directory'], 'qr.png').unlink(missing_ok=True)
            return {'status': 'expired'}
        qr = Path(state['directory'], 'qr.png')
        if qr.is_file():
            image = qr.read_bytes()
            if image.startswith(b'\x89PNG\r\n\x1a\n') and len(image) <= 1024 * 1024:
                result.update(status='waiting', qr='data:image/png;base64,' + base64.b64encode(image).decode())
    return result


def stop(process):
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def run(project, *, base=BASE, command='/opt/workpartner/bin/cc-connect',
        template='/opt/workpartner/home/cc-connect-feishu.toml', lifetime=LIFETIME):
    """Serialize attempts, publish only complete credentials, and always remove the QR."""
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = os.open(base / '.feishu-setup.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock, 'w') as locked:
        try:
            fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if CONFIG.is_file() or (base / 'pending-feishu.toml').exists():
            return
        with tempfile.TemporaryDirectory(prefix='.feishu-', dir=base) as directory:
            expires = time.time() + lifetime
            state = {'status': 'preparing', 'expiresAt': expires, 'directory': directory}
            save(state)
            try:
                config = Path(directory, 'config.toml')
                content = Path(template).read_text().replace('__PROJECT__', project).replace('__ALLOW_FROM__', '')
                config.write_text(content)
                config.chmod(0o600)
                # Output can contain credentials. Keep it private, bounded on read, and never print it.
                with tempfile.TemporaryFile() as output:
                    process = subprocess.Popen([command, 'feishu', 'new', '--config', str(config),
                                                '--project', project, '--qr-image', str(Path(directory, 'qr.png')),
                                                '--set-allow-from-empty'], stdout=output, stderr=output,
                                               stdin=subprocess.DEVNULL, start_new_session=True)
                    try:
                        process.wait(timeout=max(0, expires - time.time()))
                    except subprocess.TimeoutExpired:
                        stop(process)
                        save({'status': 'expired'})
                        return
                    output.seek(0)
                    text = output.read(1024 * 1024).decode(errors='replace')
                if time.time() >= expires:
                    save({'status': 'expired'})
                    return
                config.chmod(0o600)
                data = tomllib.loads(config.read_text())
                options = data['projects'][0]['platforms'][0]['options']
                credentials = all(options.get(key) and not options[key].startswith('__') for key in ('app_id', 'app_secret'))
                own_id = re.search(r"机器人自身|机器人自己的|bot['’]?s? own|bot itself|own (?:open_?id|user.?id)", text, re.I)
                allowed = options.get('allow_from', '')
                if credentials and (own_id or not allowed or allowed == '*'):
                    os.replace(config, base / 'pending-feishu.toml')
                    save({'status': 'needs_identity'})
                elif process.returncode == 0 and credentials and allowed and allowed != '*':
                    # An existing configuration always wins, including one written outside this flow.
                    try:
                        os.link(config, CONFIG)
                    except FileExistsError:
                        pass
                    save({'status': 'needs_restart'})
                else:
                    save({'status': 'failed'})
            except Exception:
                # Only a typed state escapes; exception text may include command output or secrets.
                save({'status': 'failed'})


def main():
    os.umask(0o077)
    action = sys.argv[1]
    if action == 'start':
        project = sys.argv[2]
        if not re.fullmatch(r'partner-[a-zA-Z0-9_-]+', project):
            raise ValueError('invalid project')
        run(project)
    elif action == 'status':
        print(json.dumps(status()))
    elif action in ('restarting', 'restart_failed', 'connected'):
        save({'status': action})
    else:
        raise ValueError('invalid action')


if __name__ == '__main__':
    main()

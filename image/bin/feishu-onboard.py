#!/usr/bin/env python3
"""Run bounded Feishu setup inside the caller's own container."""
import base64
from contextlib import nullcontext
import fcntl
import json
import os
from pathlib import Path
import re
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import tomllib

BASE = Path(os.environ.get('WP_CC_CONNECT_DIR', '/data/.cc-connect'))
AGENT_ID = None
AGENTS = None
CONFIG = BASE / 'config.toml'
STATE = BASE / '.feishu-setup.json'
LIFETIME = 600


def refresh_agent(config):
    """Share the startup migration, including its warning-only failure policy."""
    try:
        helper = runpy.run_path(str(Path(__file__).with_name('wp-bridge-defaults.py')))
        helper['refresh'](config)
    except Exception as error:
        print(f'Warning: bridge defaults unchanged ({type(error).__name__}); continuing', file=sys.stderr)


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
    if AGENT_ID:
        return sub_status()
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
    if AGENT_ID:
        if not any(item['id'] == AGENT_ID for item in AGENTS['registered']()):
            return
    else:
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = os.open(base / '.feishu-setup.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock, 'w') as locked:
        # 与 delete 串行化拿锁和首次登记，避免新 worker 持锁时仍暴露旧 PID。
        with AGENTS['locked']() if AGENT_ID else nullcontext():
            try:
                fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            if AGENT_ID:
                if not (base / 'agent.json').is_file() or CONFIG.is_file() or (base / 'pending-feishu.toml').exists():
                    return
                save({'status': 'preparing', 'expiresAt': time.time() + lifetime, 'pid': os.getpid()})
        refresh_agent(CONFIG)
        if CONFIG.is_file() or (base / 'pending-feishu.toml').exists():
            return
        with tempfile.TemporaryDirectory(prefix='.feishu-', dir=base) as directory:
            expires = time.time() + lifetime
            state = {'status': 'preparing', 'expiresAt': expires, 'directory': directory}
            if AGENT_ID:
                state['pid'] = os.getpid()
            save(state)
            try:
                config = Path(directory, 'config.toml')
                content = Path(template).read_text().replace('__PROJECT__', project).replace('__ALLOW_FROM__', '')
                if AGENT_ID:
                    helper = runpy.run_path(str(Path(__file__).with_name('wp-bridge-defaults.py')))
                    content = helper['replace_key'](content, (), 'data_dir', str(base / 'data'))
                    content = helper['replace_key'](content, ('projects', 0, 'agent', 'options'),
                                                    'work_dir', str(AGENTS['workspace'](AGENT_ID)))
                    assert_sub_config(content, project, base)
                config.write_text(content)
                config.chmod(0o600)
                refresh_agent(config)
                # Output can contain credentials. Keep it private, bounded on read, and never print it.
                with tempfile.TemporaryFile() as output:
                    arguments = [command, 'feishu', 'new', '--config', str(config),
                                 '--project', project, '--qr-image', str(Path(directory, 'qr.png')),
                                 '--set-allow-from-empty']
                    if AGENT_ID:
                        # 与删除共用短锁，确保进程组登记之前不会被移走目录。
                        with AGENTS['locked']():
                            if not (base / 'agent.json').is_file():
                                return
                            process = subprocess.Popen(arguments, stdout=output, stderr=output,
                                                       cwd=AGENTS['workspace'](AGENT_ID),
                                                       stdin=subprocess.DEVNULL, start_new_session=True)
                            state['childPid'] = process.pid
                            save(state)
                    else:
                        process = subprocess.Popen(arguments, stdout=output, stderr=output,
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
                refresh_agent(config)
                if AGENT_ID:
                    assert_sub_config(config.read_text(), project, base)
                data = tomllib.loads(config.read_text())
                options = data['projects'][0]['platforms'][0]['options']
                credentials = all(options.get(key) and not options[key].startswith('__') for key in ('app_id', 'app_secret'))
                own_id = re.search(r"机器人自身|机器人自己的|bot['’]?s? own|bot itself|own (?:open_?id|user.?id)", text, re.I)
                allowed = options.get('allow_from', '')
                with AGENTS['locked']() if AGENT_ID else nullcontext():
                    if AGENT_ID and not (base / 'agent.json').is_file():
                        return
                    if credentials and (own_id or not allowed or allowed == '*'):
                        os.replace(config, base / 'pending-feishu.toml')
                        save({'status': 'needs_identity'})
                    elif process.returncode == 0 and credentials and allowed and allowed != '*':
                        # An existing configuration always wins, including one written outside this flow.
                        try:
                            os.link(config, CONFIG)
                        except FileExistsError:
                            pass
                        save({'status': 'connected' if AGENT_ID else 'needs_restart'})
                        if AGENT_ID:
                            AGENTS['notify']('rescan')
                    else:
                        save({'status': 'failed'})
            except Exception:
                # Only a typed state escapes; exception text may include command output or secrets.
                save({'status': 'failed'})


def assert_sub_config(content, project, base):
    data = tomllib.loads(content)
    if (data['data_dir'] != str(base / 'data') or len(data['projects']) != 1
            or data['projects'][0]['name'] != project
            or data['projects'][0]['agent']['options']['work_dir'] != str(AGENTS['workspace'](AGENT_ID))):
        raise ValueError('invalid agent config')


def sub_status():
    if CONFIG.is_file():
        return {'status': 'connected'}
    state = AGENTS['read_json'](STATE)
    kind = state.get('status', 'failed') if STATE.exists() else 'unconnected'
    if kind == 'none' or kind == 'connected':
        kind = 'unconnected'
    if kind not in (*AGENTS['STATES'], 'unconnected'):
        kind = 'failed'
    result = {'status': kind}
    if kind in ('preparing', 'waiting'):
        expires = state.get('expiresAt')
        if not isinstance(expires, (int, float)):
            return {'status': 'failed'}
        if time.time() >= expires:
            return {'status': 'expired'}
        result['expiresAt'] = expires
        directory = Path(state.get('directory', ''))
        if directory.resolve().parent == BASE.resolve():
            try:
                image = (directory / 'qr.png').read_bytes()
                if image.startswith(b'\x89PNG\r\n\x1a\n') and len(image) <= 1024 * 1024:
                    result.update(status='waiting', qr='data:image/png;base64,' + base64.b64encode(image).decode())
            except OSError:
                pass
    return result


def main():
    global BASE, CONFIG, STATE, AGENT_ID, AGENTS
    os.umask(0o077)
    if '--agent' in sys.argv:
        index = sys.argv.index('--agent')
        if index + 1 >= len(sys.argv):
            return 1
        AGENT_ID = sys.argv[index + 1]
        AGENTS = runpy.run_path(str(Path(__file__).with_name('wp-agent')))
        if not any(item['id'] == AGENT_ID for item in AGENTS['registered']()):
            if sys.argv[1] == 'status':
                print(json.dumps({'status': 'failed'}))
                return 0
            return 1
        BASE = AGENTS['agent_base'](AGENT_ID)
        CONFIG = BASE / 'config.toml'
        STATE = BASE / '.feishu-setup.json'
        if sys.argv[1] == 'start':
            if os.getpgrp() != os.getpid():
                os.setsid()
            try:
                run('agent-' + AGENT_ID, base=BASE,
                    command=os.environ.get('WP_CC_CONNECT_BIN', '/opt/workpartner/bin/cc-connect'),
                    template=os.environ.get('WP_FEISHU_TEMPLATE', '/opt/workpartner/home/cc-connect-feishu.toml'))
            except OSError:
                # 删除可先移走目录；不重建登记目录，也不暴露底层输出。
                return 1
        elif sys.argv[1] == 'status':
            print(json.dumps(status()))
        else:
            return 1
        return 0
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
    sys.exit(main())

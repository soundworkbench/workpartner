#!/usr/bin/env python3
"""查询飞书机器人信息，并管理独立于网页服务的消息桥。"""
import argparse
import base64
from datetime import datetime, timezone
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.request

BASE = Path(os.environ.get('WP_CC_CONNECT_DIR', '/data/.cc-connect'))
RUN = BASE / 'run'
EVENTS = ('connected', 'disconnected', 'reconnecting', 'exhausted')


def atomic_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.bot-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(',', ':'))
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def bridge_status():
    state = read_json(RUN / 'bridge-state.json')
    event, at = state.get('event'), state.get('at')
    try:
        if event not in EVENTS or not isinstance(at, str):
            raise ValueError
        at = datetime.fromisoformat(at).isoformat()
    except ValueError:
        event, at = None, None
    running = False
    try:
        pid = int((RUN / 'bridge.pid').read_text())
        if pid > 0:
            os.kill(pid, 0)
            running = True
            # 僵尸进程仍响应 kill(0)，但已经无法接收消息。
            process = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
            running = process != 'Z'
    except (OSError, ValueError, IndexError):
        pass
    online = 'offline'
    if running:
        online = 'online' if event == 'connected' else ('unknown' if event is None else 'offline')
    return {'online': online, 'lastEvent': event, 'lastEventAt': at}


class RequestTimeout(Exception):
    pass


class AuthFailed(Exception):
    pass


def alarm_timeout(signum, frame):
    raise RequestTimeout


def http_read(url, deadline, *, body=None, token=None, limit=256 * 1024):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RequestTimeout
    timeout = min(3, remaining)
    request_deadline = time.monotonic() + timeout
    headers = {}
    if body is not None:
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(url, data=body, headers=headers)
    resolver = socket.getaddrinfo

    def resolve(*args, **kwargs):
        result, errors = [], []

        def lookup():
            try:
                result.append(resolver(*args, **kwargs))
            except Exception as error:
                errors.append(error)

        # libc 解析可能不响应 SIGALRM；只等待剩余预算，退出不等待解析线程。
        worker = threading.Thread(target=lookup, daemon=True)
        worker.start()
        worker.join(max(0, request_deadline - time.monotonic()))
        if worker.is_alive():
            raise RequestTimeout
        if errors:
            raise errors[0]
        return result[0]

    # urllib 的代理和重定向也走此解析入口；计时器另限制连接及持续滴流。
    socket.getaddrinfo = resolve
    signal.setitimer(signal.ITIMER_REAL, timeout)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(limit + 1), response.headers.get_content_type()
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise AuthFailed from None
        raise
    except http.client.HTTPException:
        raise OSError from None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        socket.getaddrinfo = resolver


def api_json(url, deadline, **kwargs):
    data, _ = http_read(url, deadline, **kwargs)
    if len(data) > 256 * 1024:
        raise ValueError
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError
    if value.get('code') != 0:
        raise AuthFailed
    return value


def fetch_bot(app_id, secret, deadline):
    api = os.environ.get('WP_FEISHU_API_BASE', 'https://open.feishu.cn').rstrip('/')
    auth = api_json(api + '/open-apis/auth/v3/tenant_access_token/internal', deadline,
                    body={'app_id': app_id, 'app_secret': secret})
    token = auth.get('tenant_access_token')
    if not isinstance(token, str) or not token:
        raise AuthFailed
    data = api_json(api + '/open-apis/bot/v3/info', deadline, token=token)
    bot = data.get('bot')
    if not isinstance(bot, dict):
        raise ValueError
    name = bot.get('app_name')
    activate = bot.get('activate_status')
    result = {'name': name if isinstance(name, str) else None, 'avatar': None,
              'activate': activate == 2 if type(activate) is int else None}
    avatar_url = bot.get('avatar_url')
    if isinstance(avatar_url, str) and avatar_url.startswith(('http://', 'https://')):
        try:
            avatar, mime = http_read(avatar_url, deadline, limit=64 * 1024)
            if len(avatar) <= 64 * 1024 and re.fullmatch(r'image/[a-zA-Z0-9.+-]+', mime):
                result['avatar'] = f'data:{mime};base64,' + base64.b64encode(avatar).decode()
        except (OSError, ValueError, RequestTimeout, AuthFailed):
            pass
    return result


def cached_bot(value):
    if not isinstance(value, dict):
        return None
    at = value.get('at')
    if not isinstance(at, (int, float)) or not 0 <= time.time() - at < 600:
        return None
    name, avatar, activate = (value.get(key) for key in ('name', 'avatar', 'activate'))
    if name is not None and not isinstance(name, str):
        return None
    if avatar is not None and (not isinstance(avatar, str) or
                              not re.fullmatch(r'data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]*', avatar) or
                              len(avatar) > 88 * 1024):
        return None
    if activate is not None and type(activate) is not bool:
        return None
    return {'name': name, 'avatar': avatar, 'activate': activate}


def info(refresh):
    deadline = time.monotonic() + 7.5
    try:
        with (BASE / 'config.toml').open('rb') as stream:
            config = tomllib.load(stream)
        credentials = []
        for project in config.get('projects', []):
            for platform in project.get('platforms', []):
                if platform.get('type') == 'feishu':
                    options = platform['options']
                    values = (project['name'], options['app_id'], options['app_secret'])
                    if not all(isinstance(value, str) and value for value in values):
                        raise ValueError
                    credentials.append(values)
    except FileNotFoundError:
        return {'ok': True, 'bots': []}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {'ok': False, 'error': 'config_unreadable'}
    cache = read_json(RUN / 'bot-cache.json')
    clean_cache = {key: dict(value, at=entry['at']) for key, entry in cache.items()
                   if (value := cached_bot(entry)) is not None}
    status = bridge_status()
    bots = []
    fetched = {}
    signal.signal(signal.SIGALRM, alarm_timeout)
    for project, app_id, secret in credentials:
        bot = {'project': project, 'appId': app_id, 'name': None, 'avatar': None,
               'activate': None, **status, 'error': None}
        metadata = fetched.get(app_id) or (None if refresh else cached_bot(cache.get(app_id)))
        if metadata is None:
            try:
                metadata = fetch_bot(app_id, secret, deadline)
                fetched[app_id] = metadata
                clean_cache[app_id] = dict(metadata, at=time.time())
            except AuthFailed:
                bot['error'] = 'feishu_auth_failed'
            except (OSError, ValueError, RequestTimeout):
                bot['error'] = 'feishu_unreachable'
        if metadata is not None:
            bot.update(metadata)
        bots.append(bot)
    if fetched:
        try:
            atomic_json(RUN / 'bot-cache.json', clean_cache)
        except OSError:
            pass
    return {'ok': True, 'bots': bots}


def restart():
    try:
        fd = os.open(RUN / 'restart.fifo', os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        try:
            if not stat.S_ISFIFO(os.fstat(fd).st_mode):
                raise OSError
            os.write(fd, b'restart\n')
        finally:
            os.close(fd)
        return {'ok': True}
    except OSError:
        return {'ok': False, 'error': 'no_supervisor'}


def warn(message):
    try:
        print('警告：' + message, file=sys.stderr, flush=True)
    except OSError:
        pass


def write_bridge_file(name, value):
    try:
        atomic_json(RUN / name, value)
    except OSError:
        warn(f'无法写入 {name}，消息桥继续运行')


def remove_bridge_pid():
    try:
        (RUN / 'bridge.pid').unlink(missing_ok=True)
    except OSError:
        warn('无法删除 bridge.pid，消息桥继续运行')


class Supervisor:
    def __init__(self, started):
        self.started = started
        self.marked = False
        self.stopping = False
        self.requested = False
        self.child = None
        self.child_started = 0
        self.next_start = 0
        self.backoff = 2
        self.pending = {'stdout': b'', 'stderr': b''}
        self.selector = selectors.DefaultSelector()

    def terminate(self, signum, frame):
        self.stopping = True

    def log_chunk(self, chunk, channel):
        try:
            stream = getattr(sys, channel).buffer
            stream.write(chunk)
            stream.flush()
        except OSError:
            warn(f'无法转发消息桥 {channel}')
        self.parse_output(chunk, channel)

    def parse_output(self, chunk, channel):
        lines = (self.pending[channel] + chunk).split(b'\n')
        self.pending[channel] = lines.pop()[-65536:]
        for line in lines:
            event = None
            if re.search(rb'\bwebsocket reconnect attempts exhausted after [0-9]+ attempts\b', line):
                event = 'exhausted'
            elif re.search(rb'\bdisconnected to wss://', line):
                event = 'disconnected'
            elif re.search(rb'\bwebsocket reconnecting: attempt [0-9]+\b', line):
                event = 'reconnecting'
            elif re.search(rb'\bconnected to wss://', line):
                event = 'connected'
            if event:
                write_bridge_file('bridge-state.json',
                                  {'event': event, 'at': datetime.now(timezone.utc).isoformat()})

    def read_output(self, channel):
        stream = getattr(self.child, channel)
        try:
            chunk = os.read(stream.fileno(), 65536)
        except BlockingIOError:
            return False
        if chunk:
            self.log_chunk(chunk, channel)
            return True
        try:
            self.selector.unregister(stream)
        except KeyError:
            pass
        return False

    def stop_child(self):
        if self.child is None:
            return
        try:
            os.killpg(self.child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        # 桥退出后仍可能留下引擎子进程，整组回收，避免旧桥继续处理消息。
        try:
            os.killpg(self.child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.child.wait()
        for channel in ('stdout', 'stderr'):
            while self.read_output(channel):
                pass
            if self.pending[channel]:
                self.parse_output(b'\n', channel)
            stream = getattr(self.child, channel)
            try:
                self.selector.unregister(stream)
            except KeyError:
                pass
            stream.close()
        self.child = None
        self.pending = {'stdout': b'', 'stderr': b''}
        remove_bridge_pid()

    def launch(self):
        write_bridge_file('bridge-state.json', {'event': None, 'at': None})
        self.pending = {'stdout': b'', 'stderr': b''}
        try:
            command = os.environ.get('WP_CC_CONNECT_BIN', '/opt/workpartner/bin/cc-connect')
            self.child = subprocess.Popen([command, '--config', str(BASE / 'config.toml')],
                                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, start_new_session=True)
        except OSError:
            warn('消息桥启动失败，稍后重试')
            self.next_start = time.monotonic() + self.backoff
            self.backoff = min(60, self.backoff * 2)
            return
        self.child_started = time.monotonic()
        for channel in ('stdout', 'stderr'):
            stream = getattr(self.child, channel)
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, channel)
        write_bridge_file('bridge.pid', self.child.pid)
        if not self.marked:
            elapsed = int((time.time() - self.started) * 1000)
            print(f'[startup] bridge-started +{elapsed}ms', file=sys.stderr, flush=True)
            self.marked = True

    def run(self):
        RUN.mkdir(mode=0o700, parents=True, exist_ok=True)
        RUN.chmod(0o700)
        with os.fdopen(os.open(RUN / 'supervisor.lock', os.O_CREAT | os.O_WRONLY, 0o600), 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 1
            fifo = RUN / 'restart.fifo'
            fifo.unlink(missing_ok=True)
            os.mkfifo(fifo, 0o600)
            fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
            self.selector.register(fd, selectors.EVENT_READ, 'restart')
            remove_bridge_pid()
            signal.signal(signal.SIGTERM, self.terminate)
            signal.signal(signal.SIGINT, self.terminate)
            error_backoff = 1
            try:
                while not self.stopping:
                    try:
                        now = time.monotonic()
                        if self.requested:
                            self.stop_child()
                            self.next_start = 0
                            self.backoff = 2
                            self.requested = False
                        if self.child and self.child.poll() is not None:
                            stable = now - self.child_started >= 300
                            self.stop_child()
                            if stable:
                                self.backoff = 2
                            self.next_start = time.monotonic() + self.backoff
                            self.backoff = min(60, self.backoff * 2)
                        if self.child is None and now >= self.next_start:
                            if (BASE / 'config.toml').is_file():
                                self.launch()
                            else:
                                self.next_start = now + 3
                        for key, _ in self.selector.select(timeout=0.1):
                            if key.data == 'restart':
                                if os.read(fd, 65536):
                                    self.requested = True
                            elif self.child:
                                self.read_output(key.data)
                        error_backoff = 1
                    except Exception as error:
                        # 不记录异常原文，避免桥日志或凭据进入额外诊断。
                        warn(f'消息桥守护循环异常（{type(error).__name__}），稍后重试')
                        until = time.monotonic() + error_backoff
                        while not self.stopping and time.monotonic() < until:
                            time.sleep(0.1)
                        error_backoff = min(60, error_backoff * 2)
            finally:
                self.stop_child()
                self.selector.close()
                os.close(fd)
                fifo.unlink(missing_ok=True)
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    query = commands.add_parser('info')
    query.add_argument('--refresh', action='store_true')
    commands.add_parser('restart')
    daemon = commands.add_parser('supervise', help=argparse.SUPPRESS)
    daemon.add_argument('--started', type=float, default=time.time())
    args = parser.parse_args()
    if args.command == 'supervise':
        return Supervisor(args.started).run()
    result = info(args.refresh) if args.command == 'info' else restart()
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())

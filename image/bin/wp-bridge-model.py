#!/usr/bin/env python3
"""Read or switch the messaging bridge model of the main agent; prints one JSON line."""
import http.client
import json
import os
from pathlib import Path
import socket
import sys
import tomllib

BASE = Path(os.environ.get('WP_CC_CONNECT_DIR', '/data/.cc-connect'))


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=8)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self.path))


def project():
    config = tomllib.loads((BASE / 'config.toml').read_text())
    return config, config['projects'][0]


def current():
    """The model the bridge persisted: the active provider's choice, else the agent option."""
    _, first = project()
    agent = first.get('agent', {})
    options = agent.get('options', {})
    active = options.get('provider')
    for provider in agent.get('providers', []):
        if active and provider.get('name') == active and provider.get('model'):
            return provider['model']
    return options.get('model')


def choose(model):
    config, first = project()
    data_dir = Path(config.get('data_dir') or BASE / 'data')
    body = json.dumps({'project': first['name'], 'model': model}).encode()
    connection = UnixConnection(data_dir / 'run' / 'api.sock')
    try:
        connection.request('POST', '/model', body, {'content-type': 'application/json'})
        response = connection.getresponse()
        response.read()
        return response.status == 200
    finally:
        connection.close()


def main(argv):
    try:
        if argv[1:] == ['get']:
            result = {'ok': True, 'model': current()}
        elif len(argv) == 3 and argv[1] == 'set' and argv[2] and '\n' not in argv[2]:
            result = {'ok': choose(argv[2])}
        else:
            print(json.dumps({'ok': False, 'error': 'usage'}))
            return 2
    except Exception as error:
        # Bridge configuration holds credentials; report the error type only.
        result = {'ok': False, 'error': type(error).__name__}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))

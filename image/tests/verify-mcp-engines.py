#!/usr/bin/env python3
"""Exercise the pinned clients against a local 12-tool hub and a local model stub; no paid calls."""
import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = 'offline-person-key'
TOOL = 'server__tool_11'
state = {'calls': [], 'schemas': [], 'headers': []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.path = self.path.split('?', 1)[0]
        if self.path == '/mcp':
            state['headers'].append(self.headers.get('Authorization'))
            if self.headers.get('Authorization') != 'Bearer ' + KEY:
                return self.reply({}, 401)
            method = body['method']
            if method == 'initialize':
                result = {'protocolVersion': body['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'offline-probe', 'version': '1'}}
            elif method == 'notifications/initialized':
                return self.reply({}, 202)
            elif method == 'tools/list':
                result = {'tools': [{'name': f'server__tool_{i}', 'description': 'Offline probe tool', 'inputSchema': {'type': 'object', 'properties': {}}} for i in range(12)]}
            elif method == 'tools/call':
                state['calls'].append(body['params']['name'])
                result = {'content': [{'type': 'text', 'text': 'offline-hub-ok'}], 'isError': False}
            else:
                result = {}
            return self.reply({'jsonrpc': '2.0', 'id': body.get('id'), 'result': result})
        if self.path.endswith('/count_tokens'):
            return self.reply({'input_tokens': 100})
        if self.path.endswith('/messages'):
            tools = body.get('tools', [])
            names = [tool['name'] for tool in tools]
            state['schemas'].append(names)
            selected = next((name for name in names if name.endswith(TOOL)), None)
            used = any(block.get('type') == 'tool_result' for message in body.get('messages', [])
                       if isinstance(message.get('content'), list) for block in message['content'])
            block = {'type': 'text', 'text': 'offline-hub-ok'} if used else {'type': 'tool_use', 'id': 'toolu_offline_probe', 'name': selected or 'missing_tool', 'input': {}}
            reason = 'end_turn' if used else 'tool_use'
            message = {'id': 'msg_offline', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 100, 'output_tokens': 1}}
            if not body.get('stream'):
                return self.reply({**message, 'content': [block], 'stop_reason': reason})
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            events = [('message_start', {'type': 'message_start', 'message': message}),
                      ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {**block, **({'input': {}} if block['type'] == 'tool_use' else {'text': ''})}})]
            if block['type'] == 'tool_use':
                events.append(('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': '{}'}}))
            else:
                events.append(('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': block['text']}}))
            events.extend([('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                           ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': reason, 'stop_sequence': None}, 'usage': {'output_tokens': 5}}),
                           ('message_stop', {'type': 'message_stop'})])
            for event, data in events:
                self.wfile.write(f'event: {event}\ndata: {json.dumps(data)}\n\n'.encode())
            return
        self.reply({}, 404)


def request(process, selector, message, buffer):
    process.stdin.write((json.dumps(message) + '\n').encode())
    process.stdin.flush()
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if not selector.select(0.2):
            continue
        chunk = os.read(process.stdout.fileno(), 65536)
        if not chunk:
            raise RuntimeError('Client exited before MCP response')
        buffer[0] += chunk
        while b'\n' in buffer[0]:
            line, buffer[0] = buffer[0].split(b'\n', 1)
            reply = json.loads(line)
            if reply.get('id') == message['id']:
                if 'error' in reply:
                    raise RuntimeError(str(reply['error']))
                return reply['result']
    raise TimeoutError('Client MCP response timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    args = parser.parse_args()
    binaries = {name: str(value.resolve()) for name, value in vars(args).items()}
    versions = {name: subprocess.check_output([binary, '--version'], stderr=subprocess.DEVNULL, text=True).strip() for name, binary in binaries.items()}
    assert versions == {'claude': '2.1.319 (Claude Code)', 'codex': 'codex-cli 0.167.0'}, versions
    service = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=service.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{service.server_port}'
    try:
        with tempfile.TemporaryDirectory(prefix='mcp-engine-check-') as temporary:
            home = Path(temporary)
            environment = {name: value for name, value in os.environ.items() if not any(word in name for word in ['ANTHROPIC', 'CLAUDE', 'CODEX', 'OPENAI'])}
            environment.update({'HOME': str(home), 'CODEX_HOME': str(home / '.codex'), 'ANTHROPIC_API_KEY': KEY,
                                'ANTHROPIC_BASE_URL': origin, 'DISABLE_AUTOUPDATER': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'NO_PROXY': '127.0.0.1,localhost'})
            config = {'name': 'workpartner-hub', 'url': origin + '/mcp', 'keyEnvironment': 'ANTHROPIC_API_KEY'}
            subprocess.run(['python3', '-I', str(Path(__file__).parents[1] / 'bin/wp-mcp-config.py')], input=json.dumps({'home': str(home), 'config': config, 'enabled': True}), text=True, env=environment, check=True, capture_output=True)
            result = subprocess.run([binaries['claude'], '-p', 'Call the last offline hub tool once.', '--model', 'claude-sonnet-4-6', '--dangerously-skip-permissions', '--tools', '', '--output-format', 'json'],
                                    cwd=home, env=environment, capture_output=True, text=True, timeout=40)
            if result.returncode or not state['calls']:
                raise RuntimeError('Claude probe failed: ' + result.stdout[-1500:] + result.stderr[-500:])
            assert state['calls'] == [TOOL], state['calls']
            names = state['schemas'][0]
            assert len([name for name in names if 'server__tool_' in name]) == 12, names
            assert not any(name.endswith('__find') or name.endswith('__call') for name in names), names
            claude_calls = len(state['calls'])
            process = subprocess.Popen([binaries['codex'], 'app-server'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=home, env=environment)
            selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ); buffer = [b'']
            try:
                request(process, selector, {'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'mcp-probe', 'version': '1'}, 'capabilities': {'experimentalApi': True}}}, buffer)
                process.stdin.write(b'{"method":"initialized","params":{}}\n'); process.stdin.flush()
                started = request(process, selector, {'id': 2, 'method': 'thread/start', 'params': {'cwd': str(home), 'approvalPolicy': 'never', 'sandbox': 'read-only'}}, buffer)
                thread_id = started['thread']['id']
                inventory = request(process, selector, {'id': 3, 'method': 'mcpServerStatus/list', 'params': {'threadId': thread_id}}, buffer)
                tools = inventory['data'][0]['tools']
                assert len(tools) == 12, list(tools)
                called = request(process, selector, {'id': 4, 'method': 'mcpServer/tool/call', 'params': {'threadId': thread_id, 'server': 'workpartner-hub', 'tool': TOOL, 'arguments': {}}}, buffer)
                assert called['content'][0]['text'] == 'offline-hub-ok', called
            finally:
                selector.close(); process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
                process.stdin.close(); process.stdout.close()
            assert len(state['calls']) == claude_calls + 1
            assert all(value == 'Bearer ' + KEY for value in state['headers'])
            assert KEY not in (home / '.claude.json').read_text()
            assert KEY not in (home / '.codex/config.toml').read_text()
            for artifact in home.rglob('*'):
                if artifact.is_file() and artifact.suffix in {'.log', '.json', '.jsonl', '.toml', '.yaml'}:
                    assert KEY.encode() not in artifact.read_bytes(), 'Client persisted the test credential in logs or configuration'
            print(json.dumps({'versions': versions, 'toolsPerEngine': 12, 'successfulCalls': {'claude': 1, 'codex': 1}, 'externalModelRequests': 0}, indent=2))
    finally:
        service.shutdown(); service.server_close()


if __name__ == '__main__':
    main()

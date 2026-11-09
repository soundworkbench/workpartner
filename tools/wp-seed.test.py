"""Exercise seed model discovery against an HTTP endpoint that rejects default clients."""
import ast
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
import urllib.request

SOURCE = Path(sys.argv.pop(1))


class ModelDiscovery(unittest.TestCase):
    def test_model_permissions_are_read_with_an_identified_client(self):
        requests = []
        allowed = [{'id': 'codex/gpt-6.1-sol'}]

        class Endpoint(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                requests.append((self.path, self.headers))
                if self.headers.get('User-Agent') != 'WorkPartner/1 (+https://github.com/soundworkbench/workpartner)':
                    self.send_response(403)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'data': allowed}).encode())

        server = HTTPServer(('127.0.0.1', 0), Endpoint)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        tree = ast.parse(SOURCE.read_text())
        definitions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                       and node.name in ('call', 'model_names', 'key_models')]
        scope = {'BASE': base, 'json': json, 'os': os, 'sys': sys, 'urllib': urllib}
        exec(compile(ast.Module(definitions, []), str(SOURCE), 'exec'), scope)
        with patch.dict(os.environ, {'ANTHROPIC_BASE_URL': base, 'ANTHROPIC_API_KEY': 'fixture-key'}):
            models = scope['key_models']()
            self.assertEqual(models, ['codex/gpt-6.1-sol', 'gpt-6.1-sol'])
            self.assertFalse(any(model.startswith('claude') for model in models))
            allowed.append({'id': 'claude/claude-sonnet-5-5'})
            self.assertEqual(scope['key_models'](), ['claude-sonnet-5-5', 'claude/claude-sonnet-5-5', 'codex/gpt-6.1-sol', 'gpt-6.1-sol'])
        self.assertEqual(len(requests), 2)
        for request_path, headers in requests:
            self.assertEqual(request_path, '/v1/models')
            self.assertEqual(headers['x-api-key'], 'fixture-key')
            self.assertEqual(headers['anthropic-version'], '2023-06-01')
            self.assertEqual(headers['Content-Type'], 'application/json')


if __name__ == '__main__':
    unittest.main()

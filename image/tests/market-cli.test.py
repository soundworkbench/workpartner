"""Tests for the authenticated wp-market helper without a running gateway."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'bin/wp-market'
loader = importlib.machinery.SourceFileLoader('wp_market_test_module', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class FakeResponse:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def __iter__(self):
        return iter(())

    def read(self, *_):
        return json.dumps(self.value).encode()


class MarketCliTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wp-market-test-')
        self.home = Path(self.temp.name)
        (self.home / '.zp-market-token').write_text('fixture-token\n')
        self.env = {'HOME': str(self.home), 'PARTNER_GATEWAY_ORIGIN': 'http://gateway.test'}

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, argv, response=None):
        captured = {}

        def urlopen(request, timeout=0):
            captured['request'] = request
            return FakeResponse(response or {'status': 'pending'})

        output = io.StringIO()
        old_argv = sys.argv
        try:
            sys.argv = ['wp-market'] + argv
            with patch.dict(os.environ, self.env, clear=False), patch('urllib.request.urlopen', urlopen), contextlib.redirect_stdout(output):
                module.main()
        finally:
            sys.argv = old_argv
        return json.loads(output.getvalue()), captured['request']

    def test_submit_semver_is_sent_and_omitting_it_preserves_legacy_body(self):
        result, request = self.run_cli(['submit', 'demo', '--title', 'a', '--description', 'b', '--example', 'c', '--semver', '1.2.0'])
        self.assertEqual(result['status'], 'pending')
        self.assertEqual(json.loads(request.data)['semver'], '1.2.0')

        _, request = self.run_cli(['submit', 'demo', '--title', 'a', '--description', 'b', '--example', 'c'])
        self.assertNotIn('semver', json.loads(request.data))

    def test_invalid_semver_does_not_make_a_request(self):
        output = io.StringIO()
        old_argv = sys.argv
        try:
            sys.argv = ['wp-market', 'submit', 'demo', '--semver', '1.2']
            with patch.dict(os.environ, self.env, clear=False), patch('urllib.request.urlopen') as urlopen, contextlib.redirect_stdout(output):
                with self.assertRaises(SystemExit) as raised:
                    module.main()
        finally:
            sys.argv = old_argv
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {'message': '版本号格式应为 1.2.3'})
        urlopen.assert_not_called()

    def test_share_skill_instructions_describe_semver_and_new_results(self):
        text = (SCRIPT.parent.parent / 'skills/share-skill/SKILL.md').read_text()
        self.assertIn('--semver', text)
        self.assertIn('manualReasons', text)
        self.assertIn('findings', text)
        self.assertNotIn('已经上架的技能更新后仍须作者确认并重新审批', text)


if __name__ == '__main__':
    unittest.main()

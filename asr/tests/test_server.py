import array
import concurrent.futures
import http.client
import io
import json
import os
import socket
import sys
import threading
import unittest
import wave
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

from asr.server import Config, RATE, Server


def wav(seconds=1, channels=1, rate=RATE, width=2, samples=None):
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(width)
        audio.setframerate(rate)
        audio.writeframes(samples if samples is not None else b'\0' * int(seconds * rate) * channels * width)
    return output.getvalue()


class FakeRecognizer:
    def __init__(self):
        self.text = '开放时间 private transcription'
        self.texts = None
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.fail = False

    def create_stream(self):
        stream = SimpleNamespace(result=SimpleNamespace(text=''))
        stream.accept_waveform = lambda rate, samples: self.calls.append((rate, samples))
        return stream

    def decode_stream(self, stream):
        self.entered.set()
        if not self.release.wait(5):
            raise RuntimeError('fake timed out')
        if self.fail:
            raise RuntimeError(self.text)
        stream.result.text = next(self.texts) if self.texts is not None else self.text


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeRecognizer()
        self.created = 0

        def factory(config):
            self.created += 1
            return self.fake

        self.server = Server(('127.0.0.1', 0), Config(queue_timeout=0.05, max_pending=2), factory)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01})
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.fake.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body=None, method='POST', path='/v1/recognize', headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request(method, path, body=body,
                               headers=headers if headers is not None else {'Content-Type': 'audio/wav'})
            response = connection.getresponse()
            data = response.read()
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def raw_request(self, headers):
        with socket.create_connection(self.server.server_address, timeout=2) as connection:
            connection.sendall(('POST /v1/recognize HTTP/1.1\r\nHost: localhost\r\n'
                                'Content-Type: audio/wav\r\n' + headers + '\r\n').encode())
            response = http.client.HTTPResponse(connection)
            response.begin()
            return response.status, json.loads(response.read())

    def test_normal_and_health(self):
        self.assertEqual(self.request(method='GET', path='/healthz'), (200, {'ok': True}))
        for content_type in ('audio/wav', 'audio/x-wav'):
            status, result = self.request(wav(), headers={'Content-Type': content_type})
            self.assertEqual(status, 200)
            self.assertEqual(result['text'], self.fake.text)
            self.assertEqual(result['seconds'], 1)
            self.assertGreaterEqual(result['elapsedMs'], 0)
        self.assertEqual(self.created, 1)
        self.assertEqual(self.fake.calls[0][0], RATE)
        self.assertEqual(len(self.fake.calls[0][1]), RATE)

    def test_tags(self):
        self.fake.text = '  <|zh|><|NEUTRAL|><|Speech|> 开放时间 <|withitn|>  '
        self.assertEqual(self.request(wav())[1]['text'], '开放时间')

    def test_media_type(self):
        for headers in ({}, {'Content-Type': 'application/octet-stream'}):
            self.assertEqual(self.request(wav(), headers=headers),
                             (415, {'error': 'unsupported_media_type'}))
        self.assertEqual(self.fake.calls, [])

    def test_length_rejected_without_reading_body(self):
        for headers in ('Content-Length: 2097153\r\n', '', 'Content-Length: -1\r\n',
                        'Content-Length: invalid\r\n', 'Transfer-Encoding: chunked\r\n',
                        'Content-Length: 1\r\nContent-Length: 2\r\n'):
            with self.subTest(headers=headers):
                self.assertEqual(self.raw_request(headers), (413, {'error': 'too_large'}))
        self.assertEqual(self.fake.calls, [])

    def test_bad_audio(self):
        for body in (wav(channels=2), wav(rate=8000), wav(width=3), b'not a wav', wav()[:-2]):
            with self.subTest(size=len(body)):
                self.assertEqual(self.request(body), (400, {'error': 'bad_audio'}))
        self.assertEqual(self.fake.calls, [])

    def test_transfer_encoding_rejected_without_reading_body(self):
        for encoding in ('chunked', 'identity', '', ' '):
            with self.subTest(encoding=encoding):
                self.assertEqual(self.raw_request(
                    f'Content-Length: 32044\r\nTransfer-Encoding: {encoding}\r\n'),
                    (413, {'error': 'too_large'}))
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.request(wav())[0], 200)

    def test_duration(self):
        self.assertEqual(self.request(wav(60.1)), (400, {'error': 'too_long'}))
        self.assertEqual(self.request(wav(0.299)), (200, {'text': ''}))
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.request(wav(0.3))[1]['text'], self.fake.text)

    def test_busy_and_lock_reuse(self):
        self.fake.release.clear()
        with concurrent.futures.ThreadPoolExecutor() as executor:
            first = executor.submit(self.request, wav())
            try:
                self.assertTrue(self.fake.entered.wait(2))
                for _ in range(3):
                    self.assertEqual(self.request(wav()), (503, {'error': 'busy'}))
                self.assertEqual(self.request(method='GET', path='/healthz'), (200, {'ok': True}))
                self.assertEqual(len(self.fake.calls), 1)
            finally:
                self.fake.release.set()
            self.assertEqual(first.result()[0], 200)
        self.assertEqual(self.request(wav())[0], 200)
        self.assertEqual(self.created, 1)

    def test_pending_limit_rejects_before_reading_body_and_recovers(self):
        self.server.config = replace(self.server.config, queue_timeout=3)
        self.fake.release.clear()
        waiting = threading.Event()
        recognition_lock = self.server.recognition_lock

        def acquire(*args, **kwargs):
            waiting.set()
            return recognition_lock.acquire(*args, **kwargs)

        with concurrent.futures.ThreadPoolExecutor() as executor:
            first = executor.submit(self.request, wav())
            try:
                self.assertTrue(self.fake.entered.wait(2))
                with patch.object(self.server, 'recognition_lock', wraps=recognition_lock) as lock:
                    lock.acquire.side_effect = acquire
                    second = executor.submit(self.request, wav())
                    try:
                        self.assertTrue(waiting.wait(2))
                        for _ in range(3):
                            self.assertEqual(self.raw_request('Content-Length: 32044\r\n'),
                                             (503, {'error': 'busy'}))
                        self.assertEqual(self.request(method='GET', path='/healthz'),
                                         (200, {'ok': True}))
                        self.assertEqual(len(self.fake.calls), 1)
                    finally:
                        self.fake.release.set()
                    self.assertEqual(first.result()[0], 200)
                    self.assertEqual(second.result()[0], 200)
            finally:
                self.fake.release.set()
        for _ in range(3):
            self.assertEqual(self.request(wav())[0], 200)
        self.assertEqual(self.created, 1)

    def test_segmentation_uses_silence_and_preserves_samples(self):
        samples = array.array('h', [8192]) * (54 * RATE)
        samples[23 * RATE:23 * RATE + RATE // 10] = array.array('h', [0]) * (RATE // 10)
        expected = [value / 32768.0 for value in samples]
        if sys.byteorder != 'little':
            samples.byteswap()
        status, result = self.request(wav(samples=samples.tobytes()))
        self.assertEqual(status, 200)
        self.assertEqual(result['seconds'], 54)
        self.assertEqual(len(self.fake.calls), 3)
        cut = len(self.fake.calls[0][1])
        self.assertGreaterEqual(cut, 23 * RATE)
        self.assertLess(cut, 23 * RATE + RATE // 10)
        self.assertTrue(all(len(chunk) <= 25 * RATE for _, chunk in self.fake.calls))
        self.assertEqual([value for _, chunk in self.fake.calls for value in chunk], expected)
        self.assertEqual(result['text'], self.fake.text * 3)

    def test_segment_text_joining(self):
        cases = (
            ([' 早上9点', '至下午5点 '], '早上9点至下午5点'),
            (['Hello', 'World'], 'Hello World'),
            (['Room', '9'], 'Room 9'),
            (['9', 'Rooms'], '9 Rooms'),
            (['9', '10'], '9 10'),
            (['中文', 'English'], '中文English'),
            (['English', '中文'], 'English中文'),
            (['你好，', '世界。'], '你好，世界。'),
            (['hello,', 'world'], 'hello,world'),
            (['hello', '.'], 'hello.'),
            (['café', 'time'], 'cafétime'),
            (['room', '９'], 'room９'),
            (['<|zh|>', ' 文字 <|withitn|>'], '文字'),
            (['文字', ''], '文字'),
            (['', ''], ''),
            (['hello', '<|Speech|>', 'world'], 'hello world'),
        )
        for parts, expected in cases:
            with self.subTest(parts=parts):
                self.fake.calls.clear()
                self.fake.texts = iter(parts)
                status, result = self.request(wav(54 if len(parts) == 3 else 26))
                self.assertEqual(status, 200)
                self.assertEqual(result['text'], expected)

    def test_routes_and_methods(self):
        for method in ('GET', 'POST', 'PUT'):
            self.assertEqual(self.request(method=method, path='/missing')[0], 404)
        for method, path in (('GET', '/v1/recognize'), ('POST', '/healthz'),
                             ('DELETE', '/v1/recognize'), ('OPTIONS', '/healthz'),
                             ('PATCH', '/healthz'), ('CUSTOM', '/healthz'), ('HEAD', '/healthz')):
            self.assertEqual(self.request(method=method, path=path)[0], 405)

    def test_private_logs_and_failure_releases_lock(self):
        with self.assertLogs('asr', level='INFO') as captured:
            self.assertEqual(self.request(wav())[0], 200)
            self.fake.fail = True
            for _ in range(3):
                self.assertEqual(self.request(wav()), (500, {'error': 'recognition_failed'}))
            self.fake.fail = False
            self.assertEqual(self.request(wav())[0], 200)
            self.request(path='/' + self.fake.text.replace('开放时间 ', '').replace(' ', '-'))
        logs = '\n'.join(captured.output)
        self.assertNotIn(self.fake.text, logs)
        self.assertNotIn('private', logs)
        self.assertIn('status=200 seconds=1.0 elapsedMs=', logs)
        self.assertIn('status=500', logs)


class ConfigTests(unittest.TestCase):
    def test_max_pending_environment(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(Config.from_env().max_pending, 4)
            os.environ['ASR_MAX_PENDING'] = '2'
            self.assertEqual(Config.from_env().max_pending, 2)
            for value in ('0', '-1', '1.5', 'invalid'):
                with self.subTest(value=value):
                    os.environ['ASR_MAX_PENDING'] = value
                    with self.assertRaises(ValueError):
                        Config.from_env()


if __name__ == '__main__':
    unittest.main()

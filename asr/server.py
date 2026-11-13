#!/usr/bin/env python3
import array
import io
import json
import logging
import math
import os
import re
import sys
import threading
import time
import wave
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


RATE = 16000
LOG = logging.getLogger('asr')


@dataclass(frozen=True)
class Config:
    port: int = 8080
    max_bytes: int = 2097152
    max_seconds: float = 60
    queue_timeout: float = 10
    threads: int = 2
    model_dir: str = '/opt/model'

    @classmethod
    def from_env(cls):
        config = cls(
            port=int(os.environ.get('ASR_PORT', 8080)),
            max_bytes=int(os.environ.get('ASR_MAX_BYTES', 2097152)),
            max_seconds=float(os.environ.get('ASR_MAX_SECONDS', 60)),
            queue_timeout=float(os.environ.get('ASR_QUEUE_TIMEOUT', 10)),
            threads=int(os.environ.get('ASR_THREADS', 2)),
            model_dir=os.environ.get('ASR_MODEL_DIR', '/opt/model'),
        )
        if not 1 <= config.port <= 65535 or any(
            not math.isfinite(value) or value <= 0 for value in
            (config.max_bytes, config.max_seconds, config.queue_timeout, config.threads)
        ):
            raise ValueError('Invalid ASR configuration')
        return config


def create_recognizer(config):
    import sherpa_onnx

    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(Path(config.model_dir) / 'model.int8.onnx'),
        tokens=str(Path(config.model_dir) / 'tokens.txt'),
        num_threads=config.threads, use_itn=True, language='auto',
    )


def segments(samples):
    start = 0
    window = RATE // 10
    while len(samples) - start > 25 * RATE:
        boundary = start + 25 * RATE
        quiet = min(range(boundary - 5 * RATE, boundary - window + 1, window),
                    key=lambda offset: sum(value * value for value in samples[offset:offset + window]))
        end = quiet + window // 2
        yield samples[start:end]
        start = end
    yield samples[start:]


class Server(ThreadingHTTPServer):
    def __init__(self, address, config, recognizer_factory=create_recognizer):
        self.config = config
        self.recognizer = recognizer_factory(config)
        self.recognition_lock = threading.Lock()
        super().__init__(address, Handler)

    def handle_error(self, request, client_address):
        # Exceptions from clients or native bindings must not expose request data.
        LOG.info('status=500 seconds=0 elapsedMs=0')


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format, *args):
        pass

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.close_connection = True
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        if status == 405:
            self.send_header('Allow', 'GET' if self.path == '/healthz' else 'POST')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        LOG.info('status=%s seconds=%s elapsedMs=%s', status,
                 getattr(self, 'seconds', 0), getattr(self, 'elapsed_ms', 0))

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {'error': 'bad_request'})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.dispatch
        raise AttributeError(name)

    def dispatch(self):
        if self.path not in ('/healthz', '/v1/recognize'):
            self.reply(404, {'error': 'not_found'})
        elif self.command == 'GET' and self.path == '/healthz':
            self.reply(200, {'ok': True})
        elif self.command == 'POST' and self.path == '/v1/recognize':
            self.recognize()
        else:
            self.reply(405, {'error': 'method_not_allowed'})

    def recognize(self):
        config = self.server.config
        content_type = self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
        if content_type not in ('audio/wav', 'audio/x-wav'):
            self.reply(415, {'error': 'unsupported_media_type'})
            return
        lengths = self.headers.get_all('Content-Length', [])
        if (len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,20}', lengths[0])
                or int(lengths[0]) > config.max_bytes or self.headers.get('Transfer-Encoding')):
            self.reply(413, {'error': 'too_large'})
            return
        length = int(lengths[0])
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError()
            with wave.open(io.BytesIO(body), 'rb') as audio:
                if (audio.getcomptype() != 'NONE' or audio.getsampwidth() != 2
                        or audio.getnchannels() != 1 or audio.getframerate() != RATE):
                    raise ValueError()
                frames = audio.getnframes()
                pcm = audio.readframes(frames)
                if len(pcm) != frames * 2 or audio.readframes(1):
                    raise ValueError()
            self.seconds = frames / RATE
        except (wave.Error, EOFError, ValueError, OSError):
            self.reply(400, {'error': 'bad_audio'})
            return
        if self.seconds > config.max_seconds:
            self.reply(400, {'error': 'too_long'})
            return
        if self.seconds < 0.3:
            self.reply(200, {'text': ''})
            return
        if not self.server.recognition_lock.acquire(timeout=config.queue_timeout):
            self.reply(503, {'error': 'busy'})
            return
        started = time.monotonic()
        try:
            samples = array.array('h', pcm)
            if sys.byteorder != 'little':
                samples.byteswap()
            texts = []
            recognizer = self.server.recognizer
            for segment in segments(samples):
                stream = recognizer.create_stream()
                stream.accept_waveform(RATE, [value / 32768.0 for value in segment])
                recognizer.decode_stream(stream)
                texts.append(re.sub(r'<\|.*?\|>', '', stream.result.text, flags=re.DOTALL).strip())
            result = {'text': ' '.join(text for text in texts if text).strip(), 'seconds': self.seconds}
        except Exception:
            result = {'error': 'recognition_failed'}
        finally:
            self.elapsed_ms = round((time.monotonic() - started) * 1000, 3)
            self.server.recognition_lock.release()
        if 'error' in result:
            self.reply(500, result)
        else:
            self.reply(200, {**result, 'elapsedMs': self.elapsed_ms})


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    config = Config.from_env()
    with Server(('0.0.0.0', config.port), config) as server:
        server.serve_forever()

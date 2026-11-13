# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS model
ADD --checksum=sha256:7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2 /tmp/model.tar.bz2
RUN mkdir /model && python - <<'PY'
import tarfile
from pathlib import Path

prefix = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/'
with tarfile.open('/tmp/model.tar.bz2', 'r:bz2') as archive:
    for name in ('model.int8.onnx', 'tokens.txt', 'LICENSE', 'README.md',
                 'test_wavs/zh.wav', 'test_wavs/en.wav'):
        target = Path('/model') / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(prefix + name) as source:
            target.write_bytes(source.read())
PY

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ASR_MODEL_DIR=/opt/model
COPY requirements.txt /app/requirements.txt
RUN pip install --require-hashes --only-binary=:all: --no-cache-dir -r /app/requirements.txt \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin asr
COPY --from=model /model /opt/model
COPY server.py /app/server.py
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('ASR_PORT', '8080') + '/healthz', timeout=2).read()"]
CMD ["python", "/app/server.py"]

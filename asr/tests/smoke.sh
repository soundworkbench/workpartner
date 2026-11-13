#!/bin/bash
set -euo pipefail
[[ $# == 1 && -n $1 ]] || { echo 'Usage: smoke.sh IMAGE' >&2; exit 2; }
container=
cleanup() {
  local status=$?
  if [[ -n $container ]]; then
    if (( status != 0 )); then docker logs "$container" >&2 || true; fi
    docker rm -f "$container" >/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
container=$(docker run -d --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 2 --memory 2g "$1")
docker exec -i "$container" python - <<'PY'
import http.client
import json
import os
import time
from pathlib import Path

assert os.getuid() != 0, 'Container must run as non-root'


def request(method, path, body=None, headers=None, timeout=180):
    connection = http.client.HTTPConnection('127.0.0.1', 8080, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


deadline = time.monotonic() + 300
while time.monotonic() < deadline:
    try:
        if request('GET', '/healthz', timeout=2) == (200, {'ok': True}):
            break
    except (OSError, http.client.HTTPException):
        pass
    time.sleep(1)
else:
    raise SystemExit('ASR did not become healthy within 300 seconds')

model = Path(os.environ['ASR_MODEL_DIR'])
for name in ('LICENSE', 'README.md', 'test_wavs/en.wav'):
    assert (model / name).is_file(), 'Required model attribution or sample missing'
status, result = request('POST', '/v1/recognize', (model / 'test_wavs/zh.wav').read_bytes(),
                         {'Content-Type': 'audio/wav'})
assert status == 200, f'Recognition status: {status}'
assert '早上9点至下午5点' in result['text'], f"Expected phrase missing from recognition: {result['text']!r}"
assert result['seconds'] > 0 and result['elapsedMs'] >= 0
print(f"ASR smoke: seconds={result['seconds']} elapsedMs={result['elapsedMs']}", flush=True)

# Send only headers: an oversized request must be rejected before waiting for a body.
connection = http.client.HTTPConnection('127.0.0.1', 8080, timeout=3)
try:
    connection.putrequest('POST', '/v1/recognize')
    connection.putheader('Content-Type', 'audio/wav')
    connection.putheader('Content-Length', '2097153')
    connection.endheaders()
    response = connection.getresponse()
    assert response.status == 413
    assert json.loads(response.read()) == {'error': 'too_large'}
finally:
    connection.close()
assert request('POST', '/v1/recognize', b'invalid', {'Content-Type': 'text/plain'}) == (
    415, {'error': 'unsupported_media_type'})
print('ASR smoke: 413 and 415 passed', flush=True)
PY

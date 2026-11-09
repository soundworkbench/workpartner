#!/usr/bin/python3
"""Preserve completed web-search metadata through AionCore's tool-output field.

Installed beside codex.real. All other Codex commands run directly; app-server
stdin and stderr remain inherited, while stdout stays newline-delimited JSON.
"""
import json
import os
import signal
import subprocess
import sys


def search_output(line):
    """Add the completed item only where AionCore otherwise discards its data."""
    if b'item/completed' not in line or b'webSearch' not in line:
        return line
    try:
        frame = json.loads(line)
    except (ValueError, UnicodeError):
        return line
    if not isinstance(frame, dict) or frame.get('method') != 'item/completed':
        return line
    params = frame.get('params')
    item = params.get('item') if isinstance(params, dict) else None
    if not isinstance(item, dict) or item.get('type') != 'webSearch':
        return line
    # Existing output belongs to Codex; do not overwrite it on a future version.
    if item.get('aggregatedOutput'):
        return line
    item['aggregatedOutput'] = json.dumps({'wpWebSearch': item.copy()}, ensure_ascii=False)
    return (json.dumps(frame, ensure_ascii=False) + '\n').encode()


def main():
    executable = os.path.realpath(__file__) + '.real'
    args = sys.argv[1:]
    if not args or args[0] != 'app-server':
        os.execv(executable, [executable, *args])
    child = subprocess.Popen([executable, *args], stdout=subprocess.PIPE)
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, lambda sig, _frame: child.send_signal(sig))
    try:
        for line in child.stdout:
            sys.stdout.buffer.write(search_output(line))
            sys.stdout.buffer.flush()
    except BrokenPipeError:
        child.terminate()
        # Avoid a second flush of the disconnected pipe at interpreter exit.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
    finally:
        child.stdout.close()
    code = child.wait()
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(main())

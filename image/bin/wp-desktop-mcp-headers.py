#!/usr/bin/env python3
"""Read the container credential on demand; emit only the header to Claude Code."""
import json
from pathlib import Path
import re
import sys


def main():
    token = Path('/data/.zp-market-token').read_text().strip()
    if '\r' in token or '\n' in token or not re.fullmatch(r'zpd\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}', token):
        return 1
    print(json.dumps({'Authorization': 'Bearer ' + token}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)

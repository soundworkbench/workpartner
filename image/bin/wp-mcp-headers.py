#!/usr/bin/env python3
"""Claude Code dynamic headers: credentials travel on stdout to the client only."""
import json
import os
import re
import sys

if len(sys.argv) != 2 or not re.fullmatch(r'[A-Z_][A-Z0-9_]*', sys.argv[1]):
    sys.exit(1)
key = os.environ.get(sys.argv[1], '')
if not key or '\r' in key or '\n' in key:
    sys.exit(1)
print(json.dumps({'Authorization': 'Bearer ' + key}))

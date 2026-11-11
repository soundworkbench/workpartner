#!/usr/bin/env python3
"""Preview a personal messaging bridge migration; --apply writes managed keys."""
import argparse
from pathlib import Path
import runpy

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('config', type=Path)
parser.add_argument('--model', required=True, help='organization Claude model default')
parser.add_argument('--effort', required=True, help='organization reasoning effort default')
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
helper = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'image/bin/wp-bridge-defaults.py'))
changed = helper['refresh'](args.config, args.model, args.effort, apply=args.apply)
print(('Updated' if args.apply else 'Would update') if changed else 'Unchanged (see any warning above)')

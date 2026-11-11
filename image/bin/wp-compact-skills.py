"""Shorten generated descriptions; retain original scope and routing on demand."""
import json
from pathlib import Path
import re
import sys

import yaml


def compact(skills, descriptions):
    replacements = json.loads(descriptions.read_text(encoding='utf-8'))
    changed = 0
    for path in sorted(skills.rglob('SKILL.md')):
        source = path.read_bytes().decode('utf-8')
        match = re.match(r'\A\ufeff?---\r?\n(.*?)\r?\n---(?:\r?\n|$)', source, re.S)
        if not match:
            raise ValueError(f'Missing frontmatter: {path}')
        meta = yaml.safe_load(match[1])
        if not isinstance(meta, dict) or any(not isinstance(meta.get(key), str) or not meta[key].strip()
                                            for key in ('name', 'description')):
            raise ValueError(f'Missing name or description: {path}')
        description = replacements.get(meta['name'])
        if description is None or description == meta['description']:
            continue
        if not isinstance(description, str) or not description.strip() or len(description) >= len(meta['description']):
            raise ValueError(f'Replacement must be shorter nonempty text: {path}')
        original = meta['description']
        meta['description'] = description
        header = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False, width=1000).rstrip()
        body = source[match.end():]
        path.write_bytes(('---\n' + header + '\n---\n\n## Original scope and routing\n\n'
                          + original + '\n\n' + body).encode('utf-8'))
        changed += 1
    print(f'Compacted {changed} skill descriptions')


if __name__ == '__main__':
    compact(Path(sys.argv[1]), Path(sys.argv[2]))

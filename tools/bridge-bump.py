"""Move the cc-connect pin in the third-party lock to the bridge's newest release.

plan   reads a GitHub releases listing and prints GitHub step outputs:
       state=current|skip|bump, plus tag, version, url and release for a bump.
apply  pins a downloaded asset: lock entry (version, url, release, sha256, bytes)
       and the version and digest strings in the deployment reference.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

DESTINATION = 'cc-connect'
SUFFIX = '-linux-amd64'


def bridge_entry(lock):
    entries = [entry for entry in lock['artifacts'] if entry['destination'] == DESTINATION]
    if len(entries) != 1:
        raise SystemExit(f'lock needs exactly one {DESTINATION} entry')
    return entries[0]


def summary(text):
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a', encoding='utf-8') as handle:
            handle.write(text + '\n')
    print(text, file=sys.stderr)


def plan(releases, lock):
    """Newest non-draft release by publication time, compared with the pin."""
    published = [release for release in releases if not release['draft']]
    if not published:
        return {'state': 'skip', 'reason': 'no published release'}
    release = max(published, key=lambda item: item['published_at'] or '')
    tag = release['tag_name']
    assets = [asset for asset in release['assets'] if asset['name'].endswith(SUFFIX)]
    if len(assets) != 1:
        return {'state': 'skip', 'tag': tag, 'reason': f'release {tag} has no single {SUFFIX} asset'}
    url = assets[0]['browser_download_url']
    if bridge_entry(lock)['url'] == url:
        return {'state': 'current', 'tag': tag}
    return {'state': 'bump', 'tag': tag, 'version': tag.removeprefix('v'),
            'url': url, 'release': release['html_url']}


def apply(lock_path, docs_path, tag, url, release, binary):
    lock = json.loads(lock_path.read_text(encoding='utf-8'))
    entry = bridge_entry(lock)
    data = binary.read_bytes()
    old_tag = entry['release'].rsplit('/', 1)[-1]
    old_digest = entry['sha256']
    entry.update(version=tag.removeprefix('v'), url=url, release=release,
                 sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
    docs = docs_path.read_text(encoding='utf-8')
    if old_digest not in docs or f'`{old_tag}`' not in docs:
        raise SystemExit(f'{docs_path} does not quote the pinned {old_tag} and its SHA-256')
    docs = docs.replace(old_digest, entry['sha256']).replace(old_tag, tag)
    lock_path.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    docs_path.write_text(docs, encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    planner = commands.add_parser('plan')
    planner.add_argument('releases', type=Path)
    planner.add_argument('lock', type=Path)
    pinner = commands.add_parser('apply')
    pinner.add_argument('lock', type=Path)
    pinner.add_argument('docs', type=Path)
    pinner.add_argument('binary', type=Path)
    for name in ('--tag', '--url', '--release'):
        pinner.add_argument(name, required=True)
    args = parser.parse_args()
    if args.command == 'plan':
        result = plan(json.loads(args.releases.read_text(encoding='utf-8')),
                      json.loads(args.lock.read_text(encoding='utf-8')))
        if result['state'] == 'skip':
            summary(f'Bridge bump skipped: {result["reason"]}.')
        elif result['state'] == 'current':
            summary(f'Bridge pin already matches cc-connect {result["tag"]}.')
        for key, value in result.items():
            print(f'{key}={value}')
    else:
        apply(args.lock, args.docs, args.tag, args.url, args.release, args.binary)


if __name__ == '__main__':
    main()

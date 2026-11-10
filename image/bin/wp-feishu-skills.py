"""Unpack the pinned official skills, preserving references and licenses for both engines."""
import json
import gzip
import io
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


def pack(sources, output):
    """Combine official commit archives into a deterministic skills/license bundle."""
    files = {}
    for source, scope in zip(sources, ('lark', 'meegle'), strict=True):
        with tarfile.open(source, 'r:gz') as bundle:
            for member in bundle:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts:
                    raise ValueError('Invalid upstream skill path')
                parts = path.parts[1:]
                if not parts:
                    continue
                if parts == ('LICENSE',):
                    name = 'LICENSE-' + scope
                elif parts[0] == 'skills' and len(parts) > 1:
                    name = str(PurePosixPath(*parts[1:]))
                else:
                    continue
                if member.isdir():
                    continue
                if not member.isfile() or name in files:
                    raise ValueError('Invalid or duplicate upstream skill member')
                files[name] = bundle.extractfile(member).read()
    for required in ('LICENSE-lark', 'LICENSE-meegle', 'lark-doc/SKILL.md', 'meegle/SKILL.md'):
        if required not in files:
            raise ValueError('Missing official skills or license')
    with output.open('wb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as compressed:
        with tarfile.open(mode='w', fileobj=compressed) as bundle:
            for name, data in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = 0o644
                bundle.addfile(member, io.BytesIO(data))


def install(archive, destination, policy=None):
    """Install official references and a generic or organization-supplied policy."""
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Invalid bundled skill archive')
        for member in members:
            # The released private archive used a company-specific policy name.
            if PurePosixPath(member.name).parts[0] == 'company-feishu':
                continue
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
    policy = policy or Path(__file__).parents[1] / 'home/feishu-SKILL.md'
    (destination / 'feishu').mkdir(exist_ok=True)
    shutil.copyfile(policy, destination / 'feishu/SKILL.md')
    names = sorted(p.name for p in destination.iterdir() if (p / 'SKILL.md').is_file()
                   and (p.name.startswith('lark-') or p.name in ('feishu', 'meegle')))
    (destination / '.wp-feishu-skills.json').write_text(json.dumps(names) + '\n')


if __name__ == '__main__':
    if sys.argv[1] == '--pack':
        pack([Path(sys.argv[2]), Path(sys.argv[3])], Path(sys.argv[4]))
    else:
        install(Path(sys.argv[1]), Path(sys.argv[2]))

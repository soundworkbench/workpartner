"""Download versioned HTTPS build inputs, verify archive SHA-256, then unpack safely."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
from urllib.parse import urlsplit
from urllib.request import urlopen


def relative(value):
    """Accept a nonempty portable relative destination, without traversal."""
    path = PurePosixPath(value)
    if not value or path.is_absolute() or '..' in path.parts or '\\' in value:
        raise ValueError('invalid artifact destination')
    return path


def download(entry, destination):
    """Verify the complete downloaded bytes before writing any package files."""
    url = urlsplit(entry['url'])
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or not entry['version'] or not re.fullmatch(r'[0-9a-f]{64}', entry['sha256'])):
        raise ValueError('build input requires version, HTTPS URL and SHA-256')
    target = destination / relative(entry['destination'])
    with tempfile.TemporaryFile() as payload:
        digest = hashlib.sha256()
        with urlopen(entry['url'], timeout=60) as response:
            if urlsplit(response.url).scheme != 'https':
                raise ValueError('build input redirected away from HTTPS')
            while chunk := response.read(1024 * 1024):
                payload.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != entry['sha256']:
            raise ValueError('build input SHA-256 mismatch')
        payload.seek(0)
        if entry['format'] == 'file':
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                shutil.copyfileobj(payload, output)
            target.chmod(0o755)
        elif entry['format'] == 'tar-member':
            member_name = str(relative(entry['member']))
            with tarfile.open(fileobj=payload) as archive:
                matches = [member for member in archive if member.name == member_name]
                if len(matches) != 1 or not matches[0].isfile():
                    raise ValueError('archive must contain exactly one regular selected member')
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(matches[0]) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755)
        elif entry['format'] == 'tar':
            strip = entry['stripComponents']
            if type(strip) is not int or strip < 0:
                raise ValueError('invalid archive stripComponents')
            replacements = entry.get('symlinkReplacements', {})
            links = {}
            with tarfile.open(fileobj=payload) as archive:
                for member in archive:
                    parts = relative(member.name).parts[strip:]
                    if not parts:
                        continue
                    output = target.joinpath(*parts)
                    if member.isdir():
                        output.mkdir(parents=True, exist_ok=True)
                    elif member.isfile():
                        output.parent.mkdir(parents=True, exist_ok=True)
                        with archive.extractfile(member) as source, output.open('xb') as stream:
                            shutil.copyfileobj(source, stream)
                        output.chmod(0o755 if member.mode & 0o111 else 0o644)
                    elif member.issym() and member.name in replacements:
                        replacement = replacements[member.name]
                        if (not replacement or PurePosixPath(replacement).is_absolute()
                                or '\\' in replacement or member.name in links):
                            raise ValueError('invalid replacement symlink')
                        resolved = (output.parent / replacement).resolve()
                        if not resolved.is_relative_to(target.resolve()):
                            raise ValueError('replacement symlink escapes package directory')
                        links[member.name] = (output, replacement, resolved)
                    else:
                        raise ValueError('archive links and special files are forbidden')
            if set(links) != set(replacements):
                raise ValueError('archive is missing a declared symlink')
            for output, replacement, resolved in links.values():
                if not resolved.is_file() or resolved.is_symlink():
                    raise ValueError('replacement symlink must target an extracted regular file')
                output.parent.mkdir(parents=True, exist_ok=True)
                output.symlink_to(replacement)
        else:
            raise ValueError('unsupported artifact format')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lock', type=Path)
    parser.add_argument('destination', type=Path, help='new package directory')
    args = parser.parse_args()
    entries = json.loads(args.lock.read_text())['artifacts']
    expected = {'aionui-web', 'cc-connect', 'officecli', 'codex', 'codex-code-mode-host', 'claude'}
    if {entry['destination'] for entry in entries} != expected or len(entries) != len(expected):
        raise ValueError('lock must pin each required build input exactly once')
    if args.destination.exists():
        raise ValueError('package directory already exists')
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.destination.parent) as staging:
        for entry in entries:
            download(entry, Path(staging))
        Path(staging).rename(args.destination)


if __name__ == '__main__':
    main()

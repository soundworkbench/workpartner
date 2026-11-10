import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function outsideRepository(directory) {
  const absolute = path.resolve(directory);
  // Check both spelling and real location, including not-yet-created children.
  let existing = absolute;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.resolve(fs.realpathSync(existing), path.relative(existing, absolute));
  for (const candidate of [absolute, real]) {
    for (let parent = candidate; ; parent = path.dirname(parent)) {
      const git = path.join(parent, '.git');
      if (fs.existsSync(git) && (fs.statSync(git).isFile() || fs.existsSync(path.join(git, 'HEAD')))) {
        throw new Error('--output must be outside any git repository');
      }
      if (parent === path.dirname(parent)) break;
    }
  }
  return real;
}

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function privateFile(file, data) {
  // Replace rather than follow an existing symlink or preserve permissive modes.
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

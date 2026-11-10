import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

/** Prepare only the signed container identity and public wrapper settings in the next user's volume.
 * @param options Resolved organization, existing per-user token signer and optional test UID.
 * @returns Per-user preparation; requests reuse prepared files for one day before renewing the signed identity.
 */
export function createNextFeishuPreparation({ organization, tokenFor, uid = organization.runtime.uid }) {
  const prepared = new Map();
  return user => {
    if (user.backend !== 'aionui') return;
    const previous = prepared.get(user.slug);
    if (previous?.unionId === user.unionId && previous.until > Date.now()) return;
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(user.slug)) throw new Error('用户身份无效');
    const { runtime, server } = organization;
    const directory = path.join(runtime.nextDirectory, user.slug);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Hold the directory descriptor while publishing, so a personal symlink cannot redirect privileged writes.
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (uid !== null) fs.fchownSync(fd, uid, uid);
      const root = `/proc/self/fd/${fd}`;
      const config = { kind: 'container', bin: '/usr/local/bin', realBin: '/opt/partner-clis/bin', execPath: '/usr/local/bin/node',
        identityFile: '/data/.zp-market-token', tokenUrl: `${runtime.internalOrigin}/token`,
        authorizationUrl: `${server.publicOrigin}/_wp/feishu/`, meegleHost: server.projectHost };
      for (const [name, value] of [['.zp-market-token', tokenFor(user) + '\n'], ['.wp-feishu-cli.json', JSON.stringify(config)]]) {
        const temporary = path.join(root, `.feishu-${crypto.randomBytes(12).toString('hex')}`);
        try {
          fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
          if (uid !== null) fs.chownSync(temporary, uid, uid);
          fs.renameSync(temporary, path.join(root, name));
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      prepared.set(user.slug, { unionId: user.unionId, until: Date.now() + 86400000 });
    } finally { fs.closeSync(fd); }
  };
}

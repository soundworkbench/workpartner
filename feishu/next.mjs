/** Prepare only the signed container identity and public wrapper settings in the next user's volume.
 * @param options Resolved organization, existing per-user token signer and personal runtime.
 * @returns Per-user preparation; requests reuse prepared files for one day before renewing the signed identity.
 */
export function createNextFeishuPreparation({ organization, tokenFor, runtime }) {
  const prepared = new Map();
  return async user => {
    if (user.backend !== 'aionui') return;
    const previous = prepared.get(user.slug);
    if (previous?.unionId === user.unionId && previous.until > Date.now()) return;
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(user.slug)) throw new Error('用户身份无效');
    const { runtime: configRuntime, server } = organization;
    const config = { kind: 'container', bin: '/usr/local/bin', realBin: '/opt/partner-clis/bin', execPath: '/usr/local/bin/node',
      identityFile: '/data/.zp-market-token', tokenUrl: `${configRuntime.internalOrigin}/token`,
      authorizationUrl: `${server.publicOrigin}/_wp/feishu/`, meegleHost: server.projectHost };
    await runtime.putFiles(user.slug, [
      { path: '.zp-market-token', content: tokenFor(user) + '\n', mode: 0o600 },
      { path: '.wp-feishu-cli.json', content: JSON.stringify(config), mode: 0o600 },
    ], { directoryMode: 0o700 });
    prepared.set(user.slug, { unionId: user.unionId, until: Date.now() + 86400000 });
  };
}

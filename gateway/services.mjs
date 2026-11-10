/** Public gateway services. Credentials and all writable state stay outside the source tree. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createMigration } from './migration.mjs';
import { createFeishu } from './feishu.mjs';
import { issueToken, tokenUser } from './market-auth.mjs';
import { createNextFeishuPreparation } from '../feishu/next.mjs';
import { createSettingsHandler } from '../feishu/settings.mjs';
import { createContainerProject } from '../feishu/container-project.mjs';
import { RELAY_PORT } from '../preview/policy.mjs';
import { createPreview, writeRelayKey } from '../preview/gateway.mjs';

/** Initialize organization-selected services with the gateway's identity and personal container resolver. */
export async function createGatewayServices({ organization, runtime: personalRuntime, legacyRuntime = personalRuntime, SESSION_KEY, users, userFor, cookieOf, aionui, legacy, migration = createMigration(organization) }) {
  const { features, runtime, server } = organization;
  const authenticate = req => tokenUser(req, SESSION_KEY, users());
  const enabled = () => features.feishuAuthorization && process.env.FEISHU_USER_AUTH_ENABLED !== '0';
  const prepareNextFeishu = features.feishuAuthorization ? createNextFeishuPreparation({
    organization, runtime: personalRuntime, tokenFor: user => issueToken(SESSION_KEY, user),
  }) : undefined;
  const feishu = features.feishuAuthorization ? createFeishu({
    callbackPath: organization.identity.callbackPath,
    stateDir: path.join(runtime.stateDirectory, 'feishu'), appId: organization.identity.appId,
    secret: () => fs.readFileSync(organization.identity.appSecretFile, 'utf8').trim(),
    publicOrigin: server.publicOrigin, enabled,
    authenticate, owns: migration.owns, assertOwned: migration.assertOwned, sessionUser: req => userFor(req).user, readUsers: users, projectHost: server.projectHost,
  }) : undefined;
  const feishuSettings = feishu && createSettingsHandler({
    appearanceStyle: organization.appearance.authorizationStyle,
    basePath: '/_wp/feishu/', origin: server.publicOrigin, identify: req => userFor(req).user,
    status: async user => { await prepareNextFeishu(user); return feishu.status(user.unionId); },
    disconnect: user => feishu.disconnect(user.unionId), connectUrl: `${server.publicOrigin}/_wp/feishu/connect`,
    project: createContainerProject({ runtime: personalRuntime, legacyRuntime, uid: runtime.uid }),
  });
  const preview = features.preview && server.previewHost ? createPreview({
    publicHost: server.publicHost, previewHost: server.previewHost, key: SESSION_KEY, users,
    upstream: async slug => {
      const user = users().find(user => user.slug === slug);
      if (!migration.owns(user)) return {};
      const up = user?.backend === 'aionui' ? await aionui.upstream(user) : await legacy?.upstream?.(slug);
      if (!up) return {};
      return { address: await (user?.backend === 'aionui' ? personalRuntime : legacyRuntime).address(slug, RELAY_PORT, up) };
    },
    sessionUser: req => {
      const { user } = userFor(req);
      if (!user) return null;
      const [data] = (cookieOf(req, 'wp_sid') || legacy?.sessionCookieNames?.map(name => cookieOf(req, name)).find(Boolean)).split('.');
      return { user, expires: JSON.parse(Buffer.from(data, 'base64url').toString()).e };
    },
  }) : undefined;
  async function prepare(user) {
    if (!migration.owns(user)) return;
    if (user.backend === 'aionui' && prepareNextFeishu) await prepareNextFeishu(user);
    if (preview && (user.backend === 'aionui' || legacy)) await writeRelayKey(SESSION_KEY, user, user.backend === 'aionui' ? personalRuntime : legacyRuntime);
  }
  for (const user of users()) {
    try { await prepare(user); }
    catch (error) { console.error(`[identity] ${user.slug}: personal setup unavailable (${error.code || error.name}); gateway startup continues`); }
  }
  let internal, timer;
  if (feishu) {
    let maintaining = false;
    const maintain = async () => {
      if (maintaining) return;
      maintaining = true;
      try { await feishu.maintain(); }
      catch (error) { console.warn('飞书授权维护未完成，将在下次重试'); }
      finally { maintaining = false; }
    };
    timer = setInterval(maintain, 60000); timer.unref();
    void maintain();
  }
  return { prepareNextFeishu: prepare, preview, feishu, feishuSettings,
    listen(extension) {
      if (!feishu && !extension?.internal) return;
      // This listener is internal-only; each service still authenticates the signed identity and current roster.
      internal = http.createServer(async (req, res) => {
        if (req.url === '/token' && feishu) return feishu.token(req, res);
        if (await extension?.internal?.(req, res, new URL(req.url, 'http://gateway.internal'))) return;
        res.writeHead(404); res.end();
      });
      internal.listen(runtime.internalPort, '0.0.0.0');
    },
    async close() { clearInterval(timer); if (internal) await new Promise(resolve => internal.close(resolve)); },
  };
}

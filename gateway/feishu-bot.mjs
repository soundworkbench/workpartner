import { feishuBotClient } from './feishu-bot-client.mjs';

const API = '/_wp/feishu-bot';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = status => Object.assign(new Error('Feishu bot request failed'), { status });

export async function executeFeishuBot(runtime, uid, slug, action, ...args) {
  const result = await runtime.exec(slug, ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', action, ...args],
    { user: String(uid), timeout: action === 'restart' ? 20000 : 10000, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0) throw fail(503);
  const data = JSON.parse(result.stdout);
  if (data?.ok !== true) throw fail(503);
  return data;
}

function publicBot(bot) {
  if (!object(bot) || typeof bot.appId !== 'string' || !/^cli_[A-Za-z0-9]+$/.test(bot.appId)) return [];
  return [{ appId: bot.appId,
    name: typeof bot.name === 'string' ? Array.from(bot.name).slice(0, 64).join('') : null,
    avatar: typeof bot.avatar === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(bot.avatar) ? bot.avatar : null,
    online: ['online', 'offline', 'unknown'].includes(bot.online) ? bot.online : 'unknown',
    activate: typeof bot.activate === 'boolean' ? bot.activate : null,
    lastEventAt: typeof bot.lastEventAt === 'string' && Number.isFinite(Date.parse(bot.lastEventAt)) ? bot.lastEventAt : null,
    error: ['feishu_unreachable', 'feishu_auth_failed'].includes(bot.error) ? bot.error : null,
    openUrl: 'https://applink.feishu.cn/client/bot/open?appId=' + bot.appId }];
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, oversized = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024) { oversized = true; chunks.length = 0; reject(fail(400)); }
      else if (!oversized) chunks.push(chunk);
    });
    req.on('error', () => reject(fail(400)));
    req.on('end', () => {
      if (oversized) return;
      try {
        if (!object(JSON.parse(Buffer.concat(chunks).toString('utf8')))) throw fail(400);
        resolve();
      } catch { reject(fail(400)); }
    });
  });
}

export function createFeishuBot({ organization, organizationData, authenticate, runtime }) {
  const pending = new Map(), restarting = new Map();
  const origin = organization.server.publicOrigin || `https://${organization.server.publicHost}`;
  function policy() {
    try {
      const data = organizationData(), allow = data?.feishuBot?.allow;
      return data?.features?.feishuBot === true && Array.isArray(allow) && allow.every(v => typeof v === 'string') ? allow : [];
    } catch { return []; }
  }
  const admitted = user => Boolean(user?.backend === 'aionui' && typeof user.slug === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(user.slug)
    && user.unionId && policy().some(v => v === '*' || v === user.slug || v === user.unionId));
  const execute = (user, ...args) => executeFeishuBot(runtime, organization.runtime.uid, user.slug, ...args);
  function info(user, refresh) {
    if (!pending.has(user.slug)) {
      const task = execute(user, 'info', ...(refresh ? ['--refresh'] : [])).then(data => {
        if (!Array.isArray(data.bots)) throw fail(503);
        return { bots: data.bots.flatMap(publicBot) };
      });
      pending.set(user.slug, task);
      task.finally(() => pending.delete(user.slug)).catch(() => {});
    }
    return pending.get(user.slug);
  }
  function reconnect(user) {
    if (!restarting.has(user.slug)) {
      const task = execute(user, 'restart');
      restarting.set(user.slug, task);
      task.finally(() => restarting.delete(user.slug)).catch(() => {});
    }
    return restarting.get(user.slug);
  }
  const reply = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(data));
  };
  const handle = async (req, res, url) => {
    if (![API + '/bots', API + '/reconnect'].includes(url.pathname)) return false;
    try {
      const user = authenticate(req);
      if (!admitted(user)) { reply(res, 404, { error: 'not_found' }); return true; }
      const isReconnect = url.pathname.endsWith('/reconnect');
      if (req.method !== (isReconnect ? 'POST' : 'GET')) throw fail(405);
      if (isReconnect) {
        if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(403);
        await readJson(req);
        await reconnect(user);
        reply(res, 200, { ok: true });
      } else reply(res, 200, await info(user, url.searchParams.get('refresh') === '1'));
    } catch (error) {
      const status = [400, 403, 405].includes(error.status) ? error.status : 503;
      reply(res, status, { error: status === 503 ? 'unavailable' : 'invalid_request' });
    }
    return true;
  };
  handle.clientFor = user => admitted(user) ? feishuBotClient() : '';
  return handle;
}

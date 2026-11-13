import { feishuBotClient } from './feishu-bot-client.mjs';

const API = '/_wp/feishu-bot';
const ID = /^(main|s[0-9a-f]{8})$/;
const APP_ID = /^cli_[A-Za-z0-9]+$/;
const STATES = ['none', 'preparing', 'waiting', 'needs_identity', 'expired', 'failed', 'connected'];
const ERRORS = { invalid_name: 400, name_taken: 409, limit_reached: 409, not_found: 404, main_agent: 400 };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (status, code = 'invalid_request') => Object.assign(new Error('Feishu bot request failed'), { status, code });
const validId = value => typeof value === 'string' && ID.test(value) && !value.includes('\n');
const createdAt = agent => typeof agent?.createdAt === 'string' ? Date.parse(agent.createdAt) || 0 : 0;
const validAppId = value => typeof value === 'string' && APP_ID.test(value) && !value.includes('\n');

function normalizeAgentName(value) {
  if (typeof value !== 'string') throw fail(400, 'invalid_name');
  const name = value.normalize('NFC').trim();
  if (!name || Array.from(name).length > 16 || /^(主助手|main)$/i.test(name)
    || !/^[㐀-䶿一-鿿豈-﫿A-Za-z0-9_·-]+(?: [㐀-䶿一-鿿豈-﫿A-Za-z0-9_·-]+)*$/.test(name)) throw fail(400, 'invalid_name');
  return name;
}

async function execute(runtime, uid, slug, script, args, { timeout = 20000, stdin, detached = false, status = false } = {}) {
  const result = await runtime.exec(slug, ['python3', '/opt/workpartner/bin/' + script, ...args],
    { user: String(uid), timeout, maxOutputBytes: 1024 * 1024, ...(stdin === undefined ? {} : { stdin }), ...(detached ? { detached: true } : {}) });
  if (detached) {
    if (result?.exitCode != null && result.exitCode !== 0) throw fail(503);
    return;
  }
  const data = JSON.parse(result.stdout);
  if ([0, 1].includes(result.exitCode) && data?.ok === false && typeof data.error === 'string' && Object.hasOwn(ERRORS, data.error)) throw fail(ERRORS[data.error], data.error);
  if (result.exitCode !== 0 || !object(data) || (status ? data.ok === false : data.ok !== true)) throw fail(503);
  return data;
}

export async function executeFeishuBot(runtime, uid, slug, action, ...args) {
  return execute(runtime, uid, slug, 'wp-feishu-bot.py', [action, ...args], { timeout: action === 'restart' ? 20000 : 10000 });
}

function publicAgent(agent) {
  if (!object(agent) || !validId(agent.id) || !['main', 'sub'].includes(agent.kind)
    || (agent.id === 'main') !== (agent.kind === 'main')) return [];
  return [{ id: agent.id, name: typeof agent.name === 'string' ? Array.from(agent.name.normalize('NFC').trim()).slice(0, 16).join('') : '',
    kind: agent.kind, setup: STATES.includes(agent.setup) ? agent.setup : 'failed', appId: validAppId(agent.appId) ? agent.appId : null }];
}

function publicBot(bot) {
  if (!object(bot) || !validAppId(bot.appId)) return [];
  const agentId = bot.agentId === undefined ? 'main' : bot.agentId;
  if (!validId(agentId)) return [];
  return [{ agentId, appId: bot.appId,
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
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(value)) throw fail(400);
        resolve(value);
      } catch { reject(fail(400)); }
    });
  });
}

export function createFeishuBot({ organization, organizationData, authenticate, runtime }) {
  const pending = new Map(), restarting = new Map(), writes = new Map();
  const origin = organization.server.publicOrigin || `https://${organization.server.publicHost}`;
  function policy(sub = false) {
    try {
      const data = organizationData(), allow = sub ? data?.feishuBot?.subAgents?.allow : data?.feishuBot?.allow;
      return data?.features?.feishuBot === true && Array.isArray(allow) && allow.every(v => typeof v === 'string') ? allow : [];
    } catch { return []; }
  }
  const listed = (user, sub = false) => policy(sub).some(v => v === '*' || v === user.slug || v === user.unionId);
  const admitted = user => Boolean(user?.backend === 'aionui' && typeof user.slug === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(user.slug)
    && !user.slug.includes('\n') && user.unionId && listed(user));
  const botCommand = (user, ...args) => executeFeishuBot(runtime, organization.runtime.uid, user.slug, ...args);
  const command = (user, script, args, options) => execute(runtime, organization.runtime.uid, user.slug, script, args, options);
  function info(user, refresh) {
    if (!pending.has(user.slug)) {
      const task = botCommand(user, 'info', ...(refresh ? ['--refresh'] : [])).then(data => {
        if (!Array.isArray(data.bots)) throw fail(503);
        const supported = Array.isArray(data.agents);
        const agents = supported ? [...data.agents].sort((a, b) => createdAt(a) - createdAt(b)).flatMap(publicAgent) : [];
        return { bots: data.bots.flatMap(publicBot), agents, supported,
          count: supported ? data.agents.filter(a => a?.kind === 'sub').length : 0,
          limit: Number.isInteger(data.limit) && data.limit >= 0 ? Math.min(5, data.limit) : 5 };
      });
      pending.set(user.slug, task);
      task.finally(() => { if (pending.get(user.slug) === task) pending.delete(user.slug); }).catch(() => {});
    }
    return pending.get(user.slug);
  }
  function serial(user, action) {
    const task = (writes.get(user.slug) || Promise.resolve()).catch(() => {}).then(action).then(value => { pending.delete(user.slug); return value; });
    writes.set(user.slug, task);
    task.finally(() => { if (writes.get(user.slug) === task) writes.delete(user.slug); }).catch(() => {});
    return task;
  }
  function reconnect(user, id = 'main') {
    const key = user.slug + ':' + id;
    if (!restarting.has(key)) {
      const task = botCommand(user, 'restart', ...(id === 'main' ? [] : ['--agent', id])).then(() => { pending.delete(user.slug); });
      restarting.set(key, task);
      task.finally(() => restarting.delete(key)).catch(() => {});
    }
    return restarting.get(key);
  }
  async function setup(user, id) {
    const data = await command(user, 'feishu-onboard.py', ['status', '--agent', id], { timeout: 10000, status: true });
    const status = data.status === 'unconnected' ? 'none' : data.status;
    if (!STATES.includes(status)) throw fail(503);
    return { status,
      ...((typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) && data.expiresAt >= 0 || typeof data.expiresAt === 'string' && Number.isFinite(Date.parse(data.expiresAt))) ? { expiresAt: data.expiresAt } : {}),
      ...(status === 'waiting' && typeof data.qr === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qr) && !data.qr.includes('\n') ? { qr: data.qr } : {}) };
  }
  async function requireSubAgents(user) {
    if (!(await info(user)).supported) throw fail(404, 'not_found');
  }
  const start = (user, id) => command(user, 'feishu-onboard.py', ['start', '--agent', id], { timeout: 10000, detached: true });
  const reply = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(data));
  };
  const handle = async (req, res, url) => {
    if (!url.pathname.startsWith(API + '/')) return false;
    try {
      const user = authenticate(req);
      if (!admitted(user)) throw fail(404, 'not_found');
      const route = url.pathname.slice(API.length);
      const match = route.match(/^\/agents\/([^/]+)\/(setup|rename|delete|restart)$/);
      if (!['/bots', '/reconnect', '/agents'].includes(route) && !match) throw fail(404, 'not_found');
      const id = match?.[1], action = match?.[2];
      if (match && !validId(id)) throw fail(404, 'not_found');
      if ((route === '/agents' || match && !(id === 'main' && action === 'restart')) && !listed(user, true)) throw fail(404, 'not_found');
      if (req.method !== (route === '/bots' ? 'GET' : 'POST') && !(action === 'setup' && req.method === 'GET')) throw fail(405);
      let body;
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(403);
        body = await readJson(req);
      }
      if (id === 'main' && action !== 'restart') throw fail(400, 'main_agent');
      if (route === '/bots') {
        const data = await info(user, url.searchParams.get('refresh') === '1');
        const enabled = listed(user, true) && data.supported;
        reply(res, 200, { bots: data.bots.filter(bot => enabled || bot.agentId === 'main'),
          agents: data.agents.filter(agent => enabled || agent.id === 'main'),
          subAgents: { enabled, limit: data.limit, count: enabled ? data.count : 0 } });
      } else if (route === '/reconnect' || action === 'restart') {
        await reconnect(user, id); reply(res, 200, { ok: true });
      } else if (action === 'setup' && req.method === 'GET') {
        await requireSubAgents(user);
        reply(res, 200, await setup(user, id));
      }
      else {
        const name = route === '/agents' || action === 'rename' ? normalizeAgentName(body.name) : undefined;
        const data = await serial(user, async () => {
          if (route === '/agents') {
            const current = await info(user);
            if (!current.supported) throw fail(503);
            if (current.count >= current.limit) throw fail(409, 'limit_reached');
            const result = await command(user, 'wp-agent', ['create'], { stdin: JSON.stringify({ name }) });
            pending.delete(user.slug);
            const agent = publicAgent(result.agent)[0];
            if (!agent || agent.kind !== 'sub') throw fail(503);
            let setup = 'preparing';
            try { await start(user, agent.id); } catch { setup = 'none'; }
            return { agent: { id: agent.id, name: agent.name, kind: agent.kind, setup } };
          }
          await requireSubAgents(user);
          if (action === 'setup') {
            const state = await setup(user, id);
            if (!['none', 'expired', 'failed'].includes(state.status)) return state;
            await start(user, id); pending.delete(user.slug); return { status: 'preparing' };
          }
          const result = await command(user, 'wp-agent', [action, id], name === undefined ? {} : { stdin: JSON.stringify({ name }) });
          pending.delete(user.slug);
          if (action === 'delete') return { ok: true };
          const agent = publicAgent(result.agent)[0];
          if (!agent || agent.id !== id || agent.kind !== 'sub') throw fail(503);
          return { agent };
        });
        reply(res, route === '/agents' ? 201 : 200, data);
      }
    } catch (error) {
      const status = [400, 403, 404, 405, 409].includes(error.status) ? error.status : 503;
      reply(res, status, { error: status === 503 ? 'unavailable' : typeof error.code === 'string' && Object.hasOwn(ERRORS, error.code) ? error.code : 'invalid_request' });
    }
    return true;
  };
  handle.clientFor = user => admitted(user) ? feishuBotClient() : '';
  return handle;
}

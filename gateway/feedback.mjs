/** Gateway-owned feedback, with a single-process serial store and separate bot credentials. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { feedbackPage } from './feedback-page.mjs';

const API = '/_wp/api/feedback', PAGE = '/_wp/feedback';
const statuses = { open: '已提交', need_info: '待补充', pending_approval: '需求待审批', in_progress: '处理中', done: '已完成', rejected: '不做', duplicate: '重复' };
const fail = (status, message) => Object.assign(new Error(message), { status });
const empty = () => ({ version: 1, seq: 0, nextNo: 1, items: {} });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = () => crypto.randomUUID();
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); };
const missing = res => { res.writeHead(404); res.end(); };
// Prefer codes; stringify the fallback message so errors remain one line. Never log requests or state.
const logError = (route, error) => console.error(`[feedback ${route}] ${JSON.stringify(error.code || error.message)}`);
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw fail(400, `${label}不能为空，且不能超过 ${max} 字。`);
  return value.trim();
}
async function read(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw fail(413, '请求过大，请减少内容或选择更小的截图。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJSON(req) {
  const bytes = await read(req, 65536);
  let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw fail(400, '请求格式无效，请发送 JSON。'); }
  if (!object(data)) throw fail(400, '请求格式无效，请发送 JSON 对象。');
  return data;
}
function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', ext: 'png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return { mime: 'image/webp', ext: 'webp' };
  throw fail(400, '截图只支持 PNG、JPEG 或 WebP 图片。');
}

// Credentials are read only when sending; same identity application and union_id API as the market.
function notificationSender(organization) {
  return async (unionId, message) => {
    async function request(route, body, token) {
      const response = await fetch(`https://open.feishu.cn/open-apis${route}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' });
      const data = await response.json(); if (!response.ok || data.code) throw new Error('Bot notification unavailable');
      return data;
    }
    const auth = await request('/auth/v3/tenant_access_token/internal', { app_id: organization.identity.appId,
      app_secret: fs.readFileSync(organization.identity.appSecretFile, 'utf8').trim() });
    if (!auth.tenant_access_token) throw new Error('Bot authentication unavailable');
    await request('/im/v1/messages?receive_id_type=union_id', { receive_id: unionId, msg_type: 'text', content: JSON.stringify({ text: message }) }, auth.tenant_access_token);
  };
}

/** authenticate/tokenAuthenticate return provisioned users; sessionAuthenticate returns a logged-in identity.
 * organizationData is read on every user request.
 * send(unionId, text) and now() are injectable for offline tests. Feature gating belongs to the caller.
 */
export function createFeedback({ organization, organizationData, authenticate, sessionAuthenticate = () => null, tokenAuthenticate, send = notificationSender(organization), now = Date.now }) {
  const directory = path.join(organization.runtime.stateDirectory, 'feedback');
  const stateFile = path.join(directory, 'store.json');
  function load() {
    if (!fs.existsSync(stateFile)) return empty();
    const bytes = fs.readFileSync(stateFile, 'utf8');
    let data;
    // JSON.parse messages can contain stored user content. Replace them before logging.
    try { data = JSON.parse(bytes); } catch { throw new Error('Invalid feedback state JSON'); }
    if (!object(data) || data.version !== 1 || !object(data.items) || !Number.isSafeInteger(data.seq) || !Number.isSafeInteger(data.nextNo)) throw new Error('Unsupported feedback state');
    return data;
  }
  let state, unavailable = false;
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); state = load(); }
  catch (error) { unavailable = true; logError('init', error); }
  let queue = Promise.resolve();
  const serial = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  function save() {
    const temporary = `${stateFile}.${crypto.randomUUID()}`;
    try { fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, stateFile); }
    catch (error) { state = load(); throw error; }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  const stamp = () => new Date(now()).toISOString();
  function touch(item) { item.seq = ++state.seq; item.updatedAt = stamp(); }
  function checkCommentCapacity(item) {
    if (item.comments.length >= 500) throw fail(409, '每条反馈最多 500 条评论，无法继续添加。');
  }
  function get(key) {
    if (!Object.hasOwn(state.items, key)) throw fail(404, '没有找到这条反馈。');
    return state.items[key];
  }
  function policy() {
    // Deliberately uncached: a failed read immediately revokes both lists.
    try {
      const config = organizationData()?.feedback;
      const list = value => Array.isArray(value) && value.every(v => typeof v === 'string') ? value : [];
      return { allow: list(config?.allow), handlers: list(config?.handlers) };
    } catch { return { allow: [], handlers: [] }; }
  }
  const settings = organization.feedback || {};
  const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  const maxBytes = positive(settings.maxImageBytes, 5242880), maxImages = positive(settings.maxImagesPerItem, 6);
  const origin = organization.server.publicOrigin || `https://${organization.server.publicHost}`;
  function botAuthenticated(req) {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
    if (!match || /^zpd\./i.test(match[1])) return false;
    try {
      const secret = fs.readFileSync(settings.botTokenFile || '/secure/feedback-bot.token', 'utf8').trim();
      const hash = value => crypto.createHash('sha256').update(value).digest();
      return Boolean(secret) && crypto.timingSafeEqual(hash(secret), hash(match[1]));
    } catch { return false; }
  }
  function visible(item, user, isHandler) { if (!isHandler && item.author.unionId !== user.unionId) throw fail(404, '没有找到这条反馈。'); return item; }
  function publicItem(item) {
    const copy = structuredClone(item); delete copy.author.unionId; return copy;
  }
  function download(res, item, fileId) {
    const file = item.files.find(f => f.id === fileId);
    if (!file) throw fail(404, '没有找到这张截图。');
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.mime];
    let bytes; try { bytes = fs.readFileSync(path.join(directory, 'files', item.id, `${file.id}.${ext}`)); }
    catch (error) { if (error.code === 'ENOENT') throw fail(404, '没有找到这张截图。'); throw error; }
    res.writeHead(200, { 'content-type': file.mime, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'private, no-store' }); res.end(bytes);
  }
  async function botUpdate(key, body) {
    const update = await serial(() => {
      const old = get(key), item = structuredClone(old);
      if (!['status', 'type', 'approval', 'pr', 'reply'].some(field => Object.hasOwn(body, field))) throw fail(400, '请提供要更新的状态或回复。');
      if (Object.hasOwn(body, 'status')) {
        if (typeof body.status !== 'string' || !Object.hasOwn(statuses, body.status)) throw fail(400, '反馈状态无效。');
        item.status = body.status;
      }
      if (Object.hasOwn(body, 'type')) {
        if (body.type !== item.type && !(item.type === 'bug' && body.type === 'feature')) throw fail(400, '类型只允许从问题改为需求。');
        if (body.type !== item.type) { item.typeChangedFrom = item.type; item.type = body.type; }
      }
      if (Object.hasOwn(body, 'approval')) {
        const a = body.approval;
        if (!object(a) || !['none', 'pending', 'approved', 'rejected'].includes(a.state) || (a.note !== undefined && typeof a.note !== 'string')) throw fail(400, '审批信息无效。');
        if (item.approval.state !== a.state || item.approval.note !== a.note) item.approval = { state: a.state, ...(a.note !== undefined ? { note: a.note } : {}), at: stamp() };
      }
      if (Object.hasOwn(body, 'pr')) {
        let url; try { url = new URL(body.pr); } catch { throw fail(400, 'PR 地址必须是 HTTPS 链接。'); }
        if (typeof body.pr !== 'string' || !body.pr.startsWith('https://') || url.protocol !== 'https:' || url.username || url.password) throw fail(400, 'PR 地址必须是 HTTPS 链接。');
        item.pr = body.pr;
      }
      let reply;
      if (Object.hasOwn(body, 'reply')) {
        if (!object(body.reply) || typeof body.reply.key !== 'string' || !body.reply.key.trim()) throw fail(400, '回复需要非空的幂等键。');
        const content = text(body.reply.text, 4000, '回复');
        if (!item.comments.some(c => c.by.kind === 'bot' && c.key === body.reply.key)) {
          checkCommentCapacity(item);
          reply = { id: id(), by: { kind: 'bot', name: '工作伙伴机器人' }, text: content, at: stamp(), key: body.reply.key };
          item.comments.push(reply);
        }
      }
      if (JSON.stringify(item) === JSON.stringify(old)) return { item };
      touch(item); if (reply) reply.seq = item.seq;
      state.items[key] = item; save();
      if (old.status !== item.status || reply) return { item: structuredClone(item), notify: true, reply };
      return { item };
    });
    if (!update.notify) return update.item;
    const { item, reply } = update;
    const message = `反馈 #${item.no}：${item.title}\n状态：${statuses[item.status]}${reply ? '\n' + [...reply.text].slice(0, 1500).join('') + ([...reply.text].length > 1500 ? '…' : '') : ''}\nhttps://${organization.server.publicHost}/_wp/feedback#${item.id}`;
    let notice;
    try { await send(item.author.unionId, message); notice = 'sent'; } catch { notice = 'failed'; }
    // Delivery must not hold the write queue. Re-read after concurrent writes or rollback.
    return serial(() => {
      try {
        const item = get(key);
        item.notice = notice; touch(item); save();
        return item;
      } catch (error) {
        if (error.status !== 404) logError('bot/items/:id/notice', error);
        // The business write succeeded; missing items and notice failures remain non-fatal.
        return state.items[key] || update.item;
      }
    });
  }
  return async (req, res, url) => {
    const page = url.pathname === PAGE;
    if (!page && url.pathname !== API && !url.pathname.startsWith(API + '/')) return false;
    if (unavailable) { json(res, 503, { error: '反馈功能暂时不可用' }); return true; }
    const bot = url.pathname.startsWith(API + '/bot/');
    let routeName = page ? 'page' : bot ? 'bot' : 'api';
    try {
      let user, isHandler = false, signed;
      if (bot) {
        if (!botAuthenticated(req)) throw fail(401, '机器人令牌无效。');
      } else {
        const lists = policy();
        signed = tokenAuthenticate(req);
        // An explicit Bearer credential never falls back to a browser cookie.
        user = req.headers.authorization ? signed : authenticate(req);
        if (!user) {
          if (!req.headers.authorization && sessionAuthenticate(req)) { missing(res); return true; }
          if (page) { res.writeHead(302, { location: '/_wp/login?next=' + encodeURIComponent(url.pathname + url.search), 'cache-control': 'no-store' }); res.end(); return true; }
          throw fail(401, '请先登录工作伙伴。');
        }
        isHandler = lists.handlers.includes(user.unionId);
        if (!isHandler && !lists.allow.some(value => value === '*' || value === user.slug || value === user.unionId)) { missing(res); return true; }
      }
      const route = bot ? url.pathname.slice((API + '/bot').length) : url.pathname.slice(API.length);
      const match = /^\/items\/([A-Za-z0-9_-]+)(?:\/(comments|files)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(route);
      if (match) routeName += '/items/:id' + (match[2] ? '/' + match[2] : '');
      else if (bot && route === '/changes') routeName += '/changes';
      const upload = !bot && match?.[2] === 'files' && !match[3] && req.method === 'POST';
      if (req.method !== 'GET' && req.method !== 'POST') throw fail(405, '请求方法不支持。');
      if (req.method === 'POST') {
        const type = upload ? /^application\/octet-stream(?:;|$)/i : /^application\/json(?:;|$)/i;
        if ((!bot && !signed && req.headers.origin !== origin) || !type.test(req.headers['content-type'] || '')) throw fail(403, '请从工作伙伴页面操作，并使用正确的内容类型。');
      }
      if (page && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' blob:" });
        res.end(feedbackPage({ appearanceStyle: organization.appearance?.authorizationStyle, maxImageBytes: maxBytes, maxImagesPerItem: maxImages })); return true;
      }
      if (bot && route === '/changes' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0), requested = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(requested) || requested < 1) throw fail(400, '游标或条数无效。');
        const items = Object.values(state.items).filter(i => i.seq > since).sort((a, b) => a.seq - b.seq).slice(0, Math.min(requested, 200));
        json(res, 200, { items, next: items.at(-1)?.seq ?? since }); return true;
      }
      if (!bot && !page && route === '') {
        if (req.method === 'GET') {
          const items = Object.values(state.items).filter(i => i.author.unionId === user.unionId || (isHandler && url.searchParams.get('scope') === 'all'))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.seq - a.seq)
            .map(i => ({ id: i.id, no: i.no, type: i.type, title: i.title, status: i.status, updatedAt: i.updatedAt, seq: i.seq, author: { slug: i.author.slug, name: i.author.name } }));
          json(res, 200, { items, isHandler }); return true;
        }
        const body = await readJSON(req);
        if (!['bug', 'feature'].includes(body.type)) throw fail(400, '请选择问题或需求。');
        const title = text(body.title, 120, '标题'), content = text(body.body, 8000, '描述');
        const item = await serial(() => {
          const at = stamp();
          if (Object.values(state.items).filter(i => i.author.unionId === user.unionId && i.createdAt.slice(0, 10) === at.slice(0, 10)).length >= 30) throw fail(429, '每天最多提交 30 条反馈，请明天再试。');
          const item = { id: id(), no: state.nextNo++, type: body.type, title, body: content, author: { slug: user.slug, name: user.name || user.slug, unionId: user.unionId },
            status: 'open', createdAt: at, updatedAt: at, seq: 0, files: [], comments: [], approval: { state: 'none' } };
          touch(item); state.items[item.id] = item; save(); return item;
        });
        json(res, 201, { item: publicItem(item) }); return true;
      }
      if (!match) { missing(res); return true; }
      const [, key, action, fileId] = match;
      const item = bot ? get(key) : visible(get(key), user, isHandler);
      if (req.method === 'GET' && !action) { json(res, 200, { item: bot ? item : publicItem(item), ...(!bot ? { canUpload: item.author.unionId === user.unionId } : {}) }); return true; }
      if (req.method === 'GET' && action === 'files' && fileId) { download(res, item, fileId); return true; }
      if (bot && req.method === 'POST' && !action) { json(res, 200, { item: await botUpdate(key, await readJSON(req)) }); return true; }
      if (!bot && req.method === 'POST' && action === 'comments' && !fileId) {
        const content = text((await readJSON(req)).text, 4000, '评论');
        const updated = await serial(() => {
          const row = get(key), at = stamp();
          checkCommentCapacity(row);
          const count = Object.values(state.items).reduce((total, item) => total + item.comments.filter(c =>
            c.by.kind === 'user' && c.by.slug === user.slug && c.at.slice(0, 10) === at.slice(0, 10)).length, 0);
          if (count >= 200) throw fail(429, '每天最多发表 200 条评论，请明天再试。');
          touch(row);
          row.comments.push({ id: id(), by: { kind: 'user', slug: user.slug, name: user.name || user.slug }, text: content, at, seq: row.seq });
          if (row.author.unionId === user.unionId && row.status === 'need_info') row.status = 'open';
          save(); return row;
        });
        json(res, 200, { item: publicItem(updated) }); return true;
      }
      if (upload) {
        if (item.author.unionId !== user.unionId) throw fail(404, '没有找到这条反馈。');
        const bytes = await read(req, maxBytes), type = imageType(bytes);
        const name = (url.searchParams.get('filename') || '截图').slice(0, 255);
        const updated = await serial(() => {
          const row = get(key);
          if (row.files.length >= maxImages) throw fail(400, `每条反馈最多上传 ${maxImages} 张截图。`);
          const file = { id: id(), name, mime: type.mime, size: bytes.length, at: stamp() };
          const folder = path.join(directory, 'files', key), target = path.join(folder, `${file.id}.${type.ext}`);
          fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
          try {
            fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
            row.files.push(file); touch(row); save();
          } catch (error) { fs.rmSync(target, { force: true }); throw error; }
          return row;
        });
        json(res, 201, { item: publicItem(updated) }); return true;
      }
      missing(res);
    } catch (error) {
      if (!error.status) logError(routeName, error);
      if (error.status === 404) missing(res);
      else json(res, error.status || 503, { error: error.status ? error.message : '暂时无法保存反馈，请刷新核实后重试。' });
    }
    return true;
  };
}

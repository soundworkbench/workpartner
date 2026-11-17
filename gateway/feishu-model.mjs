/** Model sidebar for the messaging-app bridge: the organization's list, narrowed to what this person and their key may use. */
import { feishuCatalog } from './organization/resolve.mjs';
import { upstream, PROFILE } from './my-key.mjs';

const PAGE = '/_wp/model', API = '/_wp/api/model';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = status => Object.assign(new Error('Model request failed'), { status });

/** A key lists exact model ids; an id ending in `*` opens every model with that prefix. */
export function keyAllows(ids, model) {
  return ids.some(id => id === model || (id.endsWith('*') && model.startsWith(id.slice(0, -1))));
}

function readModel(req) {
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(body) || typeof body.model !== 'string') throw fail(400);
        resolve(body.model);
      } catch { reject(fail(400)); }
    });
  });
}

function page(accent) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>模型</title>
<style>
body{margin:0;background:#fff;color:#1f2329;font:15px/1.5 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
main{max-width:520px;margin:0 auto;padding:20px 16px}
h1{margin:0 0 12px;font-size:18px;font-weight:600}
ul{margin:0;padding:0;list-style:none}
button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;width:100%;min-height:48px;padding:12px;border-radius:10px;cursor:pointer}
button:hover,button:focus-visible{background:#f2f3f5}
button[aria-checked=true]{font-weight:600}
button[aria-checked=true]::after{content:"✓";color:${accent};font-size:17px}
button:disabled{opacity:.5;cursor:default}
p{margin:12px;color:#646a73;font-size:14px}
</style>
<main><h1>模型</h1><ul id="list"></ul><p id="note" role="status"></p></main>
<script>
const list = document.getElementById('list'), note = document.getElementById('note');
let state = { models: [], current: null }, busy = false;
function render() {
  list.replaceChildren(...state.models.map(model => {
    const item = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.setAttribute('role', 'menuitemradio'); button.textContent = model.name; button.disabled = busy;
    button.setAttribute('aria-checked', String(model.key === state.current));
    button.onclick = () => choose(model.key);
    item.append(button); return item;
  }));
}
async function load() {
  try {
    const response = await fetch('${API}', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error();
    state = await response.json();
    note.textContent = state.models.length ? '' : '暂时没有可用的模型，请联系管理员。';
  } catch { note.textContent = '暂时读不到模型列表，请稍后刷新。'; }
  render();
}
async function choose(key) {
  if (busy || key === state.current) return;
  busy = true; note.textContent = ''; render();
  try {
    const response = await fetch('${API}', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: key }) });
    if (!response.ok) throw new Error();
    state.current = (await response.json()).current;
    note.textContent = '已切换，下一条消息起生效。';
  } catch { note.textContent = '切换失败，请稍后再试。'; }
  busy = false; render();
}
load();
</script></html>`;
}

export function createFeishuModel({ organization, organizationData, authenticate, keyFor, runtime, timeoutMs = 5000 }) {
  const origin = organization.server.publicOrigin || `https://${organization.server.publicHost}`;
  const base = String(organization.model?.baseUrl || '').replace(/\/+$/, '');
  const reply = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  // Read on every request so that editing the organization file takes effect without a new image.
  function catalog(user) {
    try { return feishuCatalog(organizationData()?.model?.catalog?.feishu, user.slug) || []; }
    catch { return []; }
  }
  async function visible(user, entries) {
    let key;
    try { key = (await keyFor(user))?.trim(); } catch { key = null; }
    if (!key) return [];
    const profile = await upstream(base + PROFILE, key, timeoutMs);
    if (!object(profile) || !Array.isArray(profile.models)) throw fail(503);
    const ids = profile.models.filter(m => object(m) && typeof m.id === 'string').map(m => m.id);
    return entries.filter(entry => keyAllows(ids, entry.key));
  }
  async function bridge(user, ...args) {
    const result = await runtime.exec(user.slug, ['python3', '/opt/workpartner/bin/wp-bridge-model.py', ...args],
      { user: String(organization.runtime.uid), timeout: 10000, maxOutputBytes: 64 * 1024 });
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw fail(503); }
    if (result.exitCode !== 0 || !object(data) || data.ok !== true) throw fail(503);
    return typeof data.model === 'string' ? data.model : null;
  }
  const admitted = user => Boolean(typeof user?.slug === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(user.slug) && user.unionId);

  return async function handle(req, res, url) {
    if (![PAGE, API].includes(url.pathname)) return false;
    try {
      const user = authenticate(req);
      if (url.pathname === PAGE) {
        if (req.method !== 'GET') throw fail(405);
        if (!user) {
          res.writeHead(302, { location: `/_wp/login?next=${encodeURIComponent(PAGE)}`, 'cache-control': 'no-store' });
          res.end(); return true;
        }
        if (!admitted(user) || !catalog(user).length) throw fail(404);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'" });
        res.end(page(organization.appearance?.gateway?.accent || '#3370ff'));
        return true;
      }
      if (!user) throw fail(401);
      const entries = catalog(user);
      if (!admitted(user) || !entries.length) throw fail(404);
      if (req.method === 'GET') {
        const [models, current] = await Promise.all([visible(user, entries), bridge(user, 'get')]);
        reply(res, 200, { models, current });
      } else if (req.method === 'POST') {
        if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(403);
        const model = await readModel(req);
        if (!(await visible(user, entries)).some(entry => entry.key === model)) throw fail(400);
        await bridge(user, 'set', model);
        reply(res, 200, { current: model });
      } else throw fail(405);
    } catch (error) {
      if (!error.status) console.error('[model] UNAVAILABLE');
      reply(res, error.status || 503, { error: 'Model request failed' });
    }
    return true;
  };
}

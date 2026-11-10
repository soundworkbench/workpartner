// Personal skills are staged and installed through the owner's runtime.
import crypto from 'node:crypto';
const PREFIX = '/_wp/market/skills';
const NAME = /^[a-z0-9-]+$/;
const MAX_UPLOAD = 10 * 1024 * 1024;
const ERROR_STATUS = { exists: 409, preinstalled: 403, not_found: 404 };

export function skillExecutor(runtime, uid = 1001) {
  return async (user, action, { filename, content, name, overwrite } = {}) => {
    let temporary, lease;
    try {
      if (action === 'install') {
        temporary = `.wp-skill-uploads/install-${crypto.randomBytes(12).toString('hex')}`;
        lease = await runtime.putFiles(user.slug, [{ path: `${temporary}/${filename}`, content, mode: 0o600 }], {
          cleanup: [temporary], create: false, chown: false, directories: [{ path: '.wp-skill-uploads', mode: 0o711, owner: false }],
        });
      }
      const source = temporary && `/data/${temporary}/${filename}`;
      const args = action === 'install' ? [...(overwrite ? ['--overwrite'] : []), action, '--', source]
        : action === 'delete' ? [action, '--', name] : ['list'];
      const result = await runtime.exec(user.slug, ['/opt/workpartner/bin/wp-skill', ...args], { user: String(uid), strictOutput: true });
      if (result.exitCode !== 0) throw new Error('worker failed');
      return JSON.parse(result.stdout);
    } finally {
      if (lease) await runtime.removeFiles(user.slug, [temporary], lease);
    }
  };
}

/** Handle personal skills; uploads use a bounded binary body, deletion uses JSON, and both require the same origin.
 * @param options Authentication, runtime, origin, uid and optional executor for focused tests.
 * @returns HTTP handler returning false for unrelated routes.
 */
export function createMarketSkills({ authenticate, runtime, origin, uid = 1001, execute = skillExecutor(runtime, uid) }) {
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  return async (req, res, url) => {
    if (url.pathname !== PREFIX) return false;
    const user = authenticate(req);
    if (!user) { json(res, 401, { error: 'login_required', message: '请先登录工作伙伴。' }); return true; }
    if (user.backend !== 'aionui' || !/^[a-zA-Z0-9_-]+$/.test(user.slug)) {
      json(res, 404, { error: 'unavailable', message: '请在新版工作伙伴中管理技能。' }); return true;
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      json(res, 405, { error: 'method', message: '不支持此操作。' }); return true;
    }
    const mutation = req.method !== 'GET';
    const contentType = req.method === 'POST' ? /^application\/octet-stream(?:;|$)/i : /^application\/json(?:;|$)/i;
    if (mutation && (req.headers.origin !== origin || !contentType.test(req.headers['content-type'] || ''))) {
      json(res, 403, { error: 'same_origin_required', message: '请从工作伙伴页面操作。' }); return true;
    }
    let data = {};
    if (mutation) {
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > (req.method === 'POST' ? MAX_UPLOAD : 16384)) { json(res, 413, { error: 'body_too_large', message: '请求过大，请重新选择技能文件。' }); return true; }
          chunks.push(chunk);
        }
        if (req.method === 'POST') {
          const filename = url.searchParams.get('filename'), overwrite = url.searchParams.get('overwrite');
          if (!(filename === 'SKILL.md' || /^[^/\\\x00-\x1f]{1,200}\.zip$/i.test(filename || ''))
              || (overwrite !== null && overwrite !== 'true')) throw new Error('invalid upload');
          data = { filename, content: Buffer.concat(chunks), overwrite: overwrite === 'true' };
        } else {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
          if (typeof body.name !== 'string' || !NAME.test(body.name)) throw new Error('invalid name');
          data = { name: body.name };
        }
      } catch (error) { json(res, 400, { error: 'invalid_request', message: '请选择有效的技能文件或技能名称。' }); return true; }
    }
    try {
      const result = await execute(user, req.method === 'GET' ? 'list' : req.method === 'POST' ? 'install' : 'delete', data);
      if (result.error) {
        json(res, ERROR_STATUS[result.error] || 400, { error: result.error, message: result.message, ...(result.name ? { name: result.name } : {}) });
      } else if (req.method === 'GET') {
        json(res, 200, { skills: result.skills.map(({ id, name, description, displayName, displayDescription, preinstalled }) =>
          ({ id, name, description, displayName, displayDescription, preinstalled })) });
      } else json(res, 200, { name: result.name });
    } catch (error) {
      json(res, 503, { error: 'temporarily_unavailable', message: '技能操作尚未确认完成，请刷新列表后重试。' });
    }
    return true;
  };
}

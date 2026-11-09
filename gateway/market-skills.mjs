// Personal skills: stage isolated uploads outside work/ and install inside the authenticated owner's container.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
const PREFIX = '/_wp/market/skills';
const NAME = /^[a-z0-9-]+$/;
const MAX_UPLOAD = 10 * 1024 * 1024;
const ERROR_STATUS = { exists: 409, preinstalled: 403, not_found: 404 };

function stdout(value) {
  const buffer = Buffer.from(value), chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('truncated output');
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) throw new Error('truncated output');
    if (buffer[offset] === 1) chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Run a fixed command as the container owner, without accepting caller-supplied container or command names.
 * @param docker Docker HTTP adapter.
 * @param uid Container owner's uid.
 * @param containerPrefix Selected organization's container prefix.
 * @param dataDir Gateway mount of the personal volumes; files are staged outside work/ and removed after each attempt.
 * @returns Executor accepting an authenticated user, action and validated arguments.
 */
export function skillExecutor(docker, uid = 1001, dataDir = '/next', containerPrefix = 'workpartner-next-') {
  return async (user, action, { filename, content, name, overwrite } = {}) => {
    let temporary;
    const directories = [];
    async function directory(location) {
      const handle = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push(handle);
      return `/proc/self/fd/${handle.fd}`;
    }
    try {
      if (action === 'install') {
        // Pin directory descriptors so a personal symlink cannot redirect privileged writes.
        const home = await directory(path.join(dataDir, user.slug));
        const uploads = path.join(home, '.wp-skill-uploads');
        await fs.mkdir(uploads, { mode: 0o711 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const pinned = await directory(uploads);
        temporary = await fs.mkdtemp(path.join(pinned, 'install-'));
        const stage = await directory(temporary);
        await directories.at(-1).chown(uid, uid);
        const file = await fs.open(path.join(stage, filename), 'wx', 0o600);
        try {
          await file.writeFile(content);
          await file.chown(uid, uid);
        } finally { await file.close(); }
      }
      const source = temporary && `/data/.wp-skill-uploads/${path.basename(temporary)}/${filename}`;
      const args = action === 'install' ? [...(overwrite ? ['--overwrite'] : []), action, '--', source]
        : action === 'delete' ? [action, '--', name] : ['list'];
      const created = await docker('POST', `/containers/${containerPrefix}${user.slug}/exec`, {
        User: String(uid), AttachStdout: true, AttachStderr: true,
        Cmd: ['/opt/workpartner/bin/wp-skill', ...args],
      }, 10000);
      if (created.status !== 201) throw new Error('worker unavailable');
      const { Id } = JSON.parse(created.body);
      const result = await docker('POST', `/exec/${encodeURIComponent(Id)}/start`, { Detach: false, Tty: false }, 30000);
      if (result.status !== 200) throw new Error('worker unavailable');
      const inspected = await docker('GET', `/exec/${encodeURIComponent(Id)}/json`, undefined, 10000);
      if (inspected.status !== 200 || JSON.parse(inspected.body).ExitCode !== 0) throw new Error('worker failed');
      return JSON.parse(stdout(result.body));
    } finally {
      try {
        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      } finally {
        await Promise.all(directories.map(handle => handle.close()));
      }
    }
  };
}

/** Handle personal skills; uploads use a bounded binary body, deletion uses JSON, and both require the same origin.
 * @param options Authentication, Docker transport, origin, uid and optional executor for focused tests.
 * @returns HTTP handler returning false for unrelated routes.
 */
export function createMarketSkills({ authenticate, docker, origin, uid = 1001, containerPrefix = 'workpartner-next-', dataDir = '/next', execute = skillExecutor(docker, uid, dataDir, containerPrefix) }) {
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

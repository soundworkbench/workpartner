// Feishu creation runs as the owner inside their container. No host paths or credentials cross this API.
const PREFIX = '/_wp/aionui/feishu';
const SCRIPT = '/opt/workpartner/bin/feishu-onboard.py';
const STATES = new Set(['unconnected', 'preparing', 'waiting', 'connected', 'needs_restart', 'restarting', 'restart_failed', 'needs_identity', 'expired', 'failed']);

function dockerOutput(value) {
  const buffer = Buffer.from(value);
  let output = '';
  for (let offset = 0; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32BE(offset + 4);
    output += buffer.subarray(offset + 8, offset + 8 + size).toString();
    offset += 8 + size;
  }
  return output;
}

/** Container-only worker transport. The caller supplies server-generated arguments.
 * @param docker Docker HTTP adapter
 * @param uid Container owner's numeric uid
 * @returns Worker executor; raw command output is never logged or returned on failure.
 */
export function feishuExecutor(docker, uid, containerPrefix = 'workpartner-next-') {
  return async (user, action, detached = false) => {
    const args = action === 'start' ? [action, `partner-${user.slug}`] : [action];
    const created = await docker('POST', `/containers/${containerPrefix}${user.slug}/exec`, {
      User: String(uid), AttachStdout: !detached, AttachStderr: !detached,
      Cmd: ['python3', SCRIPT, ...args],
    }, 10000);
    if (created.status !== 201) throw new Error('worker unavailable');
    const { Id } = JSON.parse(created.body);
    const started = await docker('POST', `/exec/${encodeURIComponent(Id)}/start`, { Detach: detached, Tty: false }, 10000);
    if (started.status !== 200) throw new Error('worker unavailable');
    if (detached) return;
    const inspected = await docker('GET', `/exec/${encodeURIComponent(Id)}/json`, undefined, 10000);
    if (inspected.status !== 200 || JSON.parse(inspected.body).ExitCode !== 0) throw new Error('worker failed');
    if (action === 'status') return JSON.parse(dockerOutput(started.body));
  };
}

/** Authenticated, same-origin setup API. execute is injectable for keyless behavior tests.
 * @param options Dependencies: authenticate, docker, uid, origin, execute, log, restarted
 * @returns HTTP handler returning false for unrelated routes.
 */
export function createFeishuOnboarding({ authenticate, docker, uid = 1001, origin, containerPrefix = 'workpartner-next-', execute = feishuExecutor(docker, uid, containerPrefix), log = console.log, restarted = () => {} }) {
  const restarting = new Map(), starting = new Map(), reported = new Set(), restartFailures = new Set();
  async function status(user, retry = false) {
    let value = await execute(user, 'status');
    if (!STATES.has(value.status)) throw new Error('invalid worker state');
    if (retry) restartFailures.delete(user.slug);
    if (restartFailures.has(user.slug) || value.status === 'restart_failed' && !retry) return { status: 'restart_failed' };
    if (['needs_restart', 'restarting', 'restart_failed'].includes(value.status)) {
      if (!restarting.has(user.slug)) {
        const task = (async () => {
          try {
            await execute(user, 'restarting');
            const result = await docker('POST', `/containers/${containerPrefix}${user.slug}/restart?t=10`, undefined, 30000);
            if (result.status !== 204) throw new Error('restart failed');
            await execute(user, 'connected');
            restarted(user.slug);
            return { status: 'connected' };
          } catch (error) {
            restartFailures.add(user.slug);
            try { await execute(user, 'restart_failed'); } catch (writeError) { /* The container may still be stopped; memory prevents repeated restarts. */ }
            log(`飞书开通 ${user.slug}：容器重启未确认，需要管理员核对`);
            return { status: 'restart_failed' };
          }
        })();
        restarting.set(user.slug, task);
        task.finally(() => restarting.delete(user.slug));
      }
      value = await restarting.get(user.slug);
    }
    if (value.status === 'needs_identity' && !reported.has(user.slug)) {
      reported.add(user.slug);
      log(`飞书开通 ${user.slug}：返回机器人自身 ID 或未确认本人 ID；请管理员核对 pending-feishu.toml，补本人 allow_from 后启用`);
    }
    // Explicit allowlist prevents future worker fields from accidentally exposing config or paths.
    return { status: value.status, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
      ...(value.status === 'waiting' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.qr) ? { qr: value.qr } : {}) };
  }
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  return async (req, res, url) => {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const user = authenticate(req);
    if (!user) { json(res, 401, { error: 'login_required' }); return true; }
    if (user.backend !== 'aionui' || !/^[a-zA-Z0-9_-]+$/.test(user.slug)) {
      json(res, 404, { error: 'unavailable' }); return true;
    }
    const start = url.pathname === `${PREFIX}/start` && req.method === 'POST';
    if (!start && !(url.pathname === `${PREFIX}/status` && req.method === 'GET')) {
      json(res, 404, { error: 'not_found' }); return true;
    }
    if (start && (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))) {
      json(res, 403, { error: 'same_origin_required' }); return true;
    }
    try {
      let value = await status(user, start);
      if (start && ['unconnected', 'expired', 'failed'].includes(value.status)) {
        if (!starting.has(user.slug)) {
          const task = execute(user, 'start', true);
          starting.set(user.slug, task);
          task.finally(() => starting.delete(user.slug)).catch(() => {}); // The handler below reports launch failure.
        }
        await starting.get(user.slug);
        value = { status: 'preparing' };
      }
      json(res, 200, value);
    } catch (error) {
      log(`飞书开通 ${user.slug}：容器命令未完成，请管理员核对`);
      json(res, 503, { error: 'temporarily_unavailable' });
    }
    return true;
  };
}

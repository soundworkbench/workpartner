// 同一份飞书项目设备授权供容器与桌面版使用；CLI 的长期凭证始终保留在执行命令的个人环境。
/** Create a per-user Device Code adapter; run returns only CLI JSON and never logs stdout.
 * @param options CLI runner and optional clock (Date.now by default).
 * @returns Status (including CLI remaining minutes when available), connect, poll and disconnect operations.
 */
export function createProject({ run, now = Date.now }) {
  const key = (id) => typeof id === "string" ? id : id.unionId;
  const pending = new Map();
  const queues = new Map();
  const serial = (user, work) => {
    const id = key(user);
    const result = (queues.get(id) || Promise.resolve()).then(work);
    const done = result.catch((error) => { /* 调用者报告错误。 */ });
    queues.set(id, done);
    void done.then(() => { if (queues.get(id) === done) queues.delete(id); });
    return result;
  };
  const status = async (id) => {
    const r = await run(id, ["auth", "status", "--format", "json"]);
    if (typeof r.authenticated !== "boolean") throw new Error("无法确认飞书项目授权，请稍后重试");
    if (!r.authenticated && !["no local token", "token rejected by server"].includes(r.reason)) throw new Error("暂时连不上飞书项目，授权状态尚未核实");
    return { connected: r.authenticated, ...(r.authenticated && Number.isFinite(r.expires_in_minutes) && r.expires_in_minutes >= 0 ? { expiresInMinutes: r.expires_in_minutes } : {}) };
  };
  const connect = (id) => serial(id, async () => {
    let r = pending.get(key(id));
    if (!r || r.until <= now()) {
      r = await run(id, ["auth", "login", "--device-code", "--phase", "init", "--format", "json"]);
      const link = new URL(r.verification_uri_complete || r.verification_uri);
      if (link.protocol !== "https:" || typeof r.device_code !== "string" || typeof r.client_id !== "string" || !Number.isFinite(r.expires_in) || r.expires_in <= 0) throw new Error("飞书项目没有返回有效的授权链接");
      r = { ...r, until: now() + r.expires_in * 1000, link: link.href };
      pending.set(key(id), r);
    }
    return { authorization_url: r.link, user_code: r.user_code, interval: Math.max(5, Number(r.interval) || 5) };
  });
  const poll = (id) => serial(id, async () => {
    const p = pending.get(key(id));
    if (!p || p.until <= now()) { pending.delete(key(id)); return { state: "expired" }; }
    const r = await run(id, ["auth", "login", "--device-code", "--phase", "poll", "--once", "--device-code-value", p.device_code, "--client-id", p.client_id, "--format", "json"]);
    if (r.status === "ok") { pending.delete(key(id)); return { state: "connected" }; }
    if (!["authorization_pending", "slow_down", "pending"].includes(r.status)) { pending.delete(key(id)); return { state: "expired" }; }
    return { state: "pending" };
  });
  const disconnect = (id) => serial(id, async () => { pending.delete(key(id)); await run(id, ["auth", "logout", "--format", "json"]); return { connected: false }; });
  return { status, connect, poll, disconnect };
}

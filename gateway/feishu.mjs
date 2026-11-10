// 飞书用户 OAuth：长期凭证只在网关，所有操作按本人串行，避免刷新与断开互相覆盖。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { completionPage } from "../feishu/return.mjs";

const failure = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(JSON.stringify(value)); };
const redirect = (res, location, cookie) => { res.writeHead(302, { location, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) }); res.end(); };
const cookie = (req, name) => String(req.headers.cookie || "").split(/;\s*/).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
const expiredCookie = "zp_feishu=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

/** Create a user-only OAuth service. HTTP fetch, clock and identity readers are injectable for keyless tests.
 * @param options Gateway state directory, app id/secret reader, public origin, enable switch and identity readers.
 * @returns Public handler, internal token handler and periodic refresh operation; no timer is owned by this service.
 */
export function createFeishu({ stateDir, appId, secret, publicOrigin, enabled, authenticate, sessionUser, readUsers, projectHost = "", callbackPath = "/_wp/callback", fetcher = fetch, now = Date.now, owns = () => true, assertOwned }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const pending = new Map();
  const queues = new Map();
  const file = (id) => path.join(stateDir, `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
  const load = (id) => {
    let text;
    try { text = fs.readFileSync(file(id), "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const value = JSON.parse(text);
    if (value.version !== 1 || !["connected", "reauthorize", "revoking"].includes(value.state) || typeof value.refreshToken !== "string" || !value.refreshToken || typeof value.accessToken !== "string" || !Number.isFinite(value.expiresAt)) throw failure(503, "飞书授权记录无法读取，请联系管理员恢复");
    return value;
  };
  const save = (id, value) => {
    const temp = `${file(id)}.${crypto.randomBytes(12).toString("hex")}`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ ...value, userId: id }), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, file(id));
    } finally { fs.rmSync(temp, { force: true }); }
  };
  const serial = (id, work) => {
    const result = (queues.get(id) || Promise.resolve()).then(work);
    const settled = result.catch((error) => { /* 调用者报告错误，后续请求仍可处理。 */ });
    queues.set(id, settled);
    void settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return result;
  };
  const ensureEnabled = () => { if (!enabled()) throw failure(403, "管理员已停用飞书授权"); };
  async function request(url, init = {}) {
    let response;
    try { response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) }); }
    catch (error) { throw failure(502, "暂时连不上飞书，请稍后重试"); }
    let data;
    try { data = await response.json(); } catch (error) { throw failure(502, "飞书返回了无法读取的结果"); }
    if (!response.ok || data.error || (data.code !== undefined && data.code !== 0)) {
      // 不向日志或客户端透传上游正文，错误描述可能包含授权码或令牌。
      throw Object.assign(failure(502, "飞书未接受这次授权请求，请查看连接状态；仍无法连接请联系管理员"), { invalidGrant: data.error === "invalid_grant" || [20064, 20065].includes(data.code) });
    }
    return data;
  }
  const post = (url, body) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const exchange = (body) => post("https://open.feishu.cn/open-apis/authen/v2/oauth/token", { client_id: appId, client_secret: secret(), ...body });
  function tokenRecord(data, previous) {
    if (typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || !(data.refresh_token || previous?.refreshToken)) throw failure(502, "飞书没有返回长期授权，请重新连接并允许离线访问");
    return { version: 1, state: "connected", authorizedAt: previous ? previous.authorizedAt : now(), accessToken: data.access_token, refreshToken: data.refresh_token || previous.refreshToken,
      expiresAt: now() + data.expires_in * 1000, refreshExpiresAt: data.refresh_token_expires_in ? now() + data.refresh_token_expires_in * 1000 : previous?.refreshExpiresAt ?? null };
  }
  async function refresh(id, value) {
    if (!ownsId(id)) throw failure(403, "工作区迁移中，请稍后重试");
    if (value.refreshExpiresAt !== null && value.refreshExpiresAt <= now()) throw failure(409, "飞书授权已到期，请重新连接");
    let data;
    try { data = await exchange({ grant_type: "refresh_token", refresh_token: value.refreshToken }); }
    catch (error) { if (error.invalidGrant) save(id, { ...value, state: "reauthorize", accessToken: "", expiresAt: 0 }); throw error; }
    const next = tokenRecord(data, value);
    ensureEnabled();
    save(id, next);
    return next;
  }
  async function revoke(id, value) {
    // 先标记不可用；撤销失败保留待撤销记录，重启后继续，不恢复使用权。
    save(id, { ...value, state: "revoking" });
    let response;
    try {
      response = await fetcher("https://accounts.feishu.cn/oauth/v1/revoke", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "error", signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({ client_id: appId, client_secret: secret(), token: value.refreshToken, token_type_hint: "refresh_token" }).toString(),
      });
    } catch (error) { throw failure(502, "已停止使用飞书授权，远端撤销尚未完成，请稍后重试断开"); }
    const body = await response.text();
    let data;
    try { data = body ? JSON.parse(body) : {}; } catch (error) { throw failure(502, "已停止使用飞书授权，无法核实远端撤销结果"); }
    if (!response.ok || data.error || (data.code !== undefined && data.code !== 0)) throw failure(502, "已停止使用飞书授权，远端撤销尚未完成，请稍后重试断开");
    fs.rmSync(file(id), { force: true });
  }
  async function scopes() {
    const app = await post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { app_id: appId, app_secret: secret() });
    if (!app.tenant_access_token) throw failure(502, "无法读取应用用户权限，请联系管理员");
    const result = await request("https://open.feishu.cn/open-apis/application/v6/scopes", { headers: { authorization: `Bearer ${app.tenant_access_token}` } });
    if (!Array.isArray(result.data?.scopes)) throw failure(502, "无法读取应用用户权限，请联系管理员");
    const userScopes = result.data.scopes.filter((s) => s.scope_type === "user" && s.grant_status === 1).map((s) => s.scope_name);
    if (!userScopes.length || userScopes.some((s) => typeof s !== "string" || !s || /\s/.test(s))) throw failure(503, "应用尚未开通用户权限，请联系管理员");
    return [...new Set([...userScopes, "offline_access"])].sort().join(" ");
  }
  const status = (id) => {
    const value = load(id);
    return { enabled: enabled(), connected: Boolean(enabled() && value?.state === "connected" && (value.refreshExpiresAt === null || value.refreshExpiresAt > now())), revoking: value?.state === "revoking", name: readUsers().find(user => user.unionId === id)?.name, authorizedAt: value?.authorizedAt };
  };
  const disconnect = (id) => serial(id, async () => {
    if (!ownsId(id)) throw failure(403, "工作区迁移中，请稍后重试");
    for (const [state, entry] of pending) if (entry.user === id) pending.delete(state);
    const value = load(id);
    if (value) await revoke(id, value);
    return { connected: false };
  });
  const ensureOwned = user => {
    if (assertOwned) return assertOwned(user);
    if (!owns(user)) throw failure(403, "工作区迁移中，请稍后重试");
  };
  const ownsId = id => owns() || owns(readUsers().find(user => user.unionId === id));
  const canMaintain = (id, value) => ownsId(id)
    || (value.state === 'revoking' && !readUsers().some(user => user.unionId === id));
  const connectUrl = `${publicOrigin}/_wp/feishu/connect`;
  async function token(req, res) {
    try {
      if (req.method !== "POST") throw failure(405, "请使用 POST 领取令牌");
      ensureEnabled();
      const user = authenticate(req);
      if (!user) throw failure(401, "工作伙伴登录已失效，请重新登录");
      ensureOwned(user);
      await serial(user.unionId, async () => {
        ensureOwned(user);
        let value = load(user.unionId);
        if (!value || value.state !== "connected") return json(res, 409, { error: "not_authorized", message: "需要授权飞书", authorization_url: connectUrl });
        if (value.expiresAt <= now() + 5 * 60000) value = await refresh(user.unionId, value);
        ensureEnabled();
        ensureOwned(user);
        json(res, 200, { user_access_token: value.accessToken, expires_at: Math.floor(value.expiresAt / 1000), app_id: appId });
      });
    } catch (error) { json(res, error.status || 503, { error: "authorization_unavailable", message: error.status ? error.message : "暂时无法读取飞书授权", authorization_url: connectUrl }); }
  }
  async function handle(req, res, url) {
    const callback = url.pathname === callbackPath && String(url.searchParams.get("state") || "").startsWith("feishu-");
    if (!callback && !url.pathname.startsWith("/_wp/feishu/")) return false;
    // 公网只给桌面版显式入口；容器使用另一个仅内部网络可达的监听端口。
    if (url.pathname === "/_wp/feishu/desktop-token") { await token(req, res); return true; }
    try {
      if (["/_wp/feishu/desktop-status", "/_wp/feishu/desktop-disconnect", "/_wp/feishu/desktop-config"].includes(url.pathname)) {
        const user = authenticate(req);
        if (!user) throw failure(401, "工作伙伴登录已失效，请重新登录");
        ensureOwned(user);
        if (req.method !== "POST") throw failure(405, "请使用 POST");
        json(res, 200, url.pathname.endsWith("desktop-config") ? { meegle_host: projectHost } : url.pathname.endsWith("desktop-status") ? status(user.unionId) : await disconnect(user.unionId));
        return true;
      }
      const user = sessionUser(req);
      if (!user) { redirect(res, `/_wp/login?next=${encodeURIComponent("/_wp/feishu/")}`); return true; }
      ensureOwned(user);
      const suffix = url.pathname.slice("/_wp/feishu/".length);
      if (suffix === "done" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(completionPage(url.searchParams.get("display") === "popup"));
      } else if (callback) {
        const state = url.searchParams.get("state");
        const entry = pending.get(state);
        pending.delete(state);
        res.setHeader("set-cookie", expiredCookie);
        if (!entry || entry.until <= now() || entry.user !== user.unionId || cookie(req, "zp_feishu") !== state || !url.searchParams.get("code")) throw failure(400, "飞书授权未完成或已过期，请重新连接");
        ensureEnabled();
        await serial(user.unionId, async () => {
          ensureOwned(user);
          const old = load(user.unionId);
          if (old?.state === "revoking") throw failure(409, "上一次断开尚未完成，请先重试断开");
          const tok = await exchange({ grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: `${publicOrigin}${callbackPath}` });
          const who = await request("https://open.feishu.cn/open-apis/authen/v1/user_info", { headers: { authorization: `Bearer ${tok.access_token}` } });
          if (who.data?.union_id !== user.unionId) {
            // 防止授权另一个飞书账号；新取得的授权也必须撤销。
            const other = tokenRecord(tok);
            await revoke(`rejected-${crypto.randomUUID()}`, other);
            throw failure(403, "授权的飞书账号与当前工作伙伴账号不同，请使用本人账号重新连接");
          }
          ensureEnabled();
          save(user.unionId, tokenRecord(tok));
        });
        redirect(res, entry.display ? `${publicOrigin}/_wp/feishu/done?display=${entry.display}` : `${publicOrigin}/_wp/feishu/`, expiredCookie);
      } else if (suffix === "connect" && req.method === "GET") {
        ensureEnabled();
        const scope = await scopes();
        for (const [id, entry] of pending) if (entry.until <= now() || entry.user === user.unionId) pending.delete(id);
        const state = `feishu-${crypto.randomBytes(24).toString("hex")}`;
        pending.set(state, { user: user.unionId, until: now() + 600000,
          display: url.searchParams.get("return") === "settings" ? (url.searchParams.get("display") === "popup" ? "popup" : "redirect") : null });
        const query = new URLSearchParams({ client_id: appId, response_type: "code", redirect_uri: `${publicOrigin}${callbackPath}`, state, scope });
        redirect(res, `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${query}`, `zp_feishu=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      } else return false;
    } catch (error) { json(res, error.status || 503, { message: error.status ? error.message : "飞书授权未处理完成，请查看连接状态；仍无法处理请联系管理员" }); }
    return true;
  }
  async function maintain() {
    for (const entry of fs.readdirSync(stateDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = JSON.parse(fs.readFileSync(path.join(stateDir, entry), "utf8"));
      if (typeof record.userId !== "string" || path.basename(file(record.userId)) !== entry) throw new Error("飞书授权记录无效");
      const id = record.userId;
      if (!canMaintain(id, record)) continue;
      await serial(id, async () => {
        const value = load(id);
        if (!value || !canMaintain(id, value)) return;
        if (value.state === "revoking") await revoke(id, value);
        else if (value.state === "connected" && enabled() && readUsers().some((u) => u.unionId === id) && value.expiresAt <= now() + 5 * 60000) await refresh(id, value);
      }).catch((error) => { /* 暂时失败留待下轮；领取令牌仍明确报告错误。 */ });
    }
  }
  return { handle, token, maintain, status, disconnect };
}

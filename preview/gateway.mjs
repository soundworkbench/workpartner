import crypto from "node:crypto";
import { previewPort, previewPath, editorHeaders, editorSetCookies } from "./policy.mjs";
import { proxyHttp, proxyUpgrade } from "./transport.mjs";
import { installPreviewClient } from "./client.mjs";
import { previewDownloadBody } from "./downloads.mjs";

const SID = "__Host-zp-preview";
const NONCE = "__Host-zp-preview-nonce";
const TTL = 600;
const cookieOf = (req, name) => String(req.headers.cookie || "").split(/;\s*/).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");

/** Domain-separated container credential. It is never sent to a browser. */
export const relayKey = (key, slug) => hmac(key, `preview-relay-v1:${slug}`);

/** Atomically write a stable, per-container relay key into its existing private data volume. */
export async function writeRelayKey(key, user, runtime) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(user.slug)) throw new Error("Invalid workspace slug");
  const file = '.zp-preview-relay-key';
  const value = relayKey(key, user.slug) + "\n";
  try { if (await runtime.readFile(user.slug, file) === value) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await runtime.putFiles(user.slug, [{ path: file, content: value, mode: 0o600 }], { directoryMode: 0o777, chown: false });
}

/** Separate preview origin, browser-bound single-use grants, streaming HTTP and WebSocket routing. */
export function createPreview({ publicHost, previewHost = "", key, users, sessionUser, upstream, extraClient, now = Date.now }) {
  if (previewHost && (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(previewHost) || previewHost === publicHost
    || publicHost.endsWith(`.${previewHost}`))) {
    throw new Error("PREVIEW_HOST must be a separate sibling domain, without a scheme, port or wildcard");
  }
  const mainOrigin = `https://${publicHost}`;
  const previewOrigin = `https://${previewHost}`;
  const scope = (user) => hmac(key, `preview-origin-v1:${user.unionId}`).slice(0, 24);
  const used = new Map();
  const pack = (purpose, value) => {
    const data = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${data}.${hmac(key, `${purpose}:${data}`)}`;
  };
  const unpack = (purpose, token, allowExpired = false) => {
    if (typeof token !== "string" || token.length > 32768) return null;
    const [data, mac, extra] = token.split(".");
    if (extra || !/^[a-f0-9]{64}$/.test(mac || "") || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(hmac(key, `${purpose}:${data}`)))) return null;
    try {
      const value = JSON.parse(Buffer.from(data, "base64url").toString());
      return allowExpired || value.e > now() / 1000 ? value : null;
    } catch (error) { return null; }
  };
  const canonicalHost = (host) => host.replace(/:443$/, "");
  const isPreviewHost = (host) => previewHost && (canonicalHost(host) === previewHost || canonicalHost(host).endsWith(`.${previewHost}`));
  const route = (owner, inputPort) => {
    const port = previewPort(inputPort);
    const user = port && users().find((u) => scope(u) === owner);
    return user ? { user, port, host: previewHost } : null;
  };
  const sessionRoute = (req, allowExpired = false) => {
    const value = unpack("session", cookieOf(req, SID), allowExpired);
    const user = value && users().find((u) => u.unionId === value.u);
    const port = value && previewPort(value.p);
    return user && port && value.h === previewHost && value.until > now() / 1000
      ? { user, port, host: previewHost, value } : null;
  };
  const reject = (res, status, message) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    res.end(message);
  };
  const redirect = (res, location, cookies = []) => {
    let destination;
    try { destination = new URL(location); }
    catch (error) { reject(res, 400, "预览跳转地址无效。"); return; }
    if (destination.origin !== mainOrigin && destination.origin !== previewOrigin) {
      reject(res, 400, "预览跳转地址无效。"); return;
    }
    const trustedBase = destination.origin === mainOrigin ? `${mainOrigin}/` : `${previewOrigin}/`;
    const safeLocation = trustedBase + destination.pathname.slice(1) + destination.search + destination.hash;
    res.writeHead(302, { location: safeLocation, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": cookies }); res.end();
  };
  const start = (res, r, path) => {
    const nonce = crypto.randomBytes(24).toString("hex");
    const auth = new URL("/_wp/preview/authorize", mainOrigin);
    auth.search = new URLSearchParams({ owner: scope(r.user), port: r.port, path, nonce }).toString();
    redirect(res, auth.href, [cookie(NONCE, nonce, 60)]);
  };
  const allowedOrigin = (req, r) => !req.headers.origin || req.headers.origin === `https://${r.host}`;
  const relayHeaders = (req, r) => ({ ...editorHeaders(req.headers), host: `127.0.0.1:${r.port}`,
    "x-zp-preview-port": String(r.port), "x-zp-relay-key": relayKey(key, r.user.slug) });

  const replyHeaders = (r, value) => (headers) => {
    const out = { ...headers, "cache-control": "no-store", "referrer-policy": "no-referrer" };
    out["set-cookie"] = [...editorSetCookies(headers["set-cookie"]), cookie(SID,
      pack("session", { ...value, e: Math.min(now() / 1000 + TTL, value.until) }), TTL)];
    delete out["access-control-allow-origin"]; delete out["access-control-allow-credentials"];
    if (out.location) {
      try {
        const location = new URL(out.location);
        if (location.protocol === "http:" && ["localhost", "127.0.0.1"].includes(location.hostname) && Number(location.port || 80) === r.port) {
          out.location = `https://${r.host}${location.pathname}${location.search}${location.hash}`;
        }
      } catch (error) { /* Relative editor redirects remain relative. */ }
    }
    return out;
  };

  const handle = async (req, res, url) => {
    const host = canonicalHost(String(req.headers.host || "").toLowerCase());
    if (isPreviewHost(host)) {
      // Unknown subdomains must never reach the main app or the shared preview session.
      if (host !== previewHost) { reject(res, 403, "这个预览域名不可用。"); return true; }
      if (url.pathname === "/_wp_preview/start") {
        const r = route(url.searchParams.get("owner"), url.searchParams.get("port"));
        const path = previewPath(url.searchParams.get("path") || "/");
        if (req.method !== "GET" || !r || !path) reject(res, 400, "预览地址无效。");
        else start(res, r, path);
        return true;
      }
      if (url.pathname === "/_wp_preview/redeem") {
        const grant = unpack("grant", url.searchParams.get("ticket"));
        const path = grant && previewPath(grant.path);
        const nonce = cookieOf(req, NONCE);
        const user = grant && users().find((u) => u.unionId === grant.u);
        for (const [ticket, expires] of used) if (expires <= now() / 1000) used.delete(ticket);
        if (req.method !== "GET" || !grant || !path || !nonce || grant.n !== hmac(key, nonce) || grant.h !== host
          || !user || !previewPort(grant.p) || used.has(grant.id)) {
          reject(res, 403, "预览链接已失效，请从自己的工作区重新打开。"); return true;
        }
        used.set(grant.id, grant.e);
        const value = pack("session", { u: grant.u, h: host, p: grant.p, until: grant.until, e: Math.min(now() / 1000 + TTL, grant.until) });
        redirect(res, `${previewOrigin}${path}`, [cookie(SID, value, TTL), cookie(NONCE, "", 0)]);
        return true;
      }
      if (!allowedOrigin(req, { host }) || req.method === "CONNECT") { reject(res, 403, "预览来源不匹配。"); return true; }
      const r = sessionRoute(req);
      if (!r) {
        const expired = sessionRoute(req, true);
        if (expired && req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate") start(res, expired, req.url);
        else reject(res, 401, "预览登录已过期，请重新打开预览。");
        return true;
      }
      const up = await upstream(r.user.slug);
      if (!up.address) { reject(res, 503, "工作区暂时不可用。"); return true; }
      proxyHttp(req, res, up.address, relayHeaders(req, r), replyHeaders(r, r.value),
        req.method === "GET" ? previewDownloadBody : undefined);
      return true;
    }
    if (!url.pathname.startsWith("/_wp/preview/")) return false;
    if (!previewHost && url.pathname === "/_wp/preview/client.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }); res.end("// Workspace preview is disabled." + (extraClient?.(sessionUser(req)?.user) || "")); return true;
    }
    if (!previewHost) { reject(res, 503, "工作区预览还未启用，请联系管理员。"); return true; }
    if (host !== publicHost || req.method !== "GET" || (req.headers.origin && req.headers.origin !== mainOrigin)) {
      reject(res, 403, "预览来源不匹配。"); return true;
    }
    const identity = sessionUser(req);
    if (!identity?.user) {
      redirect(res, `${mainOrigin}/_wp/login?next=${encodeURIComponent(req.url)}`); return true;
    }
    const { user, expires } = identity;
    if (url.pathname === "/_wp/preview/client.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(`(${installPreviewClient.toString()})(${JSON.stringify({ previewHost, scope: scope(user) })});` + (extraClient?.(user) || ""));
      return true;
    }
    if (url.pathname === "/_wp/preview/open") {
      const port = previewPort(url.searchParams.get("port"));
      const path = previewPath(url.searchParams.get("path") || "/");
      if (!port || !path) reject(res, 400, "这个预览端口或地址不可用。");
      else redirect(res, `https://${previewHost}/_wp_preview/start?${new URLSearchParams({ owner: scope(user), port, path })}`);
      return true;
    }
    if (url.pathname === "/_wp/preview/authorize") {
      const r = route(url.searchParams.get("owner"), url.searchParams.get("port"));
      const path = previewPath(url.searchParams.get("path"));
      const nonce = url.searchParams.get("nonce") || "";
      if (!r || r.user.unionId !== user.unionId || !path || !/^[a-f0-9]{48}$/.test(nonce) || !Number.isFinite(expires)) {
        reject(res, 403, "这个预览不属于你，请从自己的工作区打开。"); return true;
      }
      const grant = pack("grant", { u: user.unionId, h: r.host, p: r.port, n: hmac(key, nonce), path,
        id: crypto.randomBytes(24).toString("hex"), e: now() / 1000 + 60, until: expires });
      redirect(res, `https://${r.host}/_wp_preview/redeem?${new URLSearchParams({ ticket: grant })}`);
      return true;
    }
    reject(res, 404, "预览地址不存在。"); return true;
  };
  const upgrade = async (req, socket, head) => {
    const host = canonicalHost(String(req.headers.host || "").toLowerCase());
    const r = host === previewHost && sessionRoute(req);
    if (!r || !allowedOrigin(req, r) || req.method !== "GET"
      || String(req.headers.upgrade).toLowerCase() !== "websocket") return socket.destroy();
    const up = await upstream(r.user.slug);
    if (!up.address) return socket.destroy();
    proxyUpgrade(req, socket, head, up.address, relayHeaders(req, r), replyHeaders(r, r.value));
  };
  return { handle, upgrade, isPreviewHost };
}

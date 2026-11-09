// 工作伙伴网关：网关自己对接飞书登录（飞书内免确认），按飞书 union_id 把每个人带到自己的容器。
// 名单里 backend 为 "aionui" 的人去新版容器（aionui.mjs），其余去 旧版后端 容器。
// 容器停了就启动；旧版后端 的一次性口令在这里换成登录 cookie，浏览器只和网关打交道。
import { resolveOrganization } from "./organization/resolve.mjs";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { authorizeUrl, identify, provision, provisioning, readUsers, slugFor } from "./onboard.mjs";
import { createAionui, aionuiHeaders, aionuiResponseHeaders, aionuiEtag, etagMatches, upgradeHead } from "./aionui.mjs";
import { createChatTitles } from "./title.mjs";

import { createMarketSkills } from "./market-skills.mjs";

const organization = resolveOrganization();
const PORT = organization.runtime.gatewayPort;
const PUBLIC_HOST = organization.server.publicHost;
const MODEL = new URL(organization.model.baseUrl);
const MODEL_KEY_PREFIX = organization.model.keyPrefix;
const USERS_FILE = organization.runtime.usersFile;
const COOKIE_FILE = organization.runtime.cookieFile;
const users = readUsers;

function docker(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: "/var/run/docker.sock", method, path, ...(timeoutMs ? { timeout: timeoutMs } : {}),
      headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (timeoutMs) req.on("timeout", () => req.destroy(new Error("超时")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}


// 新版容器：数据在宿主 <PARTNER_DATA>/workspaces/<slug>（网关内 /next），AionUi 口令在 /secure/aionui（只网关读）。
const aionui = createAionui({
  docker, self: os.hostname(), modelContainer: organization.runtime.modelContainer, modelBaseUrl: MODEL.href, modelBaseEnvironment: organization.model.baseEnvironment,
  image: organization.runtime.nextImage, containerPrefix: organization.runtime.nextContainerPrefix,
  userLabel: organization.runtime.nextUserLabel, modelKeyFile: organization.runtime.nextModelKeyFile, port: organization.runtime.nextPort, uid: organization.runtime.uid,
  dataDir: organization.runtime.nextDirectory, hostData: `${organization.runtime.hostData}${organization.runtime.nextDirectory}`,
  usersDir: organization.runtime.usersDirectory, hostUsers: `${organization.runtime.hostData}/users`,
  secretDir: `${organization.runtime.secureDirectory}/aionui`, secureDir: organization.runtime.secureDirectory,
  hostSecure: organization.runtime.hostSecure, keyPrefix: MODEL_KEY_PREFIX,
  memory: organization.runtime.nextMemory, nanoCpus: organization.runtime.nanoCpus, pidsLimit: organization.runtime.nextPidsLimit,
});
const marketSkills = createMarketSkills({
  authenticate: req => userFor(req).user, docker, uid: organization.runtime.uid, containerPrefix: organization.runtime.nextContainerPrefix, dataDir: organization.runtime.nextDirectory, origin: `https://${PUBLIC_HOST}`,
});
// 登录凭证：{u: union_id, n: 姓名, e: 到期秒} 的 base64url 加 HMAC 签名，30 天有效。
const SESSION_KEY = (() => {
  const f = organization.runtime.sessionKeyFile;
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(f, "utf8").trim();
})();
const SESSION_DAYS = 30;
const LOCAL = organization.runtime.localAddress;
const sign = (data) => crypto.createHmac("sha256", SESSION_KEY).update(data).digest("base64url");

function issueSession(who) {
  const data = Buffer.from(JSON.stringify({ u: who.unionId, n: who.name, a: who.avatar || "", e: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 })).toString("base64url");
  return `wp_sid=${data}.${sign(data)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

const modelKeyFor = (user) => fs.readFileSync(`${organization.runtime.secureDirectory}/${MODEL_KEY_PREFIX}${user.slug}.key`, "utf8").trim();
const chatTitles = createChatTitles({ baseUrl: MODEL.href, keyFor: modelKeyFor });

function sessionOf(req) {
  const [data, mac] = String(cookieOf(req, "wp_sid") || "").split(".");
  if (!data || !mac || mac.length !== 43 || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(data)))) return null;
  const s = JSON.parse(Buffer.from(data, "base64url").toString());
  return s.e > Date.now() / 1000 ? { unionId: s.u, name: s.n, avatar: s.a || "" } : null;
}

function userFor(req) {
  const who = sessionOf(req);
  return { who, user: who && users().find((x) => x.unionId === who.unionId) };
}

function page(res, status, title, text, refresh) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ""}<title>${organization.productName?.zh || "工作伙伴"}</title><body style="font-family:-apple-system,'PingFang SC','Noto Sans CJK SC',sans-serif;display:grid;place-items:center;height:90vh;color:${organization.appearance?.gateway?.accent || "#333"}"><div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="color:#555">${text}</p></div></body>`);
}

async function resolve(req) {
  const { who, user } = userFor(req);
  if (!user) return { deny: who };
  const up = await aionui.upstream(user);
  if (!up) return { user, backend: "aionui" };
  const cookie = await aionui.session(user.slug, up);
  return { user, up, cookie, backend: "aionui", port: up.port, headers: aionuiHeaders, responseHeaders: aionuiResponseHeaders,
    etag: req => aionuiEtag(up.imageId, req), relogin: () => aionui.session(user.slug, up, true), lost: () => aionui.forget(user.slug) };
}

function proxy(req, res, r, body, retried) {
  // 静态文件：浏览器带的 If-None-Match 与按镜像 ID + 路径算出的 ETag 相同，网关直接答 304，不转发。
  const etag = r.etag?.(req);
  if (etagMatches(req, etag)) {
    res.writeHead(304, { etag, "cache-control": "no-cache" });
    return res.end();
  }
  const titleCreate = r.backend === "aionui" && req.method === "POST" && /^\/api\/conversations(?:\?|$)/.test(req.url);
  const headers = r.headers(req, r.cookie);
  if (titleCreate) headers["accept-encoding"] = "identity";
  const up = http.request({ host: r.up.ip, port: r.port, path: req.url, method: req.method,
    headers }, async (ur) => {
    if (ur.statusCode === 401 && !retried) {
      ur.resume();
      r.cookie = await r.relogin();
      return proxy(req, res, r, body, true);
    }
    res.writeHead(ur.statusCode, r.responseHeaders(ur.headers, etag, ur.statusCode));
    if (titleCreate && ur.statusCode >= 200 && ur.statusCode < 300) {
      const parts = []; let size = 0;
      ur.on("data", chunk => { size += chunk.length; if (size <= 65536) parts.push(chunk); });
      ur.on("end", () => { if (size <= 65536) chatTitles.created(r, Buffer.concat(parts).toString()); });
    }
    ur.pipe(res);
  });
  up.on("error", () => { r.lost(); if (!res.headersSent) page(res, 200, "正在准备你的工作伙伴", "马上就好，页面会自动刷新。", true); });
  up.end(body);
}

const MARK = organization.appearance?.gateway?.mark || "";

function welcome(res, { title, lines, action, note }) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${organization.productName?.zh || "工作伙伴"}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:${organization.appearance?.gateway?.background || "#333"};color:${organization.appearance?.gateway?.foreground || "#333"};font:16px/1.7 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
main{width:min(440px,calc(100vw - 48px));padding:40px 32px 32px;background:#fff;border-radius:20px;box-shadow:0 1px 0 ${organization.appearance?.gateway?.shadow || "none"}}
h1{margin:20px 0 6px;font-size:24px;font-weight:650;color:${organization.appearance?.gateway?.accent || "#333"}}
ul{margin:16px 0 0;padding:0;list-style:none}
li{padding:10px 0;border-top:1px solid ${organization.appearance?.gateway?.divider || "#333"}}
li:first-child{border-top:0}
a.go{display:block;margin-top:28px;padding:13px 0;border-radius:12px;background:${organization.appearance?.gateway?.accent || "#333"};color:#fff;text-align:center;text-decoration:none;font-weight:600}
a.go:focus-visible{outline:3px solid ${organization.appearance?.gateway?.focus || "#333"};outline-offset:2px}
p.note{margin:14px 0 0;color:${organization.appearance?.gateway?.muted || "#333"};font-size:14px;text-align:center}
</style><main>${MARK}<h1>${title}</h1><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>${action ? `<a class="go" href="${action.href}">${action.text}</a>` : ""}${note ? `<p class="note">${note}</p>` : ""}</main></html>`);
}

function cookieOf(req, name) {
  return String(req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
}

const redirect = (res, location, cookie) => { res.writeHead(302, { location, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) }); res.end(); };
const PREPARING = ["正在准备你的工作伙伴", "第一次开通大约需要半分钟，页面会自动进入。"];

// 登录与开通：/_wp/login 去飞书授权（?onboard=1 时多要查群权限）→ /_wp/callback 发登录凭证，开通时检查试用群并建空间。
async function login(req, res, url, host) {
  if (url.pathname === "/_wp/login") {
    const state = crypto.randomBytes(16).toString("hex");
    const onboard = url.searchParams.get("onboard") === "1";
    const next = onboard ? "/_wp/preparing" : (url.searchParams.get("next") || "/").replace(/^(?!\/(?!\/)).*/, "/");
    return redirect(res, authorizeUrl(state, onboard, host), `wp_state=${state}|${onboard ? 1 : 0}|${encodeURIComponent(next)}; Path=/_wp; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  }
  // /_wp/callback
  const [state, onboard, next] = String(cookieOf(req, "wp_state") || "").split("|");
  if (!url.searchParams.get("code") || url.searchParams.get("state") !== state) {
    return welcome(res, { title: "飞书登录没有完成", lines: ["授权已过期或被取消。"], action: { href: "/_wp/login", text: "重新登录" } });
  }
  let who;
  try {
    who = await identify(url.searchParams.get("code"), onboard === "1", host);
  } catch (e) {
    console.log("登录回调出错", e.message);
    // 已登录的人（多半是刷新了回调页）直接进去；其他人重新走一遍飞书登录，授权码只能用一次。
    if (userFor(req).who) return redirect(res, decodeURIComponent(next || "/"));
    return welcome(res, { title: "飞书登录没有完成", lines: ["请再登录一次。"], action: { href: onboard === "1" ? "/_wp/login?onboard=1" : "/_wp/login", text: "重新登录" } });
  }
  const session = issueSession(who);
  if (onboard === "1" && !users().some((x) => x.unionId === who.unionId)) {
    if (!who.inPilot) {
      console.log(`不在试用群 ${who.name}`);
      return redirect(res, "/_wp/pilot", session);
    }
    provision(docker, who).catch((e) => console.log("开通失败", who.name, e.message));
  }
  return redirect(res, decodeURIComponent(next || "/"), session);
}

function welcomeNew(res, who) {
  return welcome(res, {
    title: "工作伙伴",
    lines: [
      `${who.name}，这是你的专属 AI 工作伙伴：写文档、做表格、查资料、分析文件，都可以交给它。`,
      "每人一个独立空间，同事之间看不到彼此的对话和文件。",
      "在浏览器中开始对话，文件保存在你的专属空间。",
    ],
    action: { href: "/_wp/login?onboard=1", text: "开通我的工作伙伴" },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `https://${PUBLIC_HOST}`);
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== PUBLIC_HOST && host !== `${PUBLIC_HOST}:443` && host !== new URL(organization.runtime.gatewayOrigin).host) {
      res.writeHead(403); return res.end();
    }
    if (await marketSkills(req, res, url)) return;
    if (url.pathname === "/_wp/logout") {
      res.setHeader("set-cookie", "wp_sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      return welcome(res, { title: "已退出登录", lines: ["此浏览器已退出工作伙伴。"], action: { href: "/_wp/login", text: "重新登录" } });
    }
    if (url.pathname === "/_wp/login" || url.pathname === "/_wp/callback") return await login(req, res, url, PUBLIC_HOST);
    if (url.pathname === "/_wp/me") {
      const { who, user } = userFor(req);
      if (!user) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ name: who.name, avatar: who.avatar }));
    }
    const r = await resolve(req);
    if (r.deny !== undefined) {
      if (!r.deny) {
        if (req.method === "GET" && !url.pathname.startsWith("/api/")) return redirect(res, `/_wp/login?next=${encodeURIComponent(req.url)}`);
        res.writeHead(401); return res.end();
      }
      if (url.pathname === "/_wp/preparing") {
        if (provisioning(r.deny.unionId)) return page(res, 200, ...PREPARING, true);
        return welcome(res, { title: "工作伙伴待开通", lines: ["开通暂未完成，模型钥匙或工作空间尚未准备好。", "请稍后重试；如果仍无法开通，请联系管理员。"], action: { href: "/_wp/login?onboard=1", text: "重新开通" } });
      }
      if (url.pathname === "/_wp/pilot") return welcome(res, { title: "暂未开通", lines: ["工作伙伴目前只对指定群组的成员开放。", "加入指定群组后，重新打开即可开通。"], action: { href: "/_wp/login?onboard=1", text: "我已入群，重新开通" } });
      return welcomeNew(res, r.deny);
    }
    if (url.pathname === "/_wp/preparing") {
      if (!r.cookie) return page(res, 200, ...PREPARING, true);
      return redirect(res, "/");
    }
    const titleMatch = /^\/_wp\/next-title\/([\w-]+)$/.exec(url.pathname);
    if (titleMatch) {
      if (req.method !== "POST" || (req.headers.origin && req.headers.origin !== `https://${PUBLIC_HOST}`)) {
        res.writeHead(403); return res.end();
      }
      const changed = r.backend === "aionui" && r.cookie ? await chatTitles.generate(r, titleMatch[1]) : false;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ changed }));
    }
    if (url.pathname.startsWith("/_wp/")) return redirect(res, "/");
    if (r.missing) return page(res, 503, "工作空间还没建好", "请联系管理员。");
    if (!r.cookie) return page(res, 200, "正在准备你的工作空间", "通常不超过半分钟，页面会自动刷新。", true);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const titleWrite = chatTitles.before(req, r, body);
      if (titleWrite) await titleWrite;
      proxy(req, res, r, body);
    });
  } catch (e) {
    console.log("出错", e.message);
    if (!res.headersSent) page(res, 200, "正在准备你的工作伙伴", "马上就好，页面会自动刷新。", true);
  }
});

server.on("upgrade", async (req, socket, head) => {
  try {
    const r = await resolve(req);
    if (!r.cookie) return socket.destroy();
    const up = net.connect(r.port, r.up.ip, () => {
      up.write(upgradeHead(req, r.headers(req, r.cookie)));
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`工作伙伴网关 :${PORT}`));

// 新版后端：AionUi 网页版 + Claude Code。名单里 backend 为 "aionui" 的人走这里，其余仍走 旧版后端。
// 每人容器 <prefix><slug> 在自己的网络 <prefix><slug>-net 里，只有网关和模型出口 接入，不映射端口。
// AionUi 接口本身不校验登录，所以网关替本人登录：口令存在网关侧（600），会话 cookie 只在网关内存里，
// 转发时换掉浏览器带来的 cookie，浏览器始终拿不到 AionUi 的口令和会话。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const AIONUI_PORT = 25808;
export const NEXT_PREFIX = "workpartner-next-";
export const nextNames = (slug, prefix = NEXT_PREFIX) => ({ container: `${prefix}${slug}`, network: `${prefix}${slug}-net` });

/** 转发给 AionUi 的请求头：去掉浏览器的全部 cookie（含网关自己的 wp_sid），只放网关持有的 AionUi 会话。 */
export function aionuiHeaders(req, cookie) {
  const headers = { ...req.headers };
  delete headers.cookie;
  return cookie ? { ...headers, cookie } : headers;
}

/**
 * AionUi 静态文件的 ETag：容器镜像 ID + 请求路径。同一个镜像里同一路径的内容不变，镜像一换（升级、换品牌）ETag 就变。
 * 非 GET/HEAD 请求，以及 AionUi 交给后端处理的 /api（含 /api/、/api?）、/login、/logout 不是静态文件，返回 null。
 */
export function aionuiEtag(imageId, req) {
  if (!imageId || (req.method !== "GET" && req.method !== "HEAD")) return null;
  const pathname = req.url.split("?")[0];
  if (pathname === "/api" || pathname.startsWith("/api/") || pathname === "/login" || pathname === "/logout") return null;
  return `"${crypto.createHash("sha1").update(`${imageId}\0${req.url}`).digest("hex").slice(0, 20)}"`;
}

/** If-None-Match 是否命中这个 ETag（支持逗号分隔的多个值和 W/ 前缀）。 */
export function etagMatches(req, etag) {
  const header = req.headers["if-none-match"];
  return !!etag && !!header && String(header).split(",").some((v) => v.trim().replace(/^W\//, "") === etag);
}

/**
 * 转发给浏览器的 AionUi 响应首部：去掉 set-cookie；没有 Cache-Control 的补 no-cache（浏览器可以存，但每次先向服务器确认）。
 * AionUi 的静态文件只发 Last-Modified，浏览器会按启发式缓存，镜像升级后还在用旧页面。/assets/ 也不例外：
 * 换品牌时原地改了其中几十个文件，文件名里的 hash 不变、内容随版本变。
 * AionUi 不认 If-Modified-Since、也不发 ETag，所以 200 的静态文件由网关补 ETag（etag 参数），之后的确认由网关用 304 直接答复。
 */
export function aionuiResponseHeaders(upstream, etag, status = 200) {
  const headers = { ...upstream };
  delete headers["set-cookie"];
  if (!headers["cache-control"]) headers["cache-control"] = "no-cache";
  if (etag && status === 200 && !headers.etag) headers.etag = etag;
  return headers;
}

/** WebSocket 升级请求的首部文本，规则与普通请求相同。 */
export function upgradeHead(req, headers) {
  return `${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers)
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`)).join("\r\n") + "\r\n\r\n";
}

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

/** 消息桥（cc-connect）本地接口的套接字，位于 image/home/cc-connect-feishu.toml 的 data_dir 下。 */
export const BRIDGE_SOCKET = "/data/.cc-connect/data/run/api.sock";

// 在本人容器里执行：经消息桥本地接口列出会话（/sessions），逐个读 /assistant/state 的 busy。
// 只输出 {"busy":true|false}；任一会话读不到状态（接口缺失、409 正在接收消息、其他错误）就以非零退出，由网关按旧规则判断。
function bridgeTurnReader() {
  const http = require("node:http");
  const socketPath = process.argv[1];
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: p, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
  (async () => {
    const list = await get("/sessions");
    if (list.status !== 200) throw new Error(`sessions ${list.status}`);
    for (const s of JSON.parse(list.body) || []) {
      const r = await get(`/assistant/state?${new URLSearchParams({ project: s.project, session_key: s.session_key })}`);
      if (r.status !== 200) throw new Error(`state ${r.status}`);
      if (JSON.parse(r.body).busy === true) return true;
    }
    return false;
  })().then((busy) => process.stdout.write(JSON.stringify({ busy })), (e) => { process.stderr.write(e.message); process.exit(3); });
}
const bridgeTurnScript = `(${bridgeTurnReader.toString()})()`;

/**
 * @param o.runtime Personal runtime for lifecycle, storage and endpoint resolution.
 * @param o.modelConfig Current non-secret model defaults and catalog.
 * @param o.image Target personal image reference.
 * @param o.userImages Optional personal image references by user slug (Kubernetes only).
 * @param o.secretDir Gateway-only password directory.
 * @param o.maxJobs 不同人同时进行的开通/启动/重置任务上限（默认 2），超出时 upstream 返回 null，页面稍后自动刷新重试
 * @param o.resetBackoffMs 同一人两次口令重置之间的最短间隔（默认 60 秒）
 * @param o.waitTimeoutMs 等一次性重置容器退出的上限（默认 60 秒）
 * @param o.recheckMs 已接入的网络成员（网关、模型出口）重新核对的间隔（默认 60 秒）
 * @param o.busyRecheckMs 镜像过期但本人有对话正在处理时，多久之后再查一次（默认 30 秒；期间继续用旧容器）
 * @param o.maxDeferMs 因为有任务在跑而推迟重建，连续观察到忙最多多久（默认 30 分钟）；超过就强制重建并记日志
 * @param o.newRoundGapMs 距上次查到忙超过多久就当新一轮重新计推迟时间（默认 10 分钟，与 busyRecheckMs 无关）
 * @param o.topTimeoutMs 查消息桥进程和对话状态的超时（默认 5 秒），进程查询超时按空闲处理
 * @param o.uid 在本人容器里查消息桥状态时使用的用户
 * @param o.reconcileExclude 后台巡检不碰的用户 slug
 * @param o.now 当前毫秒数（测试用）
 */
export function createAionui(o) {
  const { runtime, sleep = sleepFor, log = console.log, now = Date.now } = o;
  const owns = o.owns || (() => true);
  const maxJobs = o.maxJobs ?? 2;
  const resetBackoffMs = o.resetBackoffMs ?? 60000;
  const waitTimeoutMs = o.waitTimeoutMs ?? 60000;
  const recheckMs = o.recheckMs ?? 60000;
  const busyRecheckMs = o.busyRecheckMs ?? 30000;
  const maxDeferMs = o.maxDeferMs ?? 30 * 60000;
  const newRoundGapMs = o.newRoundGapMs ?? 10 * 60000;
  const topTimeoutMs = o.topTimeoutMs ?? 5000;
  const sessions = new Map();     // slug -> cookie 文本
  const joined = new Map();       // slug -> 上次确认网关和模型出口 在其网络里的时间
  const jobs = new Map();         // slug -> 进行中的开通、启动或重置
  const resolving = new Map();    // slug -> 正在核对状态的 upstream（并发请求共用，避免重复起任务）
  const lastReset = new Map();    // slug -> 上次开始重置口令的时间
  const busyUntil = new Map();    // slug -> 查到有任务正在跑后，到这个时间前不再查、不重建
  const busySince = new Map();    // slug -> 这一轮连续观察到忙的起点
  const lastBusyAt = new Map();   // slug -> 最近一次查到忙的时间；与这次间隔超过 newRoundGapMs 说明中间没人访问，算新一轮
  const updating = new Set();     // slug -> 进行中的任务在替换或重启已有容器（页面显示“正在更新”）
  const forcePending = new Map(); // slug -> 判定强制重建的时间：任务已满还没起任务；有空位时直接重建、不再重查；超过 newRoundGapMs 作废，回到正常判断

  async function ensureNetwork(slug) {
    await runtime.ensureIsolation(slug);
    joined.set(slug, now());
  }

  async function create(user, modelConfig) {
    await runtime.create(user, { modelConfig });
    log(`新版工作伙伴容器已建 ${user.name || ""}（${user.slug}）`);
  }

  // 等 AionUi 接口能答话（不需要登录的状态接口），最多约 60 秒。
  async function waitReady(address) {
    for (let i = 0; i < 240; i++) {
      const status = await call(address, "GET", "/api/auth/status").then((r) => r.status, () => 0);
      if (status && status < 500) return true;
      await sleep(250);
    }
    return false;
  }

  const passFile = (slug) => path.join(o.secretDir, `aionui-${slug}.pass`);

  // 重置 AionUi 的 admin 口令并存到网关侧（口令不写日志）。AionUi 运行时独占数据目录，
  // 所以在本人容器停着的时候，用同一镜像、同一数据目录、无网络的一次性容器执行 resetpass。
  async function resetPassword(slug) {
    const result = await runtime.runOnce(slug, {
      entrypoint: ["/opt/aionui/aionui-web"], cmd: ["resetpass", "--data-dir", "/data/aionui-data"], timeoutMs: waitTimeoutMs,
    });
    const pass = result.logs.match(/new password:\s*(\S+)/i)?.[1];
    if (!pass) throw new Error("AionUi 没有返回新口令");
    fs.mkdirSync(o.secretDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(passFile(slug), pass, { mode: 0o600 });
  }

  // 容器、网络、口令都就绪后返回地址；需要开通、启动或重置口令时在后台进行，期间返回 null（页面显示“正在准备”）。
  // 同一人的并发请求共用一次核对，所以同一人最多一个任务；不同人的任务达到 maxJobs 后不排队，直接返回 null。
  function upstream(user) {
    const { slug } = user;
    if (!owns(user)) return Promise.resolve(null);
    if (jobs.has(slug)) return Promise.resolve(null);
    if (!resolving.has(slug)) resolving.set(slug, resolveUpstream(user).finally(() => resolving.delete(slug)));
    return resolving.get(slug);
  }

  async function isStale(slug, info, modelConfig) {
    const targetImage = o.userImages?.[slug] ?? o.image;
    let stale = info.exists && info.image !== targetImage;   // 镜像升级：删旧容器按新镜像重建，数据目录不变
    if (info.exists && !stale) {
      // 标签可原名重建；目标镜像不可用时仍按镜像名判断，不据此删除容器。
      let target;
      try { target = await runtime.imageId(targetImage); }
      catch (e) { log(`查新版工作伙伴目标镜像失败（${e.message}），仍按镜像名判断`); }
      stale = !!target && info.imageId !== target;
    }
    if (info.exists && modelConfig && !(info.env || []).includes(`WORKPARTNER_MODEL_CONFIG=${modelConfig}`)) stale = true;
    if (info.exists && o.sharedSkills && !(info.env || []).includes(`WORKPARTNER_SHARED_SKILLS=${o.sharedSkills.container}`)) stale = true;
    if (info.exists && o.sharedSkills && !(info.env || []).includes(`WORKPARTNER_MARKET_PREINSTALLED=${JSON.stringify(o.sharedSkills.preinstalled)}`)) stale = true;
    return stale;
  }

  // background：后台巡检，只替换正在运行、有口令、镜像或环境过期且空闲的容器；忙时跳过，不计入强制重建的推迟时长。
  // 其余情况返回旧容器地址或 null，与网页请求共用同一个 resolving，避免两边同时重建。
  async function resolveUpstream(user, background = false) {
    const { slug } = user;
    const info = await runtime.inspect(slug);
    if (!owns(user) || jobs.has(slug)) return null;
    if (background && !info.running) return null;
    const hasPass = fs.existsSync(passFile(slug));
    const modelConfig = o.modelConfig ? JSON.stringify(o.modelConfig()) : null;
    let stale = await isStale(slug, info, modelConfig);
    if (!stale) { busySince.delete(slug); lastBusyAt.delete(slug); forcePending.delete(slug); }
    let forced = false;
    let current = null;   // 旧容器仍可用时的地址
    if (info.running && hasPass) {
      if (!joined.has(slug) || now() - joined.get(slug) >= recheckMs) await ensureNetwork(slug);
      const address = info.address;
      // 重建会打断正在进行的对话：有对话在处理就这次不重建，继续用旧容器，下次请求再查。
      if (address) current = { name: info.name, address, imageId: info.imageId };
      if (stale && address && background) {
        const what = await busyNow(slug, address);
        if (what) { log(`后台巡检：新版工作伙伴镜像已更新，${slug} ${what}，暂不重建`); stale = false; }
      } else if (stale && address) {
        if (forcePending.has(slug) && now() - forcePending.get(slug) > newRoundGapMs) forcePending.delete(slug);
        if (forcePending.has(slug)) forced = true;
        else {
          const verdict = await processing(slug, address);
          if (verdict === true) stale = false; else forced = verdict === "force";
        }
      }
      if (address && !stale) return current;
    }
    if (background && !(stale && current)) return current;
    if (jobs.size >= maxJobs) {
      if (background) return current;
      // 已强制但任务已满：先用旧容器（照常可用），强制标记保留到有空位时再重建
      if (forced && !forcePending.has(slug)) forcePending.set(slug, now());
      return forced ? current : null;
    }
    if (stale) { busySince.delete(slug); lastBusyAt.delete(slug); busyUntil.delete(slug); forcePending.delete(slug); }   // 重建任务真正开始才清
    const needReset = !hasPass;
    if (needReset && now() - (lastReset.get(slug) ?? -Infinity) < resetBackoffMs) return null;
    // 各阶段耗时写进日志，用来找重启慢在哪一步。
    const phases = [];
    let mark = Date.now();
    const timed = async (name, work) => {
      const result = await work();
      const t = Date.now();
      phases.push(`${name} ${((t - mark) / 1000).toFixed(1)}s`);
      mark = t;
      return result;
    };
    const began = mark;
    if (info.exists) updating.add(slug);
    const job = (async () => {
      await ensureNetwork(slug);
      if (stale) {
        if (info.running) await timed("停止", () => runtime.stop(slug));
        await timed("删除", () => runtime.remove(slug));
      }
      if (!info.exists || stale) await timed("创建", () => create(user, modelConfig));
      if (needReset) {
        if (info.running && !stale) await timed("停止", () => runtime.stop(slug));
        lastReset.set(slug, now());
        await timed("重置口令", () => resetPassword(slug));
      }
      const cur = await runtime.inspect(slug);
      if (!cur.running) await timed("启动容器", () => runtime.start(slug));
      sessions.delete(slug);
      const address = await runtime.address(slug);
      if (!address || !await timed("网页就绪", () => waitReady(address))) throw new Error("AionUi 没有就绪");
      log(`新版工作伙伴已就绪 ${slug}：${phases.join("、")}，共 ${((Date.now() - began) / 1000).toFixed(1)}s`);
    })().catch((e) => { joined.delete(slug); log(`新版工作伙伴准备失败 ${slug}：${e.message}（${phases.join("、") || "未完成任何阶段"}）`); })
      .finally(() => { jobs.delete(slug); updating.delete(slug); });
    jobs.set(slug, job);
    if (background) log(`后台巡检：${slug} 空闲，按新版工作伙伴镜像重建`);
    return null;
  }

  // 本人容器里有没有任务在跑，两处任一处在跑就算忙：
  // 1) AionUi 网页对话：列表里没结束的（status 不是 finished）逐个看 runtime.is_processing；
  // 2) 消息桥：先看容器进程树里 cc-connect 有没有子进程（它起的 codex / claude）；没有就是空闲。
  //    有子进程时问消息桥本地接口（BRIDGE_SOCKET）各会话有没有回合在跑：Claude Code 引擎在对话结束后保留空闲进程
  //    （idle_timeout 内），只看进程会把刚用过飞书的人都当成忙。接口读不到时退回旧规则：有子进程就算忙。
  //    AionUi 自己起的 agent 挂在 aioncore 下，不在 cc-connect 的子树里，所以两边分得开。
  // 接口出错或超时按空闲处理（容器答不了话时重建正好能恢复）。查到在忙后 busyRecheckMs 内不再查。
  // 连续观察到忙超过 maxDeferMs（is_processing 卡住或进程不退出）就不再推迟，强制重建。
  // 上限只计连续观察：与上次查到忙间隔超过 newRoundGapMs（默认 10 分钟）说明中间没人访问，当新一轮；到上限前每次都照常查当前状态。
  // 返回 true：忙，继续用旧容器；"force"：忙但已到上限，强制重建；false：空闲，重建。
  async function processing(slug, address) {
    const t = now();
    if (t < (busyUntil.get(slug) ?? 0)) return true;
    const what = await busyNow(slug, address);
    if (!what) {
      busyUntil.delete(slug); busySince.delete(slug); lastBusyAt.delete(slug);
      return false;
    }
    if (!busySince.has(slug) || t - lastBusyAt.get(slug) > newRoundGapMs) busySince.set(slug, t);
    lastBusyAt.set(slug, t);
    if (t - busySince.get(slug) >= maxDeferMs) {
      log(`新版工作伙伴镜像已更新，${slug} 已连续推迟重建超过 ${Math.round(maxDeferMs / 60000)} 分钟（${what}），强制重建`);
      return "force";
    }
    busyUntil.set(slug, t + busyRecheckMs);
    log(`新版工作伙伴镜像已更新，${slug} ${what}，暂不重建`);
    return true;
  }

  // 两处都空闲返回空串，否则返回忙的原因。
  async function busyNow(slug, address) {
    const web = await aionuiBusy(slug, address);
    const bridge = await bridgeBusy(slug);
    return [web && "有对话正在处理", bridge && "消息桥有任务在跑"].filter(Boolean).join("、");
  }

  async function aionuiBusy(slug, address) {
    try {
      const get = async (p) => {
        const r = await call(address, "GET", p);
        if (r.status !== 200) throw new Error(`${p} 返回 ${r.status}`);
        return JSON.parse(r.body).data;
      };
      for (const c of (await get("/api/conversations?limit=10000")).items) {
        if (c.status === "finished") continue;
        if ((await get(`/api/conversations/${encodeURIComponent(c.id)}`)).runtime?.is_processing) return true;
      }
    } catch (e) {
      log(`查 ${slug} 正在处理的对话失败（${e.message}），按空闲处理`);
    }
    return false;
  }

  const withTimeout = (work) => {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("超时")), topTimeoutMs); });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };

  async function bridgeBusy(slug) {
    let procs;
    try { procs = await withTimeout(runtime.processes(slug, topTimeoutMs)); }
    catch (e) {
      log(`查 ${slug} 消息桥进程失败（${e.message}），按空闲处理`);
      return false;
    }
    const roots = new Set(procs.filter((p) => /(^|\/)cc-connect$/.test(p.args.split(/\s+/)[0])).map((p) => p.pid));
    if (!procs.some((p) => roots.has(p.ppid))) return false;
    try {
      const result = await withTimeout(runtime.exec(slug, ["node", "-e", bridgeTurnScript, BRIDGE_SOCKET],
        { ...(o.uid !== undefined ? { user: String(o.uid) } : {}), timeout: topTimeoutMs }));
      if (result.exitCode !== 0) throw new Error(`退出码 ${result.exitCode}`);
      const { busy } = JSON.parse(result.stdout);
      if (typeof busy !== "boolean") throw new Error("输出无效");
      return busy;
    } catch (e) {
      log(`查 ${slug} 消息桥对话状态失败（${e.message}），有子进程按忙处理`);
      return true;
    }
  }

  function call(address, method, p, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const q = http.request({ ...address, path: p, method, timeout: 10000,
        headers: body ? { "content-type": "application/json", ...headers } : headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      q.on("timeout", () => q.destroy(new Error("超时")));
      q.on("error", reject);
      q.end(body ? JSON.stringify(body) : undefined);
    });
  }

  // 返回 {status, cookie}；网络错误或超时抛出。
  async function login(up, pass) {
    const r = await call(up.address, "POST", "/login", { username: "admin", password: pass });
    const cookie = (r.headers["set-cookie"] || []).map((c) => c.split(";")[0]).filter((c) => c.includes("=")).join("; ");
    return { status: r.status, cookie: r.status === 200 && cookie ? cookie : null };
  }

  /** 本人的 AionUi 会话；force 时重新登录。只有 /login 明确返回 401/403（口令错了，如被人在容器里重置过）
   *  才作废口令文件，下一次 upstream 在后台重置口令；网络错误、超时、5xx、429、无 cookie 都只返回 null
   *  （页面显示“正在准备”并自动刷新），口令和容器不动，下次请求重试。 */
  async function session(slug, up, force = false) {
    if (!force && sessions.has(slug)) return sessions.get(slug);
    sessions.delete(slug);
    let pass;
    try { pass = fs.readFileSync(passFile(slug), "utf8").trim(); } catch { return null; }
    let r;
    try { r = await login(up, pass); } catch (e) { log(`新版工作伙伴登录出错 ${slug}：${e.message}`); return null; }
    if (r.status === 401 || r.status === 403) { fs.rmSync(passFile(slug), { force: true }); return null; }
    if (!r.cookie) return null;
    sessions.set(slug, r.cookie);
    return r.cookie;
  }

  /** 转发失败（网络被断开等）时调用：下次请求重新核对网络。 */
  const forget = (slug) => { joined.delete(slug); };

  let keepRunningTimer, keeping;
  function keepRunning(users) {
    if (o.kind !== 'k8s') return Promise.resolve();
    if (keeping) return keeping;
    keeping = (async () => {
      for (const user of users()) {
        const { slug } = user;
        if (user.backend !== 'aionui' || !owns(user) || jobs.has(slug) || resolving.has(slug)) continue;
        const job = Promise.resolve().then(async () => {
          const info = await runtime.inspect(slug);
          // Only an explicit zero is stopped; older runtimes may omit these fields.
          if (!owns(user) || !info.exists || info.replicas !== 0 || info.running
            || Object.hasOwn(info.annotations || {}, 'workpartner/paused')) return;
          await runtime.start(slug);
          log(`Workspace kept running: ${slug}`);
        }).catch(error => log(`Workspace keep-running failed: ${slug} (${error.code || error.name})`))
          .finally(() => jobs.delete(slug));
        jobs.set(slug, job);
        await job;
      }
    })().finally(() => { keeping = undefined; });
    return keeping;
  }
  function startKeepRunning(users, intervalMs = 300000) {
    clearInterval(keepRunningTimer);
    if (o.kind !== 'k8s' || intervalMs === 0) return;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('Invalid keepRunningIntervalMs');
    const tick = () => keepRunning(users).catch(error => log(`Workspace keep-running unavailable (${error.code || error.name})`));
    void tick();
    keepRunningTimer = setInterval(tick, intervalMs);
    keepRunningTimer.unref();
  }

  // 后台替换镜像或环境过期的空闲容器，不等网页请求（只用飞书的人也能换上新镜像）。忙的跳过，下一轮再看；
  // 同时进行的任务仍受 maxJobs 限制，排不上的留到下一轮；reconcileExclude 里的人不碰。
  const reconcileExclude = new Set(o.reconcileExclude || []);
  let reconcileTimer, reconciling;
  function reconcileImages(users) {
    if (o.kind !== 'k8s') return Promise.resolve();
    if (reconciling) return reconciling;
    reconciling = (async () => {
      for (const user of users()) {
        const { slug } = user;
        if (user.backend !== 'aionui' || reconcileExclude.has(slug) || !owns(user) || jobs.has(slug) || resolving.has(slug)) continue;
        const check = resolveUpstream(user, true).finally(() => resolving.delete(slug));
        resolving.set(slug, check);
        await check.catch(error => log(`后台巡检失败 ${slug}：${error.message}`));
      }
    })().finally(() => { reconciling = undefined; });
    return reconciling;
  }
  function startReconcileImages(users, intervalMs = 0) {
    clearInterval(reconcileTimer);
    if (o.kind !== 'k8s' || intervalMs === 0) return;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('Invalid reconcileImagesIntervalMs');
    reconcileTimer = setInterval(() => reconcileImages(users).catch(error => log(`后台巡检出错：${error.message}`)), intervalMs);
    reconcileTimer.unref();
  }
  const close = () => { clearInterval(keepRunningTimer); clearInterval(reconcileTimer); };

  return { upstream, updating: (slug) => updating.has(slug), session, forget, keepRunning, startKeepRunning, reconcileImages, startReconcileImages, close, pending: (slug) => jobs.get(slug) };
}

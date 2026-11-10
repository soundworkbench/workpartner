// 自助开通：飞书授权确认身份 → 判断是否在试用群 → 准备模型钥匙 → 写入新版名单。
// 新版容器与网络在访问时由 aionui.mjs 准备；名单原地改写（单文件挂载不能换 inode）。
import { resolveOrganization } from "./organization/resolve.mjs";
import fs from "node:fs";
import crypto from "node:crypto";

const organization = resolveOrganization();
const APP_ID = organization.identity.appId;
const CHAT_ID = organization.identity.pilotChatId;
const PUBLIC_HOST = organization.server.publicHost;
const USERS_FILE = organization.runtime.usersFile;
const redirectUri = (host) => `https://${host}${organization.identity.callbackPath}`;
const KEY_PREFIX = organization.model.keyPrefix;
const KEY_POOL = organization.model.keyMode === "pool" ? `${organization.runtime.secureDirectory}/${KEY_PREFIX}pool` : null;
const DSH_UID = organization.runtime.uid;

const secret = () => fs.readFileSync(organization.identity.appSecretFile, "utf8").trim();
export const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
const writeUsers = (list) => fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 1));

// 平时登录只要基本身份（飞书内免确认）；开通时多要“查看群成员”，用来确认他在试用群里。
// host 是这次登录所在的网址，飞书回调回到同一个网址（登录状态的 cookie 按网址存）。
export function authorizeUrl(state, onboard, host = PUBLIC_HOST) {
  const q = new URLSearchParams({ client_id: APP_ID, response_type: "code", redirect_uri: redirectUri(host), state, ...(onboard && organization.identity.admission === "pilot-group" ? { scope: "im:chat.members:read" } : {}) });
  return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${q}`;
}

async function feishu(path, init) {
  const r = await fetch(`https://open.feishu.cn/open-apis${path}`, { ...init, signal: AbortSignal.timeout(15000) });
  return r.json();
}

// 用授权码换这个人的身份；开通时再用他自己的令牌问飞书“他在不在试用群里”。
export async function identify(code, onboard, host = PUBLIC_HOST) {
  const tok = await feishu("/authen/v2/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: APP_ID, client_secret: secret(), code, redirect_uri: redirectUri(host) }),
  });
  if (!tok.access_token) throw new Error(`飞书授权失败：${tok.error_description || tok.msg || tok.code}`);
  const auth = { headers: { authorization: `Bearer ${tok.access_token}` } };
  const info = await feishu("/authen/v1/user_info", auth);
  if (info.code !== 0) throw new Error(`读取飞书身份失败：${info.msg}`);
  const who = { unionId: info.data.union_id, name: info.data.name, avatar: info.data.avatar_middle || info.data.avatar_url || "" };
  if (!onboard) return who;
  if (organization.identity.admission === "unrestricted") return { ...who, inPilot: true };
  const chat = await feishu(`/im/v1/chats/${CHAT_ID}/members/is_in_chat`, auth);
  if (chat.code !== 0) console.log(`查试用群失败 ${who.name}：${chat.code} ${chat.msg}`);
  return { ...who, inPilot: chat.code === 0 && chat.data?.is_in_chat === true };
}

export const slugFor = (unionId) => "u" + crypto.createHash("sha256").update(unionId).digest("hex").slice(0, 8);

async function modelKey(runtime, slug) {
  const file = `${organization.runtime.secureDirectory}/${KEY_PREFIX}${slug}.key`;
  if (fs.existsSync(file)) return;
  if (KEY_POOL) {
    const spare = fs.readdirSync(KEY_POOL).filter((f) => f.endsWith(".key")).sort()[0];
    if (!spare) throw new Error("预建的模型钥匙用完了");
    fs.renameSync(`${KEY_POOL}/${spare}`, file);
    fs.chownSync(file, DSH_UID, DSH_UID);
    fs.appendFileSync(`${KEY_POOL}/assigned.log`, `${spare} ${slug} ${new Date().toISOString()}\n`);
    return;
  }
  const settings = organization.model.provision;
  if (!settings) throw new Error("请先在钥匙池准备模型钥匙");
  const name = `${organization.runtime.containerPrefix}${slug}`;
  const exec = (...args) => runtime.execNamed(settings.container, [...settings.command, ...args], { createTimeout: 0, timeout: 0 }).then(result => result.logs);
  const key = (await exec("add", name)).match(new RegExp(settings.keyPattern))?.[0];
  if (!key) throw new Error("模型服务没有返回钥匙");
  fs.writeFileSync(file, key, { mode: 0o400 });
  fs.chownSync(file, DSH_UID, DSH_UID);
  const line = (await exec("list")).split("\n").find((l) => l.includes(` ${name} `));
  if (line) await exec("models", line.trim().split(/\s+/)[0], ...settings.models);
}

const running = new Map();

/** 开通是否仍在进行；结束后未入名单的人保持待开通，可重新授权重试。 */
export const provisioning = (unionId) => running.has(slugFor(unionId));

// 开通一个人；同一人重复触发只跑一次。已有名单记录原样返回，不切换旧用户。
export function provision(runtime, { unionId, name }) {
  const slug = slugFor(unionId);
  if (!running.has(slug)) {
    running.set(slug, (async () => {
      const existing = readUsers().find((user) => user.unionId === unionId);
      if (existing) return existing;
      await modelKey(runtime, slug);
      if (!fs.readFileSync(`${organization.runtime.secureDirectory}/${KEY_PREFIX}${slug}.key`, "utf8").trim()) throw new Error("模型钥匙尚未准备好");
      const list = readUsers().filter((x) => x.slug !== slug);
      const row = { slug, name, unionId, backend: "aionui", since: new Date().toISOString() };
      list.push(row);
      writeUsers(list);
      console.log(`自助开通 ${name}（${slug}）`);
      return row;
    })().finally(() => running.delete(slug)));
  }
  return running.get(slug);
}


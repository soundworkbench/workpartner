// 桌面与容器共用网关签发的 zpd 身份；每次请求仍核对开通名单。
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/** 签发有效期 180 天的 zpd 令牌。
 * @param key 网关签名密钥。
 * @param user 已开通用户。
 * @param now 签发时间（毫秒）。
 * @returns 已签名的字面令牌。
 */
export function issueToken(key, user, now = Date.now()) {
  const data = Buffer.from(JSON.stringify({ u: user.unionId, e: Math.floor(now / 1000) + 180 * 86400 })).toString("base64url");
  const mac = crypto.createHmac("sha256", key).update(`zpd.${data}`).digest("base64url");
  return `zpd.${data}.${mac}`;
}

/** 核对 Bearer 签名、期限与当前开通名单。
 * @param req HTTP 请求。
 * @param key 网关签名密钥。
 * @param users 当前开通名单。
 * @param now 当前时间（毫秒）。
 * @returns 本人记录；无效身份为 null。
 */
export function tokenUser(req, key, users, now = Date.now()) {
  const match = /^Bearer (zpd)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization || "");
  if (!match) return null;
  const [, , data, mac] = match;
  const expected = crypto.createHmac("sha256", key).update(`zpd.${data}`).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let value;
  try { value = JSON.parse(Buffer.from(data, "base64url").toString()); } catch (error) { return null; } // 非 JSON 令牌拒绝。
  return value && typeof value.u === "string" && Number.isFinite(value.e) && value.e > now / 1000
    ? users.find((user) => user.unionId === value.u) ?? null : null;
}

/** Keep synchronous root/uid calls compatible; runtime calls return a Promise. */
export function writeContainerToken(key, user, root = "/users", uid = 1001) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(user.slug)) throw new Error("用户代号无效");
  if (typeof root === 'string') return require('./runtime/docker.mjs').writeContainerTokenFile(issueToken(key, user) + "\n", user.slug, root, uid);
  return root.putFiles(user.slug, [{ path: '.zp-market-token', content: issueToken(key, user) + "\n", mode: 0o600 }], { directoryMode: 0o777 });
}

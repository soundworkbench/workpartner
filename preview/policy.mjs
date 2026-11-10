/** Preview ports exclude privileged services and the workspace control plane. */
export const RELAY_PORT = 3092;
const RESERVED = new Set([3080, 3090, 3091, RELAY_PORT]);

/** Parse an external port; never accept hostnames, coercions or control ports. */
export function previewPort(value) {
  if (!/^[1-9][0-9]{3,4}$/.test(String(value))) return null;
  const port = Number(value);
  return port >= 1024 && port <= 65535 && !RESERVED.has(port) ? port : null;
}

/** Accept only a root-relative path without URL-normalized controls, keeping queries and fragments. */
export function previewPath(value) {
  return typeof value === "string" && value.length <= 16384 && value.startsWith("/")
    && !value.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(value) ? value : null;
}

/** Remove gateway credentials while preserving an editor's own cookies. */
export function editorCookie(value = "") {
  return value.split(/;\s*/).filter((item) => !/^(?:__Host-zp[-_]|zp_)/i.test(item)).join("; ");
}

/** Drop proxy metadata supplied by the browser; each trusted hop sets its own. */
export function editorHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (/^(?:x-zp-|x-forwarded-|forwarded$|proxy-authorization$|referer$)/i.test(key)) delete out[key];
  }
  if (out.cookie) out.cookie = editorCookie(out.cookie);
  return out;
}

/** Force editor cookies to this exact preview host and reserve authentication names. */
export function editorSetCookies(cookies = []) {
  return cookies.filter((cookie) => !/^(?:__Host-zp[-_]|zp_)/i.test(cookie))
    .map((cookie) => cookie.replace(/;\s*Domain=[^;]*/ig, ""));
}

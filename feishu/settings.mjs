import { authorizationPage } from "./page.mjs";

/** Serve an authenticated settings page and project Device Code operations.
 * @param options Base path, expected origin, identity resolver, Feishu status/disconnect and project adapter.
 * @returns HTTP handler returning true only for the owned settings routes.
 */
export function createSettingsHandler({ basePath, origin, identify, status, disconnect, project, connectUrl, local = false, appearanceStyle }) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith(basePath)) return false;
    const route = url.pathname.slice(basePath.length);
    if (!["", "status", "disconnect", "connect", "project/status", "project/connect", "project/poll", "project/disconnect"].includes(route)) return false;
    const reply = (code, value) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      const user = identify(req);
      if (!user) { reply(401, { message: "请先登录工作伙伴" }); return true; }
      if ((route === "" || route === "connect" || route.endsWith("status")) ? req.method !== "GET" : req.method !== "POST") { reply(405, { message: "请求方法不支持" }); return true; }
      if (req.method === "POST" && req.headers.origin !== origin) { reply(403, { message: "请从飞书授权页面操作" }); return true; }
      if (route === "") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        res.end(authorizationPage({ local, appearanceStyle }));
      } else if (route === "connect") { res.writeHead(302, { location: connectUrl, "cache-control": "no-store" }); res.end(); }
      else if (route === "status") reply(200, await status(user));
      else if (route === "disconnect") reply(200, await disconnect(user));
      else if (route === "project/status") reply(200, await project.status(user));
      else if (route === "project/connect") reply(200, await project.connect(user));
      else if (route === "project/poll") reply(200, await project.poll(user));
      else if (route === "project/disconnect") reply(200, await project.disconnect(user));
    } catch (error) { reply(error.status || 503, { message: error.status ? error.message : "暂时无法处理授权，请检查登录、安装和网络后重试" }); }
    return true;
  };
}

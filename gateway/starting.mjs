// 个人工作区还没就绪（开通、启动、更新重启）时给浏览器的答复。
// 打开或刷新页面时显示会自动刷新的说明页；页面里的接口、脚本和图片请求答 503，
// 免得说明页被当成接口数据或脚本，页面里的脚本按暂时不可用处理并稍后重试。

/** 浏览器打开或刷新页面，而不是页面里发出的接口、脚本、图片请求。 */
export function isNavigation(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const mode = req.headers["sec-fetch-mode"];
  if (mode) return mode === "navigate";
  return String(req.headers.accept || "").includes("text/html");
}

const UPDATING = {
  zh: ["正在更新，约 1 分钟", "更新完成后页面会自动进入。"],
  en: ["Updating, about 1 minute", "This page opens automatically when the update is done."],
};

/** 更新说明的标题和正文，按浏览器首选语言选中文或英文，其他语言用中文。 */
export function updatingText(req) {
  const first = String(req.headers["accept-language"] || "").split(",")[0].trim().toLowerCase();
  return first.startsWith("en") ? UPDATING.en : UPDATING.zh;
}

/** 页面以外的请求：503，并建议几秒后重试。 */
export function notReady(res, retryAfterSeconds = 3) {
  res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(retryAfterSeconds) });
  res.end(JSON.stringify({ error: "workspace_starting" }));
}

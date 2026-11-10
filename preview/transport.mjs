import http from "node:http";

const rawHeaders = (status, headers) => `HTTP/1.1 ${status}\r\n` + Object.entries(headers)
  .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}\r\n`)).join("") + "\r\n";

/** Stream HTTP bodies and SSE without buffering or an idle timeout. */
export function proxyHttp(req, res, target, headers, responseHeaders = (h) => h, responseBody = (reply) => reply) {
  const up = http.request({ ...target, path: req.url, method: req.method, headers }, (reply) => {
    clearTimeout(timer);
    const outgoing = responseHeaders(reply.headers);
    const body = responseBody(reply, outgoing);
    res.writeHead(reply.statusCode, outgoing);
    reply.on("error", () => res.destroy());
    body.on("error", () => res.destroy());
    res.on("close", () => { if (body !== reply) body.destroy(); });
    body.pipe(res);
  });
  const timer = setTimeout(() => up.destroy(new Error("Preview connection timed out")), 10000);
  up.on("error", () => {
    clearTimeout(timer);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("预览服务暂时不可用，请确认服务已经启动。");
  });
  res.on("close", () => { clearTimeout(timer); up.destroy(); });
  req.on("error", () => up.destroy());
  req.pipe(up);
}

/** Forward a WebSocket handshake and both buffered heads, then join socket lifetimes. */
export function proxyUpgrade(req, socket, head, target, headers, responseHeaders = (h) => h) {
  const up = http.request({ ...target, path: req.url, method: req.method, headers });
  const timer = setTimeout(() => up.destroy(new Error("Preview connection timed out")), 10000);
  up.on("upgrade", (reply, remote, remoteHead) => {
    clearTimeout(timer);
    socket.write(rawHeaders(`${reply.statusCode} ${reply.statusMessage}`, responseHeaders(reply.headers)));
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
    remote.on("close", () => socket.destroy());
    socket.on("close", () => remote.destroy());
    remote.pipe(socket); socket.pipe(remote);
  });
  up.on("response", (reply) => {
    clearTimeout(timer);
    socket.write(rawHeaders(`${reply.statusCode} ${reply.statusMessage}`, responseHeaders(reply.headers)));
    reply.pipe(socket);
  });
  up.on("error", () => { clearTimeout(timer); socket.destroy(); });
  socket.on("error", () => up.destroy());
  socket.on("close", () => { clearTimeout(timer); up.destroy(); });
  up.end();
}

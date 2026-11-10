import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { RELAY_PORT, previewPort, editorHeaders } from "./policy.mjs";
import { proxyHttp, proxyUpgrade } from "./transport.mjs";

/** Serve loopback editors only to the gateway IP with this container's secret. */
export function createRelay({ key, gatewayAddresses }) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Preview relay key is missing or invalid");
  const authorize = async (req) => {
    const port = previewPort(req.headers["x-zp-preview-port"]);
    const given = req.headers["x-zp-relay-key"];
    if (!port || typeof given !== "string" || given.length !== key.length
      || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return null;
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (!(await gatewayAddresses()).includes(remote)) return null;
    const headers = editorHeaders(req.headers);
    headers.host = `127.0.0.1:${port}`;
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
    return { target: { host: "127.0.0.1", port }, headers };
  };
  const server = http.createServer(async (req, res) => {
    try {
      const r = await authorize(req);
      if (!r || req.method === "CONNECT" || !req.url.startsWith("/") || req.url.startsWith("//")) {
        res.writeHead(403); return res.end();
      }
      proxyHttp(req, res, r.target, r.headers);
    } catch (error) { res.writeHead(503); res.end(); }
  });
  server.on("upgrade", async (req, socket, head) => {
    try {
      const r = await authorize(req);
      if (!r || req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket"
        || !req.url.startsWith("/") || req.url.startsWith("//")) return socket.destroy();
      proxyUpgrade(req, socket, head, r.target, r.headers);
    } catch (error) { socket.destroy(); }
  });
  return server;
}


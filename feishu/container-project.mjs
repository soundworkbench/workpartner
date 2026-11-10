import http from "node:http";
import { createProject } from "./project.mjs";

function docker(method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: "/var/run/docker.sock", method, path: route, timeout: 25000, headers: { "content-type": "application/json" } }, (res) => {
      const chunks = []; let length = 0;
      res.on("data", (c) => { length += c.length; if (length > 1024 * 1024) req.destroy(new Error("飞书项目返回过多数据")); else chunks.push(c); });
      res.on("error", reject);
      res.on("end", () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(Buffer.concat(chunks)) : reject(new Error("无法连接云端工作伙伴，请先打开工作空间")));
    });
    req.on("timeout", () => req.destroy(new Error("飞书项目请求超时")));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** Create the gateway adapter; only constant auth commands are sent to the user's own container.
 * @returns A Device Code adapter keyed by provisioned user records.
 */
export function createContainerProject({ containerPrefix = "workpartner-legacy-", nextContainerPrefix = "workpartner-next-", uid = 1001, transport = docker } = {}) {
  return createProject({ run: async (user, args) => {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(user.slug)) throw new Error("用户身份无效");
    const prefix = user.backend === "aionui" ? nextContainerPrefix : containerPrefix;
    const exec = JSON.parse(await transport("POST", `/containers/${prefix}${user.slug}/exec`, {
      User: `${uid}:${uid}`, AttachStdout: true, AttachStderr: true, Cmd: ["/usr/local/bin/meegle", ...args], Env: ["HOME=/data"],
    }));
    const buffer = await transport("POST", `/exec/${exec.Id}/start`, { Detach: false, Tty: false });
    let out = "";
    for (let i = 0; i + 8 <= buffer.length;) { const size = buffer.readUInt32BE(i + 4); if (buffer[i] === 1) out += buffer.subarray(i + 8, i + 8 + size).toString(); i += 8 + size; }
    try { return JSON.parse(out); } catch (error) { throw new Error("无法读取飞书项目结果，请检查镜像中的 CLI 安装"); }
  } });
}

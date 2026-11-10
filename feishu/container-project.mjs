import { createProject } from "./project.mjs";

/** Run fixed project authorization commands in the selected personal runtime. */
export function createContainerProject({ runtime, legacyRuntime = runtime, uid = 1001 }) {
  return createProject({ run: async (user, args) => {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(user.slug)) throw new Error("用户身份无效");
    const selected = user.backend === "aionui" ? runtime : legacyRuntime;
    const result = await selected.exec(user.slug, ["/usr/local/bin/meegle", ...args], { user: `${uid}:${uid}`, env: ["HOME=/data"], createTimeout: 25000, timeout: 25000, maxOutputBytes: 1024 * 1024 });
    try { return JSON.parse(result.stdout); } catch (error) { throw new Error("无法读取飞书项目结果，请检查镜像中的 CLI 安装"); }
  } });
}

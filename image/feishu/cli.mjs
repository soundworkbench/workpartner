#!/usr/bin/env node
// 包装器只把短期用户令牌注入真正的 CLI，不保存、打印或替调用者确认写操作。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const versions = { "lark-cli": "@larksuite/cli@1.0.99", meegle: "@lark-project/meegle@1.0.27" };

/** Resolve a real CLI excluding the company shim directory.
 * @param name CLI command name.
 * @param config Wrapper configuration; realBin supplies the image's fixed installation directory.
 * @returns An executable path or null when the CLI is not installed.
 */
export function resolveCli(name, config) {
  const directories = config.realBin ? [config.realBin] : String(process.env.PATH || "").split(path.delimiter).filter((d) => d && path.resolve(d) !== path.resolve(config.bin));
  for (const dir of directories) for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
    const candidate = path.join(dir, name + suffix);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (error) { /* 继续找下一个 PATH 位置。 */ }
  }
  return null;
}

/** Execute a company CLI with per-call user identity; help works without authorization.
 * @param name lark-cli or meegle.
 * @param args Original argv, including confirmation flags only when the user supplied them.
 * @param configFile Wrapper settings, containing paths and public settings but no long-lived OAuth credentials.
 * @returns The CLI's exit code, including the original high-risk confirmation exit 10.
 */
export async function runCli(name, args, configFile) {
  if (!Object.hasOwn(versions, name)) throw new Error("未知的公司命令");
  const config = JSON.parse(fs.readFileSync(process.env.WORKPARTNER_IDENTITY_CONFIG || configFile, "utf8"));
  const executable = resolveCli(name, config);
  if (!executable) { console.error(`尚未安装 ${name}，请先运行：npm install -g ${versions[name]}`); return 1; }
  const environment = { ...process.env };
  // CLI 不能继承环境中的应用密钥、机器人令牌或已有用户令牌来绕过公司的领取流程。
  for (const key of Object.keys(environment)) if (key.startsWith("LARKSUITE_CLI_") || key.startsWith("MEEGLE_")) delete environment[key];
  const invoke = (argv, capture = false) => new Promise((resolve, reject) => {
    // npm Windows shims route to fixed JS entries so arbitrary CLI argv never passes through cmd.exe.
    const windowsEntry = process.platform === "win32" && executable.endsWith(".cmd")
      ? path.join(path.dirname(executable), "node_modules", name === "lark-cli" ? "@larksuite/cli/scripts/run.js" : "@lark-project/meegle/bin/meegle.js") : null;
    const child = spawn(windowsEntry ? config.execPath : executable, windowsEntry ? [windowsEntry, ...argv] : argv, { env: { ...environment, ...(windowsEntry ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let out = "";
    if (capture) { child.stdout.on("data", (c) => { out += c; }); child.stderr.resume(); }
    child.once("error", () => reject(new Error(`无法启动 ${name}，请检查安装`)));
    child.once("close", (code) => resolve(capture ? { code, text: out } : code ?? 1));
  });
  if (name === "lark-cli") {
    environment.LARKSUITE_CLI_STRICT_MODE = "user";
    environment.LARKSUITE_CLI_DEFAULT_AS = "user";
    environment.LARKSUITE_CLI_BRAND = "feishu";
    const help = args.includes("--help") || args.includes("-h") || args[0] === "version";
    if (help) return invoke(args);
    const identity = config.kind === "container" ? fs.readFileSync(config.identityFile, "utf8").trim() : JSON.parse(fs.readFileSync(config.identityFile, "utf8")).token;
    const response = await fetch(config.tokenUrl, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${identity}` }, signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok) { console.error(`${result.message || "需要授权飞书"}\n${result.authorization_url || config.authorizationUrl}`); return 1; }
    if (args[0] === "auth") {
      if (args[1] === "status") { console.log(JSON.stringify({ authorized: true, identity: "user" })); return 0; }
      console.error(`请在飞书授权页面连接或断开：${config.authorizationUrl}`); return 1;
    }
    if (args[0] === "config") { console.error("公司飞书命令只使用本人身份，请在飞书授权页面管理连接"); return 1; }
    if (typeof result.user_access_token !== "string" || !result.user_access_token || typeof result.app_id !== "string" || !result.app_id || !Number.isFinite(result.expires_at) || result.expires_at <= Date.now() / 1000) throw new Error("网关没有返回有效的飞书短期授权");
    environment.LARKSUITE_CLI_APP_ID = result.app_id;
    environment.LARKSUITE_CLI_USER_ACCESS_TOKEN = result.user_access_token;
    return invoke(args);
  }
  environment.MEEGLE_HOST = config.meegleHost;
  environment.MEEGLE_NO_UPDATE_CHECK = "1";
  environment.MEEGLE_TELEMETRY = "disabled";
  if (!config.meegleHost) { console.error("尚未配置飞书项目地址，请联系管理员"); return 1; }
  const localCommand = !args.length || ["auth", "version", "config", "inspect", "completion", "telemetry"].includes(args[0]) || args.includes("--help") || args.includes("-h");
  if (!localCommand) {
    const check = await invoke(["auth", "status", "--format", "json"], true);
    let status;
    try { status = JSON.parse(check.text); } catch (error) { console.error("无法核实飞书项目授权，请稍后重试"); return 1; }
    if (!status.authenticated) {
      console.error(status.reason === "no local token" || status.reason === "token rejected by server" ? "需要授权飞书项目。请运行：meegle auth login --device-code" : "暂时无法核实飞书项目授权，请稍后重试");
      return 1;
    }
  }
  return invoke(args);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [name, config, ...args] = process.argv.slice(2);
  try { process.exitCode = await runCli(name, args, config); }
  catch (error) { console.error("飞书命令暂时不可用，请检查安装、登录和网络后重试"); process.exitCode = 1; }
}

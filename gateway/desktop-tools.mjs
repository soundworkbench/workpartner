import fs from 'node:fs';
import path from 'node:path';

export const desktopTools = JSON.parse(fs.readFileSync(new URL('./desktop-tools.json', import.meta.url), 'utf8'));
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const errors = {
  UNAUTHORIZED: '认证凭据无效或已过期。',
  TOKEN_REVOKED: '桌面登录凭据已被撤销，请重新登录。',
  DESKTOP_NOT_ADMITTED: '当前账号尚未开通桌面端本地助手权限。',
  PROTOCOL_VERSION_UNSUPPORTED: '桌面客户端协议版本不兼容，请升级到最新版本。',
  DEVICE_LIMIT_EXCEEDED: '当前账号同时在线桌面设备数已达上限（5 台）。',
  DEVICE_OFFLINE: '桌面客户端当前未连接，请提醒用户打开桌面端确认已连接后再试，不要循环自动重试。',
  DEVICE_NOT_FOUND: '指定的 device_id 不在线或不存在。',
  DEVICE_DISCONNECTED: '执行中途桌面端断开连接，请确认桌面端重连后再试。',
  NO_ALLOWED_ROOTS: '桌面端尚未配置任何授权目录，请在桌面端设置中添加允许访问的文件夹。',
  PATH_NOT_ALLOWED: '目标路径不在已授权的目录白名单内（或符号链接指向白名单之外）。',
  SENSITIVE_PATH_BLOCKED: '目标命中敏感文件或系统目录保护规则，禁止访问。',
  PATH_NOT_FOUND: '白名单内的目标路径不存在。',
  NOT_A_DIRECTORY: '目标路径不是目录。',
  NOT_A_REGULAR_FILE: '目标路径不是普通文件，无法读取。',
  BINARY_FILE_UNSUPPORTED: '目标文件为二进制格式，阶段 2 仅支持读取 UTF-8 文本文件。',
  FILE_TOO_LARGE: '目标文件超过单文件读取大小上限（20 MiB）。',
  PAYLOAD_TOO_LARGE: '请求或响应数据超过单次传输上限，请缩小读取范围或行数。',
  INVALID_PARAMS: '参数缺失、类型无效或超出允许范围。',
  TOOL_NOT_SUPPORTED: '当前设备或协议阶段不支持该工具，请升级桌面端。',
  TOOL_TIMEOUT: '等待本机响应超时（已自动取消），请缩小范围或稍后重试。',
  CONCURRENCY_LIMIT_EXCEEDED: '本机并发请求数已达上限，请等待当前操作完成后再试。',
  INTERNAL_ERROR: '执行过程中发生内部错误（不回传敏感详情）。',
};
export function failure(code, details) {
  if (!Object.hasOwn(errors, code)) code = 'INTERNAL_ERROR';
  return { isError: true, content: [{ type: 'text', text: `[${code}] ${errors[code]}` },
    ...(details ? [{ type: 'text', text: JSON.stringify(details) }] : [])] };
}
export const success = data => ({ isError: false, content: [{ type: 'text', text: JSON.stringify(data) }] });
export function validArguments(schema, args) {
  if (!object(args) || (schema.required || []).some(key => !Object.hasOwn(args, key))) return false;
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!Object.hasOwn(schema.properties, key)) return false;
    if (rule.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== rule.type) return false;
    if (rule.enum && !rule.enum.includes(value)) return false;
    if (typeof value === 'string' && (value.length < (rule.minLength || 0) || value.length > (rule.maxLength || Infinity))) return false;
    if (typeof value === 'number' && (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) return false;
  }
  return args.end_line === undefined || args.end_line >= (args.start_line ?? 1);
}

/** Lexical checks only. The desktop owns realpath, filesystem access and final authorization. */
export function precheck(target, roots, platform) {
  if (!roots.length) return 'NO_ALLOWED_ROOTS';
  if (target === undefined) return null;
  const win = platform === 'win32', paths = win ? path.win32 : path.posix;
  if (target.includes('\0') || (win ? !/^[a-z]:[\\/]/i.test(target) : !paths.isAbsolute(target))) return 'PATH_NOT_ALLOWED';
  const normalized = paths.normalize(target), slash = normalized.replaceAll('\\', '/').toLowerCase();
  const segments = target.replaceAll('\\', '/').toLowerCase().split('/');
  if (segments.some(part => part.startsWith('.env') || ['.ssh', '.aws', '.gnupg', '.kube', '.git-credentials', '.npmrc', '.pypirc', '.netrc'].includes(part)
      || /\.(pem|key|p12|pfx|jks|kdbx)$/.test(part))
    || /(?:^|\/)\.docker\/config\.json(?:\/|$)/.test(slash)
    || /^(?:\/system|\/library|\/etc|\/private\/(?:etc|var)|\/proc|\/sys|\/dev|[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata))(?:\/|$)/.test(slash)
    || /\/(?:\.config\/(?:google-chrome|chromium|microsoft-edge|bravesoftware)|\.mozilla\/firefox)(?:\/|$)/.test(slash)
    || /\/(?:library\/(?:keychains|cookies|safari|application support\/(?:google\/chrome|chromium|microsoft edge|bravesoftware|firefox))|appdata\/(?:local\/(?:google\/chrome\/user data|microsoft\/edge\/user data)|roaming\/mozilla\/firefox))(?:\/|$)/.test(slash)) return 'SENSITIVE_PATH_BLOCKED';
  const inside = roots.some(root => {
    if (!paths.isAbsolute(root)) return false;
    const rel = paths.relative(win ? root.toLowerCase() : root, win ? normalized.toLowerCase() : normalized);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + paths.sep) && !paths.isAbsolute(rel));
  });
  return inside ? null : 'PATH_NOT_ALLOWED';
}

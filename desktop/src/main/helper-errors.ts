const messages = {
  NO_ALLOWED_ROOTS: '尚未配置授权目录，请在桌面端添加文件夹。',
  PATH_NOT_ALLOWED: '目标路径不在已授权的目录内。',
  SENSITIVE_PATH_BLOCKED: '目标命中敏感文件或系统目录保护规则。',
  PATH_NOT_FOUND: '授权目录内的目标路径不存在。',
  NOT_A_DIRECTORY: '目标路径不是目录。',
  NOT_A_REGULAR_FILE: '只能读取普通文件。',
  BINARY_FILE_UNSUPPORTED: '仅支持读取 UTF-8 文本文件。',
  FILE_TOO_LARGE: '文件大小超过 20 MiB 上限。',
  PAYLOAD_TOO_LARGE: '数据超过单次传输上限，请缩小读取范围。',
  INVALID_PARAMS: '参数缺失、类型无效或超出允许范围。',
  TOOL_NOT_SUPPORTED: '此设备不支持该工具。',
  TOOL_TIMEOUT: '本机响应超时，请缩小范围后重试。',
  CONCURRENCY_LIMIT_EXCEEDED: '本机并发请求已达上限。',
  INTERNAL_ERROR: '执行过程中发生内部错误。'
};
export type ErrorCode = keyof typeof messages;
export class ToolError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); }
}
export function fail(code: ErrorCode): never { throw new ToolError(code); }
export function wireError(code: ErrorCode) {
  return { code, message: messages[code], retryable: ['TOOL_TIMEOUT', 'CONCURRENCY_LIMIT_EXCEEDED', 'INTERNAL_ERROR'].includes(code) };
}
export function errorCode(e: unknown): ErrorCode {
  if (e instanceof ToolError) return e.code;
  switch ((e as NodeJS.ErrnoException)?.code) {
    case 'ENOTDIR': return 'NOT_A_DIRECTORY';
    case 'ENOENT': return 'PATH_NOT_FOUND';
    case 'EPERM': case 'EACCES': case 'ELOOP': return 'PATH_NOT_ALLOWED';
    default: return 'INTERNAL_ERROR';
  }
}

import { createRequire } from 'node:module';
import { win32 } from 'node:path';
import { fail } from './helper-errors.js';

// libuv lstat recognizes junctions and symlinks, but other reparse tags can look
// like ordinary files. Read the Windows attribute directly and fail closed.
type Handle = number | bigint;
type Kernel = {
  attributes(path: string): number;
  open(path: string, access: number, share: number, security: null, disposition: number, flags: number, template: number): Handle;
  info(handle: Handle, kind: number, buffer: Buffer, size: number): number;
  close(handle: Handle): number;
};
function loadApi(): Kernel {
  const kernel = createRequire(import.meta.url)('koffi').load('kernel32.dll');
  return {
    attributes: kernel.func('uint32_t __stdcall GetFileAttributesW(str16 path)'),
    open: kernel.func('intptr_t __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, intptr_t templateFile)'),
    info: kernel.func('int __stdcall GetFileInformationByHandleEx(intptr_t file, int kind, _Out_ void *buffer, uint32_t size)'),
    close: kernel.func('int __stdcall CloseHandle(intptr_t file)')
  };
}
let api: Kernel | undefined;
const extended = (path: string) => '\\\\?\\' + path;
function requirePlainAttributes(attributes: number) {
  // INVALID_FILE_ATTRIBUTES (0xffffffff) also fails this check.
  if (attributes & 0x400) fail('PATH_NOT_ALLOWED');
}

export function checkWindowsAttributes(path: string) {
  if (process.platform !== 'win32') return;
  api ??= loadApi();
  requirePlainAttributes(api.attributes(extended(path)));
}

export function pinWindowsPath(path: string, kernel = api ??= loadApi()) {
  const handles: Handle[] = [];
  function close() { for (const handle of handles.reverse()) kernel.close(handle); }
  try {
    let current = win32.parse(path).root;
    for (const name of ['', ...path.slice(current.length).split('\\').filter(Boolean)]) {
      current = win32.join(current, name);
      // FILE_READ_ATTRIBUTES, FILE_SHARE_READ, OPEN_EXISTING,
      // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
      const handle = kernel.open(extended(current), 0x80, 1, null, 3, 0x02200000, 0);
      if (BigInt(handle) === -1n) fail('PATH_NOT_ALLOWED');
      handles.push(handle);
      const info = Buffer.alloc(8); // FILE_ATTRIBUTE_TAG_INFO
      if (!kernel.info(handle, 9, info, info.length)) fail('PATH_NOT_ALLOWED');
      requirePlainAttributes(info.readUInt32LE());
    }
    return close;
  } catch (e) { close(); throw e; }
}

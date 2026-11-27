import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCode } from './helper-errors.js';

const known = ['desktop_list_dir','desktop_read_file','desktop_search_files'];
const policyDenials = ['NO_ALLOWED_ROOTS','PATH_NOT_ALLOWED','SENSITIVE_PATH_BLOCKED','NOT_A_DIRECTORY',
  'NOT_A_REGULAR_FILE','BINARY_FILE_UNSUPPORTED','FILE_TOO_LARGE','INVALID_PARAMS','TOOL_NOT_SUPPORTED'];
type Event = { reqId: string; tool: string; args: Record<string, unknown>; code?: ErrorCode;
  durationMs: number; returnedBytes: number; truncated: boolean };
export function createAudit(userData: string, now = Date.now) {
  const dir = join(userData, 'logs');
  let lastDay = '';
  return (event: Event) => {
    const ts = new Date(now()).toISOString(), day = ts.slice(0, 10);
    mkdirSync(dir, { mode: 0o700, recursive: true });
    if (lastDay !== day) {
      const oldest = new Date(now() - 29 * 86400000).toISOString().slice(0,10);
      for (const file of readdirSync(dir)) {
        const match = /^audit-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(file);
        if (match && match[1] < oldest) rmSync(join(dir, file), { force: true });
      }
      lastDay = day;
    }
    const argsSummary: Record<string, number | boolean> = {};
    for (const key of ['start_line','end_line','max_bytes','max_results','max_depth','limit','case_sensitive','include_hidden']) {
      const v = event.args[key];
      if ((typeof v === 'number' && Number.isSafeInteger(v)) || typeof v === 'boolean') argsSummary[key] = v;
    }
    // Paths and free-form strings may themselves contain credentials. Only persist bounded metadata.
    const line = JSON.stringify({ ts, reqId: /^req_[a-f0-9-]{1,64}$/i.test(event.reqId) ? event.reqId : null,
      tool: known.includes(event.tool) ? event.tool : null, argsSummary,
      decision: event.code && policyDenials.includes(event.code) ? 'policy_deny' : 'auto_allow',
      ok: !event.code, errorCode: event.code || null, durationMs: event.durationMs,
      returnedBytes: event.returnedBytes, truncated: event.truncated }) + '\n';
    const fd = openSync(join(dir, 'audit-' + day + '.jsonl'), constants.O_APPEND | constants.O_WRONLY |
      constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
    try { if (fstatSync(fd).size + Buffer.byteLength(line) <= 50 * 1024 * 1024) writeSync(fd, line); }
    finally { closeSync(fd); }
  };
}

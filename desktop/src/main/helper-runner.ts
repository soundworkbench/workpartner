import { Worker } from 'node:worker_threads';
import { fail, ToolError, type ErrorCode } from './helper-errors.js';
import type { SearchProgress, ToolData } from './helper-tools.js';

export type Job = { name: string; args: Record<string, unknown>; roots: string[]; userData: string; timeout: number };
export type RunTool = (job: Job, signal: AbortSignal) => Promise<ToolData>;

// Blocking filesystem calls run off the main thread, so even a stalled mount cannot stall heartbeats or cancellation.
export function createToolRunner(): RunTool {
  let workers = 0;
  return (job, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    if (workers >= 4) fail('CONCURRENCY_LIMIT_EXCEEDED');
    const deadline = Date.now() + job.timeout;
    const scanCount = new Int32Array(new SharedArrayBuffer(4));
    const entry = new URL('./helper-worker.js', import.meta.url);
    // Node workers load their entry directly from disk in packaged Electron builds.
    entry.pathname = entry.pathname.replace(/\/app\.asar\/(dist(?:-test)?\/main\/helper-worker\.js)$/, '/app.asar.unpacked/$1');
    const worker = new Worker(entry, { workerData: { ...job, deadline, scanCount } });
    workers++;
    const matches: SearchProgress['match'][] = [];
    let latest: SearchProgress | undefined, finished = false;
    function finish() {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      void worker.terminate();
      return true;
    }
    function cancel() { if (finish()) reject(new ToolError('TOOL_TIMEOUT')); }
    const timer = setTimeout(() => {
      if (!finish()) return;
      if (latest) resolve({ mode: latest.mode, matches, scanned_files: Atomics.load(scanCount, 0), truncated: true, timed_out: true });
      else reject(new ToolError('TOOL_TIMEOUT'));
    }, Math.max(0, deadline - Date.now()));
    signal.addEventListener('abort', cancel, { once: true });
    worker.on('message', (message: { progress?: SearchProgress; error?: ErrorCode; data?: ToolData }) => {
      if (finished) return;
      if (message.progress) { latest = message.progress; matches.push(latest.match); return; }
      finish();
      if (message.data) resolve(message.data);
      else reject(new ToolError(message.error || 'INTERNAL_ERROR'));
    });
    worker.on('error', () => { if (finish()) reject(new ToolError('INTERNAL_ERROR')); });
    worker.once('exit', () => {
      workers--;
      if (finish()) reject(new ToolError('INTERNAL_ERROR'));
    });
  });
}

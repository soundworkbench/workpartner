import { threadId, workerData } from 'node:worker_threads';
import { fail } from './helper-errors.js';

// Four depth-eight searches can hold eight directory pins, eight iterators and
// a file each. Windows also pins the drive-to-grant prefix.
export const handleLimit = process.platform === 'win32' ? 128 : 72;
export const handleSlots: Int32Array = workerData?.handleSlots ?? new Int32Array(new SharedArrayBuffer(handleLimit * 4));

export function holdHandle<T>(open: () => T, close: (value: T) => void) {
  const owner = threadId + 1;
  for (let i = 0; i < handleSlots.length; i++) {
    if (Atomics.compareExchange(handleSlots, i, 0, owner) !== 0) continue;
    try {
      const value = open();
      return { value, close() {
        try { close(value); } finally { Atomics.store(handleSlots, i, 0); }
      } };
    } catch (error) { Atomics.store(handleSlots, i, 0); throw error; }
  }
  fail('LIMIT_EXCEEDED');
}

// A terminated worker can exit before its JavaScript finally blocks run.
export function releaseWorkerSlots(id: number) {
  for (let i = 0; i < handleSlots.length; i++) Atomics.compareExchange(handleSlots, i, id + 1, 0);
}

import { parentPort, workerData } from 'node:worker_threads';
import { executeTool } from './helper-tools.js';
import { errorCode } from './helper-errors.js';

const { name, args, roots, userData, deadline, scanCount, cancelFlag } = workerData;
try {
  const data = executeTool(name, args, roots, userData, deadline, progress => parentPort!.postMessage({ progress }), scanCount, cancelFlag);
  parentPort!.postMessage({ data });
} catch (e) { parentPort!.postMessage({ error: errorCode(e) }); }

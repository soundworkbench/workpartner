import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['/opt/e2e/cc-child.mjs'], { stdio: 'ignore' });
process.on('SIGTERM', () => { child.kill(); process.exit(0); });
setInterval(() => {}, 1000);

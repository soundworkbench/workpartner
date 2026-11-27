import { copyFileSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const output = process.argv[2];
copyFileSync('src/main/offline.html', join(output, 'main/offline.html'));
cpSync('src/settings', join(output, 'settings'), { recursive: true });
if (output === 'dist-test') writeFileSync(join(output, 'main/build-mode.js'), 'export const testMode = true;');

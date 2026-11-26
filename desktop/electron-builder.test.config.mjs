import { copyFileSync } from 'node:fs';
import release from './electron-builder.config.mjs';

export default {
  ...release,
  appId: release.appId + '.smoke',
  productName: release.productName + ' Smoke',
  extraMetadata: { main: 'dist-test/preview-smoke.mjs', productName: release.productName + ' Smoke' },
  directories: { output: process.env.WP_DESKTOP_OUTPUT || 'release-test' },
  beforePack() {
    copyFileSync('tests/preview-smoke.mjs', 'dist-test/preview-smoke.mjs');
    copyFileSync('../preview/client.mjs', 'dist-test/preview-client.mjs');
  },
  files: release.files.map(pattern => pattern === 'dist/**' ? 'dist-test/**' : pattern),
  protocols: [],
  mac: { ...release.mac, extendInfo: { ...release.mac.extendInfo, LSBackgroundOnly: true } }
};

import release from './electron-builder.config.mjs';

export default {
  ...release,
  appId: release.appId + '.smoke',
  productName: release.productName + ' Smoke',
  extraMetadata: { main: 'dist-test/main/index.js', productName: release.productName + ' Smoke' },
  directories: { output: process.env.WP_DESKTOP_OUTPUT || 'release-test' },
  files: release.files.map(pattern => pattern === 'dist/**' ? 'dist-test/**' : pattern),
  protocols: [],
  mac: { ...release.mac, extendInfo: { ...release.mac.extendInfo, LSBackgroundOnly: true } }
};

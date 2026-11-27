import { readFileSync, existsSync } from 'node:fs';
const brand = JSON.parse(readFileSync(new URL('./brand/default/brand.json', import.meta.url)));
const resource = name => {
  const path = 'brand/default/resources/' + name;
  return existsSync(path) ? path : undefined;
};
export default {
  appId: brand.appId, productName: brand.productName, extraMetadata: { productName: brand.productName },
  directories: { output: process.env.WP_DESKTOP_OUTPUT || 'release' },
  files: ['THIRD-PARTY-NOTICES.txt', 'dist/**', 'brand/default/brand.json', 'brand/default/resources/tray-windows.ico'],
  asarUnpack: ['dist*/main/{helper-worker,helper-tools,helper-paths,helper-errors}.js'],
  protocols: [{ name: brand.displayName, schemes: [brand.protocol] }],
  toolsets: { nsis: '1.2.1' },
  npmRebuild: false, electronLanguages: ['en-US', 'zh-CN'],
  mac: { target: 'dmg', identity: '-', icon: resource('icon.icns'),
    extendInfo: { CFBundleDisplayName: brand.displayName, NSMicrophoneUsageDescription: '语音输入需要使用麦克风。' } },
  dmg: { sign: false },
  win: { target: 'nsis', icon: resource('icon-windows.ico') },
  nsis: { installerLanguages: ['zh_CN'], language: '2052', oneClick: false, allowToChangeInstallationDirectory: true },
  publish: null
};

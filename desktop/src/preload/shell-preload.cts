const { contextBridge } = require('electron') as typeof import('electron');
const version = process.argv.find(arg => arg.startsWith('--wp-version='))?.slice('--wp-version='.length);
if (process.isMainFrame) contextBridge.exposeInMainWorld('__WP_DESKTOP__', { version, platform: process.platform });

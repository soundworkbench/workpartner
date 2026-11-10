/** Copy the selected organization's complete skin into a disposable build directory. */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { organizationData } from './resolve.mjs';

// Resolve each entry before copying: the Docker context cannot refer back to the checkout.
function copyAssets(source, destination) {
  const file = realpathSync(source);
  if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(destination);
  if (statSync(file).isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(file)) copyAssets(join(file, name), join(destination, name));
  } else copyFileSync(file, destination);
}

export function materializeAppearance(destination, data = organizationData()) {
  const { appearance, productName } = data;
  if (![appearance.themeColor, appearance.avatarColor].every(color => /^#[a-f\d]{6}$/i.test(color))) throw new Error('Invalid appearance.themeColor');
  const copy = appearance.copy;
  for (const name of ['footerTitle', 'footerSubtitle', 'taglineEn', 'homeExample', 'manifestDescription', 'tableFile', 'appearanceName', 'streamingComment']) {
    if (typeof copy[name] !== 'string') throw new Error(`Missing appearance.copy.${name}`);
  }
  const source = resolve(data.directory, appearance.brandDirectory);
  // Dereference organization-owned symlinks: the assembled context must stand on its own.
  mkdirSync(destination, { recursive: true });
  copyAssets(source, destination);
  let table = readFileSync(resolve(source, copy.tableFile), 'utf8');
  for (const [locale, name] of [['zh-CN', productName.zh], ['en-US', productName.en]]) {
    if (typeof name !== 'string' || !name) throw new Error('Invalid productName');
    // Preserve the selected source bytes if no replacement is needed.
    const pattern = new RegExp("('" + locale + "':[^\\n]*?brand: )'([^']*)'");
    table = table.replace(pattern, (whole, prefix, current) => current === name ? whole : prefix + JSON.stringify(name));
  }
  writeFileSync(join(destination, 'copy.js'), table);
  for (const file of ['icon-512.png', 'icon-192.png', 'apple-touch-icon.png', 'favicon.svg', 'agents/chatgpt.svg', 'agents/claude.svg', 'wp-pet.js', 'wp-pet.css']) {
    readFileSync(join(destination, file));
  }
  writeFileSync(join(destination, 'skin.json'), JSON.stringify({ productName, copy, themeColor: appearance.themeColor, avatarColor: appearance.avatarColor, bridgeEnabled: Boolean(data.bridge.template) }, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) materializeAppearance(resolve(process.argv[2]));

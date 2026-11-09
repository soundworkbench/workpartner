/** Copy the selected organization's complete skin into a disposable build directory. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { organizationData } from './resolve.mjs';

export function materializeAppearance(destination, data = organizationData()) {
  const { appearance, productName } = data;
  if (![appearance.themeColor, appearance.avatarColor].every(color => /^#[a-f\d]{6}$/i.test(color))) throw new Error('Invalid appearance.themeColor');
  const copy = appearance.copy;
  for (const name of ['footerTitle', 'footerSubtitle', 'taglineEn', 'homeExample', 'manifestDescription', 'tableFile', 'appearanceName', 'streamingComment', 'modelCatalogFile']) {
    if (typeof copy[name] !== 'string') throw new Error(`Missing appearance.copy.${name}`);
  }
  const source = resolve(data.directory, appearance.brandDirectory);
  // Dereference organization-owned symlinks: the assembled context must stand on its own.
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
  let table = readFileSync(resolve(source, copy.tableFile), 'utf8');
  for (const [locale, name] of [['zh-CN', productName.zh], ['en-US', productName.en]]) {
    if (typeof name !== 'string' || !name) throw new Error('Invalid productName');
    // Preserve the selected source bytes if no replacement is needed.
    const pattern = new RegExp("('" + locale + "':[^\\n]*?brand: )'([^']*)'");
    table = table.replace(pattern, (whole, prefix, current) => current === name ? whole : prefix + JSON.stringify(name));
  }
  writeFileSync(join(destination, 'copy.js'), table);
  let catalog = readFileSync(resolve(source, copy.modelCatalogFile), 'utf8');
  for (const [slot, value] of Object.entries({ __CODEX_MODEL__: data.model.defaults.codex, __CLAUDE_MODEL__: data.model.defaults.claude })) {
    // These slots occur in single-quoted JS literals. Encode quotes and line separators as well.
    const literal = JSON.stringify(value).slice(1, -1).replaceAll("'", '\\u0027');
    catalog = catalog.replaceAll(slot, literal);
  }
  writeFileSync(join(destination, 'models.js'), catalog);
  for (const file of ['icon-512.png', 'icon-192.png', 'apple-touch-icon.png', 'favicon.svg', 'agents/chatgpt.svg', 'agents/claude.svg', 'wp-pet.js', 'wp-pet.css']) {
    readFileSync(join(destination, file));
  }
  writeFileSync(join(destination, 'skin.json'), JSON.stringify({ productName, copy, themeColor: appearance.themeColor, avatarColor: appearance.avatarColor, bridgeEnabled: Boolean(data.bridge.template) }, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) materializeAppearance(resolve(process.argv[2]));

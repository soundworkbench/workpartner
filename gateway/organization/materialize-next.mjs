/** Prepare organization-owned image inputs in a disposable build context. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { organizationData } from './resolve.mjs';
import { materializeAppearance } from './materialize-appearance.mjs';

/** Copy local organization assets and render only pristine image templates. */
export function materializeNext(context, environment = process.env) {
  const data = organizationData(environment);
  mkdirSync(join(context, 'organization'), { recursive: true });
  const skillsArchive = join(context, 'organization/official-skills.tar.gz');
  if (data.image.officialSkillsArchive) cpSync(environment.WORKPARTNER_OFFICIAL_SKILLS_ARCHIVE || resolve(data.directory, data.image.officialSkillsArchive), skillsArchive);
  else {
    rmSync(skillsArchive, { force: true });
  }
  if (!data.bridge.template) rmSync(join(context, 'image/bin/feishu-onboard.py'), { force: true });
  const home = join(context, 'image/home');
  const selected = join(context, 'organization/selected');
  mkdirSync(selected, { recursive: true });
  for (const name of ['resolve.mjs', 'default.json']) cpSync(new URL(name, import.meta.url), join(context, 'organization', name));
  const { directory, ...release } = data;
  writeFileSync(join(selected, 'organization.json'), JSON.stringify(release, null, 2) + '\n');
  if (data.image.homeDirectory) cpSync(resolve(data.directory, data.image.homeDirectory), home, { recursive: true });
  if (data.image.instructions) cpSync(resolve(data.directory, data.image.instructions), join(home, 'CLAUDE.md'));
  if (data.bridge.template) cpSync(resolve(data.directory, data.bridge.template), join(home, 'cc-connect-feishu.toml'));
  else rmSync(join(home, 'cc-connect-feishu.toml'), { force: true });
  const baseTranslations = JSON.parse(readFileSync(new URL('../../image/skills-zh.json', import.meta.url), 'utf8'));
  const translations = data.image.skillTranslations ? JSON.parse(readFileSync(resolve(data.directory, data.image.skillTranslations), 'utf8')) : {};
  writeFileSync(join(context, 'image/skills-zh.json'), JSON.stringify({ ...baseTranslations, ...translations }, null, 2) + '\n');
  // Historical instruction bytes belong to the organization that shipped them.
  const history = data.image.legacyInstructions ? readFileSync(resolve(data.directory, data.image.legacyInstructions), 'utf8') : '[]\n';
  writeFileSync(join(context, 'image/bin/legacy-instructions.json'), history);
  const slots = { __CODEX_MODEL__: data.model.defaults.codex, __CLAUDE_MODEL__: data.model.defaults.claude,
    __EFFORT__: data.model.defaults.effort, __MODEL_KEY_ENV__: data.model.keyEnvironment };
  for (const name of ['codex-config.toml', 'claude-settings.json', 'cc-connect-feishu.toml']) {
    const file = join(home, name);
    if (!existsSync(file)) continue;
    let text = readFileSync(file, 'utf8');
    for (const [slot, value] of Object.entries(slots)) text = text.replaceAll(slot, JSON.stringify(value).slice(1, -1));
    writeFileSync(file, text);
  }
  materializeAppearance(join(context, 'brand'), data);
  return data;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  materializeNext(resolve(process.argv[2]));
}

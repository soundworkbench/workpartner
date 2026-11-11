import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Debian 的 node-js-yaml 包；构建时使用安全数据模式，不执行 YAML 自定义类型。
const { load, JSON_SCHEMA } = createRequire(import.meta.url)('/usr/share/nodejs/js-yaml');
const [skills, translations, template] = process.argv.slice(2);
const begin = '<!-- workpartner:skills:begin -->';
const end = '<!-- workpartner:skills:end -->';

function singleLine(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

const zh = JSON.parse(readFileSync(translations, 'utf8'));
const lines = [];
const groupFile = join(skills, '.wp-feishu-skills.json');
const feishu = new Set(existsSync(groupFile) ? JSON.parse(readFileSync(groupFile, 'utf8')) : []);
for (const entry of readdirSync(skills, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
  if (!entry.isDirectory() || (feishu.has(entry.name) && entry.name !== "feishu")) continue;
  const file = join(skills, entry.name, 'SKILL.md');
  if (!existsSync(file)) continue;
  const source = readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!frontmatter) throw new Error(`${file}: 缺少技能 frontmatter`);
  const meta = load(frontmatter[1], { schema: JSON_SCHEMA });
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim()
      || typeof meta.description !== 'string' || !meta.description.trim()) {
    throw new Error(`${file}: 技能 name 和 description 必须是非空文字`);
  }
  const translated = Object.hasOwn(zh, meta.name) ? zh[meta.name] : null;
  const name = translated?.name ?? meta.name;
  const description = translated?.description ?? meta.description;
  const example = translated?.example ?? `请用「${meta.name}」帮我完成任务`;
  if ([name, description, example].some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${meta.name}: 中文对照必须是非空文字`);
  }
  lines.push(name === meta.name ? singleLine(name) : `${singleLine(name)}（${singleLine(meta.name)}）`);
}
const catalog = [
  '### 你能做的事',
  '',
  '被问到能做什么时，按可用技能说明回答，不编造能力；技能名称不代表工具权限。以下是预装技能的显示名称：',
  '',
  lines.length ? lines.join('、') : '当前镜像没有预装技能。',
].join('\n');

const source = readFileSync(template, 'utf8');
const start = source.indexOf(begin);
const stop = source.indexOf(end);
const companyStart = source.indexOf('<!-- workpartner:company-instructions:begin -->');
const companyEnd = source.indexOf('<!-- workpartner:company-instructions:end -->');
if (source.split(begin).length !== 2 || source.split(end).length !== 2
    || companyStart < 0 || start <= companyStart || stop <= start || companyEnd <= stop) {
  throw new Error('技能清单必须在公司统一说明块内，且起止标记各一份、顺序正确');
}
const updated = `${source.slice(0, start + begin.length)}\n${catalog}\n${source.slice(stop)}`;
writeFileSync(template, updated);
const catalogBytes = Buffer.byteLength(catalog);
console.log(`技能 ${lines.length} 项；清单 ${catalogBytes} 字节；说明文件 ${Buffer.byteLength(updated)} 字节（UTF-8）`);
if (catalogBytes > 1536) console.warn('技能清单超过 1.5 KiB 目标，请精简中文对照；保留全部真实技能及原文兜底。');

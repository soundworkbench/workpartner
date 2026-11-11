/** Organization-owned data capabilities shared by the gateway, image skills and market. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** A named HTTPS link shown as a skill's source. */
export const sourceLink = value => object(value) && typeof value.name === 'string' && value.name.trim().length > 0
  && value.name.length <= 80 && typeof value.url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(value.url);

/** Parse a capability file, rejecting ambiguous commands and incomplete request policies. */
export function parseDataTools(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.tools)) throw new Error('Invalid data tools catalog');
  if (!Array.isArray(value.categories) || value.categories.some(row => !row.en || !row.zh)
    || new Set(value.categories.map(row => row.en)).size !== value.categories.length
    || !Array.isArray(value.platforms) || !object(value.directory)
    || !['platformsPath', 'platformPath', 'endpointPath', 'searchPath'].every(key => value.directory[key]?.startsWith('/'))
    || !Array.isArray(value.directory.blockedEndpoints) || !Array.isArray(value.directory.blockedProviders)) throw new Error('Invalid data category policy');
  if (value.presentation !== undefined && (!object(value.presentation)
    || !['tasks', 'endpoints'].every(key => object(value.presentation[key]) && Object.values(value.presentation[key]).every(row => object(row) && typeof row.title === 'string' && row.title.trim() && typeof row.description === 'string' && row.description.trim())))) throw new Error('Invalid data presentation copy');
  if (value.attribution !== undefined && !sourceLink(value.attribution)) throw new Error('Invalid data attribution');
  const ids = new Set(), commands = new Set(), names = new Set();
  for (const tool of value.tools) {
    if (!/^[a-z][a-z0-9-]+$/.test(tool.name) || names.has(tool.name) || !tool.title?.zh || !tool.title?.en
      || !tool.description?.zh || !tool.description?.en || !tool.example?.zh || !tool.example?.en
      || !Array.isArray(tool.endpoints) || !tool.endpoints.length) throw new Error('Invalid data capability');
    names.add(tool.name);
    for (const ep of tool.endpoints) {
      if (typeof ep.id !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(ep.id) || ids.has(ep.id)
        || !/^[a-z][a-z0-9-]+$/.test(ep.command) || commands.has(ep.command)
        || !['GET', 'POST'].includes(ep.method) || !ep.category?.en || !ep.category?.zh
        || !ep.platform?.en || !ep.platform?.zh || !object(ep.parameters) || !object(ep.template)
        || (ep.title !== undefined && (!object(ep.title) || typeof ep.title.zh !== 'string' || !ep.title.zh.trim() || typeof ep.title.en !== 'string' || !ep.title.en.trim()))
        || (ep.example !== undefined && (!ep.example?.zh || !ep.example?.en))
        || !object(ep.rules) || (ep.routeMaxUsd !== undefined && !(ep.routeMaxUsd > 0 && ep.routeMaxUsd <= 1))) {
        throw new Error('Invalid data endpoint policy');
      }
      ids.add(ep.id); commands.add(ep.command);
      for (const rule of Object.values(ep.parameters)) {
        if (!object(rule) || !['query', 'body'].includes(rule.in) || typeof rule.type !== 'string' || typeof rule.required !== 'boolean') throw new Error('Invalid data parameter policy');
      }
      if (ep.defaults !== undefined && (!object(ep.defaults) || Object.keys(ep.defaults).some(key => !Object.hasOwn(ep.parameters, key)))) throw new Error('Invalid data defaults');
      if (ep.timeoutMs !== undefined && (!Number.isSafeInteger(ep.timeoutMs) || ep.timeoutMs < 1000 || ep.timeoutMs > 600000)) throw new Error('Invalid data timeout');
      if (ep.fileResult !== undefined) {
        const result = ep.fileResult;
        if (!object(result) || typeof result.path !== 'string' || !/^(?:[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)?$/.test(result.path)
          || ![result.urlField, result.base64Field].some(Boolean)
          || [result.urlField, result.base64Field].some(field => field !== undefined && (typeof field !== 'string' || !/^[a-zA-Z0-9_]+$/.test(field)))
          || !Number.isSafeInteger(result.maxBytes) || result.maxBytes < 1 || result.maxBytes > 32 * 1024 * 1024
          || !Number.isSafeInteger(result.maxFiles) || result.maxFiles < 1 || result.maxFiles > 10) throw new Error('Invalid data file result policy');
      }
      for (const [name, rule] of Object.entries(ep.rules)) {
        if (!Object.hasOwn(ep.parameters, name) || !object(rule)
          || (rule.max !== undefined && (!Number.isSafeInteger(rule.max) || rule.max < 1))
          || (rule.maxItems !== undefined && (!Number.isSafeInteger(rule.maxItems) || rule.maxItems < 1))) throw new Error('Invalid data limit policy');
      }
    }
  }
  return value;
}

/** Read the selected organization catalog; unconfigured organizations expose no capabilities. */
export function loadDataTools(organization) {
  if (!organization.dataTools) return { schemaVersion: 1, categories: [], platforms: [], tools: [] };
  const file = resolve(organization.directory, organization.dataTools.catalog);
  if (!file.startsWith(resolve(organization.directory) + '/')) throw new Error('Data catalog must be inside the organization');
  return parseDataTools(JSON.parse(readFileSync(file, 'utf8')));
}

/** Generate the platform map and direct examples; examples never define endpoint access. */
export function dataToolsSkill(catalog) {
  const source = catalog.attribution;
  const lines = ['---', 'name: data-tools',
    'description: ' + JSON.stringify(`${source ? `通过 ${source.name} ` : ''}查询已开放大类的外部数据：${(catalog.categories || []).map(row => row.zh).join('、')}。Use external data${source ? ` via ${source.name}` : ''} from: ${(catalog.categories || []).map(row => row.en).join(', ')}.`),
    ...(source ? ['metadata:', `  source-name: ${JSON.stringify(source.name)}`, `  source-url: ${JSON.stringify(source.url)}`] : []),
    '---', '', '# 数据工具 / Data tools', '',
    '调用前先报单价；调用后报告实际花费和今天剩余额度，先用 `wp-data balance` 查看本人日/月/单次上限。结果引用数据来源。未知结果不要自动重试。',
    ...(source ? [`回答引用这些数据时注明“来源：${source.name}”和对应的原始来源。When citing this data, state “Source: ${source.name}” and the original source.`] : []),
    'Quote the unit price before calling. After calling, report the actual cost and remaining daily budget; use `wp-data balance` for personal usage and daily/monthly/per-call limits. Cite sources. Never retry an unknown outcome automatically.',
    '今天额度用完时说明北京时间 08:00 恢复；本月额度用完时说明下月 1 日北京时间 08:00 恢复。Daily budgets reset at 08:00 Beijing time; monthly budgets reset at 08:00 on the first of next month.',
    '`wp-data search <想要的数据>` 在开放大类里找接口。`wp-data info <接口>` 查看参数、价格和返回样例。',
    '`wp-data call <接口> key=value ...` 或 `wp-data call <接口> --json \'{"key":"value"}\'`。',
    '目录默认参数会自动应用；只覆盖已开放的参数。生图可能耗时数分钟，请等待命令完成，不要重复调用。',
    'Catalog defaults apply automatically; override only allowed parameters. Image generation can take minutes: wait for the command and do not repeat it.',
    '图片保存在工作区 outputs/images；收到 files 路径后向用户展示保存的图片。保存失败时保留花费记录，不要重新生图。',
    'Images are saved under outputs/images in the workspace. Show the saved images to the user using the returned files paths. A save failure preserves cost; never regenerate automatically.',
    '常用示例可直接调用，不必先搜索。其他需求先按地图搜索，再读接口详情。示例不是白名单。',
    '通用网页搜索和抓取已内置，请使用内置工具。Generic web search and extraction use the built-in tools.',
    'Use common examples directly; otherwise search the platform map and read endpoint details. Examples are not an allowlist.',
    '', '## 开放大类 → 平台 / Open categories → platforms', ''];
  for (const category of catalog.categories || []) {
    lines.push(`### ${category.zh} / ${category.en}`, '');
    for (const platform of (catalog.platforms || []).filter(row => row.category === category.en)) {
      lines.push(`- ${platform.name.zh} / ${platform.name.en}: ${platform.summary}`);
    }
    lines.push('');
  }
  lines.push('## 常用示例 / Common examples', '');
  for (const tool of catalog.tools.filter(tool => tool.endpoints.some(ep => catalog.categories.some(category => category.en === ep.category.en)))) {
    lines.push(`### ${tool.title.zh} / ${tool.title.en}`, '', tool.description.zh, tool.description.en,
      `例句：${tool.example.zh}`, `Example: ${tool.example.en}`, `返回：${tool.returns}`, `大约费用：${tool.price}`, '');
    if (tool.usageNote) lines.push(tool.usageNote, '');
    for (const ep of tool.endpoints) {
      const json = JSON.stringify({ ...ep.template, ...ep.defaults }).replaceAll("'", "'\\''");
      lines.push('```sh', `wp-data call ${ep.id} --json '${json}'`, '```',
        `参数：${Object.entries(ep.parameters).map(([key, rule]) => `${key} (${rule.type}${rule.required ? ', required' : ''})`).join('; ')}`,
        `上限：${JSON.stringify(ep.rules)}${ep.routeMaxUsd ? `; 单次最高 $${ep.routeMaxUsd}` : ''}`, '');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** Refresh category/platform/method/parameter metadata from a public provider catalog without calling paid endpoints. */
export async function refreshDataTools(catalog, provider, fetcher = fetch) {
  const read = async path => {
    const response = await fetcher(new URL(path, provider.origin), { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Catalog unavailable: ${response.status}`);
    return response.json();
  };
  const platforms = (await read(provider.platformsPath)).platforms;
  catalog.categories = provider.categories;
  catalog.directory = provider;
  catalog.platforms = platforms.filter(row => provider.categories.some(category => category.en === row.category))
    .map(row => ({ id: row.slug, category: row.category,
      name: { en: row.label, zh: provider.platformNames[row.slug] || row.label }, summary: row.summary || row.label }));
  for (const tool of catalog.tools) for (const ep of tool.endpoints) {
    const source = (await read(provider.endpointPath.replace('{id}', encodeURIComponent(ep.id)))).endpoint;
    const platform = platforms.find(row => row.slug === source.platform);
    if (source.id !== ep.id || !platform || !['GET', 'POST'].includes(source.method)) throw new Error('Incomplete endpoint metadata');
    ep.method = source.method;
    ep.category = { en: platform.category, zh: provider.categoryNames[platform.category] || platform.category };
    ep.platform = { id: source.platform, en: source.platform_label || platform.label,
      zh: provider.platformNames[source.platform] || platform.label };
    ep.source = { url: new URL(provider.endpointPath.replace('{id}', encodeURIComponent(ep.id)), provider.origin).href,
      platform: source.platform, category: platform.category, price: source.cost };
    const query = source.input?.queryParams || {};
    const body = source.input?.body?.properties || source.input?.body || {};
    ep.parameters = Object.fromEntries(Object.entries(ep.parameters).map(([name, existing]) => {
      const rule = Object.hasOwn(query, name) ? query[name] : body[name];
      if (!rule) throw new Error(`Missing parameter metadata: ${ep.id} ${name}`);
      return [name, { ...existing, in: Object.hasOwn(query, name) ? 'query' : 'body', type: rule.type || 'string', required: existing.required || rule.required === true }];
    }));
  }
  return parseDataTools(catalog);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(process.argv[2]);
  const catalog = JSON.parse(readFileSync(file, 'utf8'));
  const provider = JSON.parse(readFileSync(resolve(process.argv[3]), 'utf8'));
  writeFileSync(file, JSON.stringify(await refreshDataTools(catalog, provider), null, 2) + '\n');
}

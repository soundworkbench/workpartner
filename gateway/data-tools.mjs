/** Category-based data gateway. Provider details and request policies belong to organization data. */
import fs from 'node:fs';
import { loadDataTools } from './organization/data-tools.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
};
async function bytes(stream, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw fail(413, '数据过多，请缩小查询范围 / Reduce the query size');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function micro(value) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid data budget');
  const number = Number(value), result = Math.round(number * 1e6);
  if (String(value).trim() === '' || !Number.isFinite(number) || number < 0 || !Number.isSafeInteger(result)
    || Math.abs(number * 1e6 - result) > 1e-7) throw new Error('Invalid data budget');
  return result;
}

/** Build the one permitted request; limits apply before query/body serialization, including array APIs. */
export function dataRequest(ep, input) {
  if (ep.bodyArray && Array.isArray(input) && input.length === 1) input = input[0];
  if (!object(input)) throw fail(400, '参数必须是 JSON 对象 / Expected a JSON object');
  const params = { ...input };
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(ep.parameters, key)) throw fail(403, '此参数未开放 / Parameter is not allowed');
  }
  for (const [key, rule] of Object.entries(ep.rules)) {
    if (Object.hasOwn(rule, 'fixed')) params[key] = rule.fixed;
    if (rule.max !== undefined) {
      const value = params[key] ?? rule.default ?? rule.max;
      if (!Number.isSafeInteger(value) || value < 1) throw fail(400, '条数必须是正整数 / Expected a positive integer');
      params[key] = Math.min(value, rule.max);
    }
    if (rule.maxItems !== undefined && (!Array.isArray(params[key]) || params[key].length < 1 || params[key].length > rule.maxItems
      || params[key].some(item => typeof item !== 'string' || !item.trim()))) throw fail(400, `一次最多 ${rule.maxItems} 个词 / Too many or invalid keywords`);
  }
  for (const [key, rule] of Object.entries(ep.parameters)) {
    const value = params[key];
    if (rule.required && (value === undefined || value === null || value === '')) throw fail(400, `缺少参数 / Missing parameter: ${key}`);
    if (value === undefined) continue;
    const type = rule.type;
    if ((['str', 'string', 'text', 'url'].includes(type) && typeof value !== 'string')
      || (['integer', 'int'].includes(type) && !Number.isSafeInteger(value))
      || (type === 'object' && !object(value)) || (type.startsWith('array') && !Array.isArray(value))) throw fail(400, `参数类型无效 / Invalid parameter: ${key}`);
  }
  if (ep.requireAny && !ep.requireAny.some(keys => keys.every(key => params[key] !== undefined && params[key] !== ''))) {
    throw fail(400, '请提供完整的查询条件 / Provide complete search criteria');
  }
  const query = new URLSearchParams(), body = {};
  for (const [key, value] of Object.entries(params)) {
    if (ep.parameters[key].in === 'query') query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    else body[key] = value;
  }
  return { query: query.toString(), body: ep.bodyArray ? [body] : body };
}

/** Read live public metadata and authorize categories independently of common examples. */
function liveDirectory(catalog, provider, fetcher) {
  const policy = catalog.directory, cache = new Map();
  async function read(path) {
    const previous = cache.get(path);
    if (previous && previous.until > Date.now()) return previous.value;
    const pending = (async () => {
      const response = await fetcher(new URL(path, provider.origin), { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      const value = JSON.parse((await bytes(response.body || [], 16 * 1024 * 1024)).toString());
      if (!response.ok) throw Object.assign(fail(response.status === 404 ? 403 : 502, '数据目录暂不可用 / Data catalog unavailable'),
        { upstreamStatus: response.status, providerPaused: (value?.error || value?.detail?.error) === 'provider_paused' });
      return value;
    })();
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(path, { until: Date.now() + 5 * 60000, value: pending });
    pending.catch(() => { if (cache.get(path)?.value === pending) cache.delete(path); });
    return pending;
  }
  const pathFor = (name, id) => policy[name].replace('{id}', encodeURIComponent(id));
  async function platforms() {
    const result = await read(policy.platformsPath);
    if (!Array.isArray(result.platforms) || result.platforms.some(row => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) || typeof row.category !== 'string' || typeof row.label !== 'string')) throw fail(502, 'Invalid platform catalog');
    return result.platforms.filter(row => catalog.categories.some(category => category.en === row.category));
  }
  function permitted(ep, allowed) {
    return ep && /^[a-zA-Z0-9_.-]+$/.test(ep.id) && allowed.some(row => row.slug === ep.platform)
      && ['data', 'routed'].includes(ep.kind) && ['GET', 'POST'].includes(ep.method) && ep.platform_eligible === true
      && !policy.blockedEndpoints.includes(ep.id) && !policy.blockedProviders.includes(ep.provider || ep.id.split('.')[0])
      && !(policy.blockedCapabilities || []).some(capability => ep.capability === capability || ep.capability?.startsWith(capability + '.') || ep.id.includes('.' + capability + '.') || ep.id.endsWith('.' + capability));
  }
  async function endpoint(id, ancestors = new Set()) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(id) || ancestors.has(id) || policy.blockedEndpoints.includes(id) || policy.blockedProviders.includes(id.split('.')[0])) throw fail(403, '此数据接口未开放 / Data endpoint is not allowed');
    const result = await read(pathFor('endpointPath', id)), ep = result.endpoint;
    if (ep?.id !== id || !permitted(ep, await platforms())) throw fail(403, '此数据接口未开放 / Data endpoint is not allowed');
    if (ep.kind === 'routed') {
      if (!Array.isArray(ep.routed_children) || !ep.routed_children.length) throw fail(403, '无法核对路由 / Cannot verify route');
      let available = 0;
      for (const child of ep.routed_children) {
        try { await endpoint(child, new Set([...ancestors, id])); available++; }
        catch (error) { if (error.upstreamStatus !== 404 && !error.providerPaused) throw error; }
      }
      if (!available) throw fail(403, '路由暂无可用数据接口 / No available route');
    }
    return ep;
  }
  function presentation(ep, callMaxUsd, task) {
    const example = catalog.tools.find(tool => tool.endpoints.some(row => row.id === ep.id));
    const exampleEndpoint = example?.endpoints.find(row => row.id === ep.id);
    const clean = value => {
      let text = String(value || '');
      for (const name of [...(policy.presentationRedactions || []), ep.provider, ep.provider_display].filter(Boolean)) {
        text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
      }
      return text.replace(/\s+/g, ' ').trim();
    };
    const title = clean(task?.description || ep.summary || ep.name || ep.id), description = clean(ep.summary || title);
    const localized = task ? catalog.presentation?.tasks?.[task.id] : catalog.presentation?.endpoints?.[ep.id];
    const cost = ep.cost, usd = cost?.usd;
    const range = /\$([\d.]+)\s*[–−-]\s*\$([\d.]+)/.exec(cost?.note || '');
    const ceiling = Math.min(callMaxUsd, ...((example?.endpoints || []).filter(row => row.id === ep.id).map(row => row.routeMaxUsd ?? Infinity)));
    const price = typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? {
      kind: cost.type === 'per_result' ? 'unit' : cost.type === 'per_success' ? 'hit' : 'fixed',
      usd: range ? Number(range[1]) : usd,
      maxUsd: range ? Number(range[2]) : usd,
      unit: clean(cost.unit || 'call'), callMaxUsd: ceiling,
      variable: cost.varies === true || cost.display?.variable === true || !!cost.modifiers,
    } : null;
    return { name: task?.id || ep.id, endpoint: ep.id, title: { zh: localized?.title || exampleEndpoint?.title?.zh || example?.title?.zh || title, en: exampleEndpoint?.title?.en || example?.title?.en || task?.description || title },
      description: { zh: localized?.description || example?.description?.zh || description, en: description }, example: exampleEndpoint?.example || example?.example || null,
      price,
      recommended: !!example };
  }
  async function groups() {
    const rows = await platforms();
    return catalog.categories.map(category => ({ name: category, platforms: rows.filter(row => row.category === category.en).map(row => ({
      id: row.slug, name: { en: row.label, zh: policy.platformNames[row.slug] || row.label }, summary: row.summary || '' })) }));
  }
  async function list(platform, callMaxUsd) {
    const allowed = await platforms();
    if (!allowed.some(row => row.slug === platform)) throw fail(403, '此数据平台未开放 / Platform is not allowed');
    const result = await read(pathFor('platformPath', platform));
    if (result.platform?.slug !== platform || !Array.isArray(result.capabilities)) throw fail(502, 'Invalid platform details');
    const cards = [], assigned = new Set();
    for (const task of result.capabilities) {
      const endpoints = (task.endpoints || []).map(row => ({ ...row, platform, capability: task.id }))
        .filter(ep => permitted(ep, allowed));
      if (!endpoints.length) continue;
      endpoints.forEach(ep => assigned.add(ep.id));
      const preferred = endpoints.find(ep => ep.kind === 'routed') || endpoints.find(ep => catalog.tools.some(tool => tool.endpoints.some(row => row.id === ep.id))) || endpoints[0];
      const card = presentation(preferred, callMaxUsd, task);
      const prices = endpoints.map(ep => presentation(ep, callMaxUsd).price);
      // Unknown quotes keep the task visibly unpriced rather than understating its range.
      if (prices.every(Boolean)) {
        card.price = { ...card.price, usd: Math.min(...prices.map(price => price.usd)), maxUsd: Math.max(...prices.map(price => price.maxUsd)),
          callMaxUsd: card.price.callMaxUsd, variable: prices.some(price => price.variable) };
        if (endpoints.length > 1) card.price.kind = 'range';
      } else card.price = null;
      cards.push(card);
    }
    for (const ep of result.extended || []) {
      if (!assigned.has(ep.id) && permitted({ ...ep, platform }, allowed)) {
        assigned.add(ep.id); cards.push(presentation({ ...ep, platform }, callMaxUsd));
      }
    }
    return cards.sort((a, b) => Number(b.recommended) - Number(a.recommended));
  }
  async function search(query) {
    if (!query.trim() || query.length > 1000) throw fail(400, '搜索关键词无效 / Invalid search query');
    const result = await read(policy.searchPath + '?' + new URLSearchParams({ q: query, limit: '100' }));
    if (!Array.isArray(result.results)) throw fail(502, 'Invalid search catalog');
    const allowed = await platforms();
    const matches = result.results.filter(ep => permitted(ep, allowed)).map(ep => ({ id: ep.id, platform: ep.platform,
      description: ep.summary, cost: ep.cost, method: ep.method }));
    return { query, count: matches.length, results: matches };
  }
  async function info(id) {
    const ep = await endpoint(id), details = await read(pathFor('endpointPath', id));
    return { endpoint: ep, example_response: details.example_response ?? null };
  }
  return { groups, list, search, endpoint, info };
}

/** Create authenticated catalog/call routes. Legacy provider prefixes are denied before extension dispatch. */
export function createDataTools({ organization, authenticate, sessionAuthenticate, env = process.env, fetcher = fetch, now = Date.now }) {
  const config = organization.dataTools;
  const catalog = loadDataTools(organization);
  const endpoints = new Map();
  for (const tool of catalog.tools) for (const ep of tool.endpoints) { endpoints.set(ep.command, ep); endpoints.set(ep.id, ep); }
  const provider = config?.provider;
  const directory = config ? liveDirectory(catalog, provider, fetcher) : null;
  const budgets = new Map();
  const headers = provider?.headers;
  if (config) {
    if (!object(provider) || !['http:', 'https:'].includes(new URL(provider.origin).protocol)
      || !provider.tokenFile || !object(headers)
      || ['token', 'organization', 'tag', 'routeMax', 'cost', 'callId'].some(key => typeof headers[key] !== 'string' || !/^[a-z0-9-]+$/i.test(headers[key]))
      || ['orgIdEnvironment', 'orgSlugEnvironment', 'enabledEnvironment', 'verifiedEnvironment'].some(key => !/^[A-Z_][A-Z0-9_]*$/.test(provider[key] || ''))
      || !provider.budgetPath?.startsWith('/') || !provider.budgetPath.includes('{orgId}')
      || !provider.callPath?.startsWith('/') || !provider.callPath.includes('{id}')
      || (provider.usagePath !== undefined && (!provider.usagePath.startsWith('/') || !provider.usagePath.includes('{orgId}')))) throw new Error('Invalid data provider configuration');
  }
  let overrides = {};
  if (provider?.overridesFile) {
    try { overrides = JSON.parse(fs.readFileSync(provider.overridesFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!object(overrides)) throw new Error('Invalid data budget overrides');
  }
  const defaults = Object.fromEntries(Object.entries({ daily: 1, monthly: 5, call: 1 })
    .map(([key, value]) => [key, micro(env[provider?.limitEnvironment?.[key]] ?? value)]));
  const limitsFor = slug => {
    const row = overrides[slug] || {};
    if (!object(row) || Object.keys(row).some(key => !['dailyUsd', 'monthlyUsd', 'callMaxUsd'].includes(key))) throw new Error('Invalid personal data budget');
    return { daily: row.dailyUsd === undefined ? defaults.daily : micro(row.dailyUsd),
      monthly: row.monthlyUsd === undefined ? defaults.monthly : micro(row.monthlyUsd),
      call: row.callMaxUsd === undefined ? defaults.call : micro(row.callMaxUsd) };
  };
  for (const slug of Object.keys(overrides)) limitsFor(slug);
  async function ready() {
    if (!provider || env[provider.enabledEnvironment] !== '1' || env[provider.verifiedEnvironment] !== '1'
      || !/^[1-9]\d*$/.test(env[provider.orgIdEnvironment] || '') || !/^[a-z0-9-]+$/.test(env[provider.orgSlugEnvironment] || '')) {
      throw fail(503, '数据服务尚未准备好，请联系管理员 / Data service is not ready');
    }
    let token;
    try { token = fs.readFileSync(provider.tokenFile, 'utf8').trim(); }
    catch (error) { throw fail(503, '数据服务凭据不可用，请联系管理员 / Data service credential unavailable'); }
    if (!token) throw fail(503, '数据服务凭据不可用 / Data service credential unavailable');
    return { [headers.token]: token, [headers.organization]: env[provider.orgSlugEnvironment], accept: 'application/json' };
  }
  async function budget(slug, limits, auth) {
    const key = `${slug}:${limits.daily}:${limits.monthly}`;
    if (!budgets.has(key)) {
      const pending = (async () => {
        const path = provider.budgetPath.replace('{orgId}', env[provider.orgIdEnvironment]) + (slug ? '/' + encodeURIComponent(slug) : '');
        const response = await fetcher(new URL(path, provider.origin), { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ daily_cap_micro: limits.daily, monthly_cap_micro: limits.monthly }), redirect: 'error', signal: AbortSignal.timeout(15000) });
        await response.body?.cancel();
        if (!response.ok) throw fail(503, '个人数据额度尚未配置好 / Personal data budget is unavailable');
      })();
      budgets.set(key, pending);
      pending.catch(() => budgets.delete(key));
    }
    await budgets.get(key);
  }
  async function usage(user) {
    const auth = await ready();
    if (!provider.usagePath) throw fail(503, '数据用量尚未配置 / Data usage is not configured');
    const date = new Date(now()), day = date.toISOString().slice(0, 10), limits = limitsFor(user.slug);
    async function spend(days) {
      const path = provider.usagePath.replace('{orgId}', env[provider.orgIdEnvironment]);
      const response = await fetcher(new URL(path + '?' + new URLSearchParams({ key: 'user', days: String(days) }), provider.origin), {
        headers: auth, redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) { await response.body?.cancel(); throw fail(503, '数据用量暂时无法读取 / Data usage unavailable'); }
      const value = JSON.parse((await bytes(response.body || [], 2 * 1024 * 1024)).toString());
      if (value.key !== 'user' || !Array.isArray(value.rows)) throw fail(502, '数据用量格式无效 / Invalid data usage');
      const rows = value.rows.filter(row => row?.value === user.slug);
      if (rows.length > 1 || (rows.length && (!Number.isSafeInteger(rows[0].charged_micro) || rows[0].charged_micro < 0))) throw fail(502, '数据用量格式无效 / Invalid data usage');
      return (rows[0]?.charged_micro ?? 0) / 1e6;
    }
    const [daily, monthly] = await Promise.all([spend(1), spend(date.getUTCDate())]);
    return { timezone: 'UTC', date: day, month: day.slice(0, 7),
      resetMessage: '北京时间每天 08:00、每月 1 日 08:00 重置额度',
      daily: { usedUsd: daily, limitUsd: limits.daily / 1e6 },
      monthly: { usedUsd: monthly, limitUsd: limits.monthly / 1e6 }, call: { limitUsd: limits.call / 1e6 } };
  }
  return async (req, res, url) => {
    const blocked = config?.blockedPrefixes?.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix + '/'));
    const usageRoute = url.pathname === '/_wp/data/usage' || config?.usageAliases?.includes(url.pathname);
    if (!blocked && !usageRoute && url.pathname !== '/_wp/data' && !url.pathname.startsWith('/_wp/data/')) return false;
    try {
      const user = authenticate(req) || sessionAuthenticate?.(req);
      if (!user) throw fail(401, '请先登录工作伙伴 / Sign in first');
      if (config && usageRoute && req.method === 'GET' && !url.search) {
        json(res, 200, await usage(user)); return true;
      }
      if (blocked && user.backend !== 'aionui' && config.legacyPassthrough?.includes(url.pathname)) return false;
      if (blocked) throw fail(403, '请使用已开放的数据工具 / Use the open data tools');
      if (req.method === 'GET' && url.pathname === '/_wp/data/tools' && !url.search) {
        json(res, 200, { groups: directory ? await directory.groups() : [], tools: [] });
        return true;
      }
      if (directory && req.method === 'GET' && url.pathname === '/_wp/data/catalog' && [...url.searchParams.keys()].every(key => key === 'platform')) {
        json(res, 200, { tools: await directory.list(url.searchParams.get('platform') || '', limitsFor(user.slug).call / 1e6) }); return true;
      }
      if (directory && req.method === 'GET' && url.pathname === '/_wp/data/search' && [...url.searchParams.keys()].every(key => key === 'q')) {
        json(res, 200, await directory.search(url.searchParams.get('q') || '')); return true;
      }
      const info = /^\/_wp\/data\/info\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname);
      if (directory && req.method === 'GET' && info && !url.search) {
        json(res, 200, await directory.info(info[1])); return true;
      }
      const match = /^\/_wp\/data\/call\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname);
      if (!directory || req.method !== 'POST' || !match || url.search) throw fail(403, '此数据接口未开放 / Data endpoint is not allowed');
      if (req.headers.origin && req.headers.origin !== organization.server.publicOrigin) throw fail(403, '请求来源无效 / Invalid request origin');
      const example = endpoints.get(match[1]);
      const source = await directory.endpoint(example?.id || match[1]);
      const parameters = {};
      const bodySchema = source.input?.body;
      const bodyArray = example?.bodyArray || source.input?.bodyType === 'array' || bodySchema?.type === 'array';
      const bodyFields = bodyArray && bodySchema?.items ? bodySchema.items.properties || bodySchema.items : bodySchema?.properties || bodySchema;
      for (const [location, fields] of [['query', source.input?.queryParams], ['body', bodyFields]]) {
        for (const [key, rule] of Object.entries(fields || {})) {
          if (Object.hasOwn(parameters, key)) throw fail(502, '接口参数有歧义 / Ambiguous endpoint parameters');
          parameters[key] = { in: location, type: rule.type || 'string', required: rule.required === true };
        }
      }
      const ep = { ...example, id: source.id, method: source.method, parameters: example ? Object.fromEntries(Object.entries(example.parameters).map(([key, rule]) => {
        if (!parameters[key]) throw fail(502, '接口参数已变化 / Endpoint parameters changed');
        return [key, { ...parameters[key], required: rule.required || parameters[key].required }];
      })) : parameters, rules: example?.rules || {},
        bodyArray };
      let input;
      try { input = JSON.parse((await bytes(req.iterator({ destroyOnReturn: false }), 256 * 1024)).toString()); }
      catch (error) { req.resume(); throw error.status ? error : fail(400, '参数必须是有效的 JSON / Invalid JSON'); }
      const request = dataRequest(ep, input), limits = limitsFor(user.slug);
      if (!limits.monthly) throw fail(429, '本月数据额度已用完，北京时间下月 1 日 08:00 恢复 / Monthly data budget exhausted; resets at 08:00 Beijing time on the first of next month');
      if (!limits.daily) throw fail(429, '今天数据额度已用完，北京时间 08:00 恢复 / Daily data budget exhausted; resets at 08:00 Beijing time');
      if (!limits.call) throw fail(429, '单次数据额度为零，请联系管理员 / Per-call data budget is zero; contact the administrator');
      const auth = await ready();
      await budget('', defaults, auth);
      if (Object.hasOwn(overrides, user.slug)) await budget(user.slug, limits, auth);
      const callHeaders = { ...auth, [headers.tag]: `user=${user.slug}`, 'content-type': 'application/json',
        [headers.routeMax]: String(Math.min(limits.call / 1e6, ep.routeMaxUsd ?? Infinity)) };
      const path = provider.callPath.replace('{id}', encodeURIComponent(ep.id));
      let response, result;
      try {
        response = await fetcher(new URL(path + (request.query ? '?' + request.query : ''), provider.origin), {
          method: ep.method, headers: callHeaders, ...(ep.method === 'POST' ? { body: JSON.stringify(request.body) } : {}),
          redirect: 'error', signal: AbortSignal.timeout(60000),
        });
        result = JSON.parse((await bytes(response.body || [], 16 * 1024 * 1024)).toString());
      } catch (error) { throw fail(502, '调用结果未知，请核实用量，不要自动重试 / Outcome unknown; check usage before retrying'); }
      if (!response.ok) {
        const rawCode = result?.detail?.error || result?.error;
        const code = typeof rawCode === 'string' ? rawCode : '';
        const monthly = (result?.detail?.period ?? result?.period) === 'month';
        const message = code === 'tag_spend_cap_reached' || code === 'tag_call_cap_reached' ? (monthly
          ? '本月数据额度已用完，北京时间下月 1 日 08:00 恢复 / Monthly data budget exhausted; resets at 08:00 Beijing time on the first of next month'
          : '今天数据额度已用完，北京时间 08:00 恢复 / Daily data budget exhausted; resets at 08:00 Beijing time')
          : code === 'tag_blocked' ? '你的数据服务已暂停 / Personal data service paused'
          : code === 'insufficient_balance' || code === 'platform_daily_cap_reached' ? '公司数据额度暂时用完，请联系管理员 / Company data budget exhausted'
          : '数据接口未返回结果，请检查参数或额度 / Check the parameters and data budget';
        throw fail(response.status === 429 || code?.startsWith('tag_') ? 429 : 502, message);
      }
      const cost = response.headers.get(headers.cost);
      json(res, 200, { data: result, costUsd: cost !== null && /^\d+$/.test(cost) && Number.isSafeInteger(Number(cost)) ? Number(cost) / 1e6 : null,
        callId: response.headers.get(headers.callId) });
    } catch (error) { json(res, error.status || 503, { error: error.status ? error.message : '数据服务暂不可用 / Data service unavailable' }); }
    return true;
  };
}

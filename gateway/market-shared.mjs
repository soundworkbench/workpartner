/** Shared skill market: validation, review, immutable releases and live links. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const semver = { valid: value => /^\d+\.\d+\.\d+$/.test(String(value)) ? String(value).split('.').every(part => Number(part) <= 0xffffff) ? String(value) : null : null, gt: (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; } };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
const trusted = domains => (Array.isArray(domains) ? domains : []).map(String).map(v => v.toLowerCase());
const isTrusted = (host, domains) => { const h = String(host || '').toLowerCase(); return domains.some(d => h === d || h.endsWith(`.${d}`)); };
const finding = (file, line, rule, label, level) => ({ file, line, rule, label, level });

function logicalLines(source) {
  const physical = String(source).split(/\r?\n/), result = [];
  for (let i = 0; i < physical.length; i++) {
    const first = i + 1; let value = physical[i];
    while (/\\\s*$/.test(value) && i + 1 < physical.length) value = value.replace(/\\\s*$/, '') + physical[++i];
    result.push({ line: first, text: value });
  }
  return result;
}

function scanContent(source, file = 'SKILL.md', domains = []) {
  const results = [], domainList = trusted(domains);
  for (const { line, text: lineText } of logicalLines(source)) {
    if (/(?:sk-|ghp_)[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:口令|密码|password|secret)\s*[:=：]\s*["']?[A-Za-z0-9!@#$%^&*_-]{6,}|(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])|(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/u.test(lineText)) results.push(finding(file, line, 'credential', '疑似密钥、口令或个人证件信息', 'block'));
    const dangerousDelete = /\brm\b[^\n]*(?:--no-preserve-root|(?:^|\s)(?:\/|\/\*|~\/?(?:\*|$)|\$HOME|["']\$HOME["']|\$\{HOME\})(?:\s|$))/u.test(lineText) && /(?:-rf|-fr|-r\s+-f|-f\s+-r|--recursive[^\n]*--force|--force[^\n]*--recursive)/.test(lineText);
    if (dangerousDelete || /\bmkfs(?:\.[A-Za-z0-9_-]+)?\b/i.test(lineText) || /\bdd\b[^\n]*\bof\s*=\s*\/dev\//i.test(lineText) || /\bDROP\s+DATABASE\b/i.test(lineText)) results.push(finding(file, line, 'dangerous-delete', '危险删除命令', 'block'));
    if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|perl)\b/i.test(lineText) || /(?:bash|sh)\s+<\(\s*(?:curl|wget)\b/i.test(lineText) || /(?:bash|sh)\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/i.test(lineText)) results.push(finding(file, line, 'download-execute', '下载后直接执行', 'block'));
    const urls = [...lineText.matchAll(/https?:\/\/([^\s/\])'">]+)/gi)];
    for (const match of urls) {
      const host = match[1].toLowerCase().replace(/:\d+$/, '');
      if (!isTrusted(host, domainList)) results.push(finding(file, line, `external-link:${host}`, `外部链接 ${host}`, 'manual'));
      if (/(?:\bcurl\b[^\n]*(?:\s(?:-d|--data(?:-[^\s]+)?|-T|--upload-file|-F|--form)(?:\s|=)|\s-X\s*(?:POST|PUT)\b)|\bwget\b[^\n]*(?:--post-data|--post-file|--body-)|\b(?:nc|ncat)\b|\b(?:scp|rsync)\b[^\n]*\s[^\s:]+:[^\s]+)/i.test(lineText) && !isTrusted(host, domainList)) results.push(finding(file, line, 'external-egress', '向外部发送数据', 'manual'));
    }
    const remote = lineText.match(/\b(?:nc|ncat)\s+(?:[^\s]+\s+)?([A-Za-z0-9.-]+)(?::\d+)?\b/i)?.[1] || lineText.match(/\b(?:scp|rsync)\b[^\n]*\s([A-Za-z0-9.-]+):[^\s]+/i)?.[1];
    if (remote && !isTrusted(remote, domainList)) results.push(finding(file, line, 'external-egress', '向外部发送数据', 'manual'));
    if (/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/i.test(lineText) || /https?:\/\/[^\s/]+\.(?:internal|local|corp)(?:[./:\s]|$)/i.test(lineText) || /(?:\/Users\/|\/home\/|\/data\/|\/srv\/|[A-Za-z]:\\)/.test(lineText)) {
      const hosts = [...lineText.matchAll(/https?:\/\/([^\s/\])'">]+)/gi)].map(m => m[1].toLowerCase().replace(/:\d+$/, ''));
      if (!hosts.length || hosts.some(h => !isTrusted(h, domainList))) results.push(finding(file, line, 'internal-path', '内部地址或本机路径', 'manual'));
    }
  }
  return results;
}

function findingMessage(findings) {
  const first = findings.slice(0, 5).map(f => `${f.file} 第 ${f.line} 行：${f.label}`);
  return first.join('；') + (findings.length > 5 ? `；等 ${findings.length - 5} 处` : '');
}

export function inspectSkill(bundle, protectedNames = [], reservedPrefixes = [], displayName = '', trustedDomains = []) {
  if (!bundle || typeof bundle.name !== 'string' || !NAME.test(bundle.name) || protectedNames.includes(bundle.name)) throw fail(400, '技能名称无效或与预装技能重名。');
  if (reservedPrefixes.some(prefix => bundle.name.startsWith(prefix) || displayName.startsWith(prefix))) throw fail(400, '这个名称前缀留给官方技能。');
  if (!text(bundle.description, 4000) || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 200) throw fail(400, '技能说明或文件数量无效。');
  const seen = new Set(), files = [], findings = [], warnings = new Set(); let size = 0, scripts = 0;
  for (const file of bundle.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.length > 512 || file.path.split('/').some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p)) || seen.has(file.path)) throw fail(400, '技能包含无效或重复的文件路径。');
    if (typeof file.content !== 'string' || file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) throw fail(400, '技能文件无法读取。');
    const content = Buffer.from(file.content, 'base64'); size += content.length;
    if (size > 10 * 1024 * 1024) throw fail(413, '分享的技能总计不能超过 10 MB。');
    const source = content.toString('utf8'); const rows = scanContent(source, file.path, trustedDomains); findings.push(...rows);
    if (rows.some(f => f.rule === 'internal-path')) warnings.add('含内部地址或本机路径，请核对是否已换成占位说明。');
    if (file.executable || /\.(?:py|sh|bash|js|mjs|cjs|ts|ps1|bat|cmd|rb|pl)$/i.test(file.path) || source.startsWith('#!')) scripts++;
    seen.add(file.path); files.push({ path: file.path, content, executable: Boolean(file.executable) });
  }
  if (!seen.has('SKILL.md')) throw fail(400, '技能缺少 SKILL.md。');
  const blocks = findings.filter(item => item.level === 'block');
  if (blocks.length) throw fail(400, `${findingMessage(blocks)}。`, { findings: blocks });
  return { files, findings, warnings: [...warnings], scripts };
}

export function createSharedSkillStore({ stateDir, sharedDir, approvers = [], reservedPrefixes = [], protectedNames = [], trustedDomains = [], notify = async () => {}, notifyAuthor = async () => {}, createReviewToken, verifyReviewToken }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const directory of [sharedDir, path.join(sharedDir, 'live'), path.join(sharedDir, 'releases')]) { fs.mkdirSync(directory, { recursive: true }); fs.chmodSync(directory, 0o755); }
  const stateFile = path.join(stateDir, 'catalog.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, skills: {} };
  if (state.version !== 1 || !state.skills || Array.isArray(state.skills)) throw new Error('Unsupported skill market state');
  let queue = Promise.resolve(); const serial = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const keyedQueues = new Map(); const keyedSerial = (key, work) => { const result = (keyedQueues.get(key) || Promise.resolve()).then(work); const settled = result.catch(() => {}); keyedQueues.set(key, settled); void settled.then(() => { if (keyedQueues.get(key) === settled) keyedQueues.delete(key); }); return result; };
  function save() { const temporary = `${stateFile}.${crypto.randomUUID()}`; try { fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, stateFile); } catch (error) { state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, skills: {} }; throw error; } finally { fs.rmSync(temporary, { force: true }); } }
  const admin = user => approvers.includes(user?.unionId);
  const get = name => { if (!NAME.test(name) || !Object.hasOwn(state.skills, name)) throw fail(404, '没有找到这个技能。'); return state.skills[name]; };
  function release(name, id) { const target = path.join(sharedDir, 'releases', name, id); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.chmodSync(path.dirname(target), 0o755); if (!fs.existsSync(target)) { const stage = `${target}.${crypto.randomUUID()}`; try { fs.cpSync(path.join(stateDir, 'submissions', name, id), stage, { recursive: true }); const readable = directory => { fs.chmodSync(directory, 0o755); for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) readable(file); else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o755 : 0o644); } }; readable(stage); fs.renameSync(stage, target); } finally { fs.rmSync(stage, { force: true, recursive: true }); } } if (!fs.existsSync(path.join(target, 'SKILL.md'))) throw new Error('Approved skill release is missing'); return target; }
  const unavailable = new Set();
  function reconcile(name) { const row = get(name), link = path.join(sharedDir, 'live', name); if (!row.live) { fs.rmSync(link, { force: true }); return; } const target = release(name, row.live); const temporary = `${link}.${crypto.randomUUID()}`; try { fs.symlinkSync(path.relative(path.dirname(link), target), temporary); fs.renameSync(temporary, link); unavailable.delete(name); } finally { fs.rmSync(temporary, { force: true }); } }
  let stale = 0; for (const [name, row] of Object.entries(state.skills)) { const live = row.live && row.versions[row.live]; if (live?.status === 'approved') for (const version of Object.values(row.versions)) if (version.status === 'pending' && version.createdAt < live.createdAt) { version.status = 'superseded'; version.supersededBy = live.id; version.supersededAt = new Date().toISOString(); stale++; } try { reconcile(name); } catch (error) { unavailable.add(name); console.warn(`[skill-market] ${name}: release unavailable (${error.code || error.message}); skipped, gateway startup continues`); } }
  if (stale) { save(); console.warn(`[skill-market] superseded ${stale} stale pending versions`); }
  const summary = (name, row, version) => ({ name, version: version.id, displayName: version.displayName, description: version.description, example: version.example, author: row.authorName, installs: row.installs, status: version.status, reason: version.reason || '', warnings: version.warnings || [], scripts: version.scripts || 0, reviewNotice: version.reviewNotice, authorNotice: version.authorNotice, createdAt: version.createdAt, semver: version.semver || '', currentSemver: row.live && row.versions[row.live]?.semver || '', hasLive: Boolean(row.live), autoPublished: version.reviewer === 'auto', manualReasons: version.manualReasons || [], findings: version.findings || [], supersededBy: version.supersededBy });
  async function sendReview(name, id) { const request = await serial(() => { const row = state.skills[name], version = row?.versions?.[id]; if (!row || !version) return null; const noticeId = crypto.randomUUID(); version.reviewNoticeId = noticeId; delete version.reviewNotice; save(); const reviewToken = createReviewToken?.(name, id, 'approve', noticeId); return { noticeId, payload: { ...summary(name, row, version), approvers, reviewToken } }; }); if (!request) return; let notice = 'sent'; try { await notify(request.payload); } catch { notice = 'failed'; } await serial(() => { const version = state.skills[name]?.versions?.[id]; if (!version || version.reviewNoticeId !== request.noticeId) return; version.reviewNotice = notice; save(); }); }
  async function sendAuthor(name, id) { const request = await serial(() => { const row = state.skills[name], version = row?.versions?.[id]; if (!row || !version) return null; const noticeId = crypto.randomUUID(); version.authorNoticeId = noticeId; delete version.authorNotice; save(); return { noticeId, payload: { ...summary(name, row, version), unionId: row.author } }; }); if (!request) return; let notice = 'sent'; try { await notifyAuthor(request.payload); } catch { notice = 'failed'; } await serial(() => { const version = state.skills[name]?.versions?.[id]; if (!version || version.authorNoticeId !== request.noticeId) return; version.authorNotice = notice; save(); }); }
  function newer(a, b) { return a?.semver && b?.semver ? semver.gt(a.semver, b.semver) : a.createdAt > b.createdAt; }
  function publish(name, id, reviewer) { const row = get(name), version = row.versions[id]; release(name, id); if (!row.live || newer(version, row.versions[row.live])) row.live = id; version.status = 'approved'; version.reviewedAt = new Date().toISOString(); version.reviewer = reviewer; version.reason = ''; for (const old of Object.values(row.versions)) if (old.id !== id && old.status === 'pending' && old.createdAt < version.createdAt) { old.status = 'superseded'; old.supersededBy = id; old.supersededAt = new Date().toISOString(); } save(); reconcile(name); return { row, version, notice: 'author' }; }
  return {
    admin,
    list(user) { const company = [], mine = [], pending = [], reviewed = []; for (const [name, row] of Object.entries(state.skills)) { if (row.live && !unavailable.has(name)) company.push({ ...summary(name, row, row.versions[row.live]), canWithdraw: admin(user) || row.author === user.unionId }); for (const version of Object.values(row.versions)) { if (row.author === user.unionId) mine.push(summary(name, row, version)); if (admin(user) && version.status !== 'pending') reviewed.push(summary(name, row, version)); if (admin(user) && version.status === 'pending') pending.push(summary(name, row, version)); } } return { company: company.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name)), mine, pending, reviewed, isApprover: admin(user), submissionsEnabled: approvers.length > 0 }; },
    async submit(user, bundle, meta) {
      const name = bundle?.name; let outcome = await serial(async () => {
        if (!approvers.length) throw fail(403, '管理员尚未开放技能分享。');
        if (!text(meta.displayName, 80) || !text(meta.description, 300) || !text(meta.example, 500)) throw fail(400, '请填写技能中文名、一句话说明和一个例句。');
        const hasSemver = meta.semver !== undefined; if (hasSemver && (typeof meta.semver !== 'string' || !/^\d+\.\d+\.\d+$/.test(meta.semver) || meta.semver.split('.').some(v => v.length > 6 || (v.length > 1 && v.startsWith('0'))) || !semver.valid(meta.semver))) throw fail(400, '版本号格式应为 1.2.3');
        let checked; try { checked = inspectSkill(bundle, protectedNames, reservedPrefixes, meta.displayName, trustedDomains); } catch (error) { if (error.findings) throw fail(400, `${findingMessage(error.findings)}。`, { findings: error.findings }); throw error; } const formFindings = scanContent([name, meta.displayName, meta.description, meta.example].join('\n'), '表单信息', trustedDomains); checked.findings.push(...formFindings); if (formFindings.some(f => f.rule === 'internal-path')) checked.warnings.push('含内部地址或本机路径，请核对是否已换成占位说明。'); checked.warnings = [...new Set(checked.warnings)];
        const blocks = checked.findings.filter(f => f.level === 'block'); if (blocks.length) throw fail(400, `${findingMessage(blocks)}。`, { findings: blocks });
        const old = Object.hasOwn(state.skills, name) ? state.skills[name] : undefined; if (old && old.author !== user.unionId) throw fail(409, '这个名称已由其他作者使用，请改名。');
        if (hasSemver) { const versions = old ? Object.values(old.versions).filter(v => ['approved', 'pending', 'withdrawn'].includes(v.status)) : []; const max = versions.reduce((m, v) => semver.gt(v.semver || '0.0.0', m) ? (v.semver || '0.0.0') : m, '0.0.0'); if (!semver.gt(meta.semver, max)) throw fail(400, `版本号需大于已有的 ${max}`); }
        const digestData = { displayName: meta.displayName, description: meta.description, example: meta.example, files: bundle.files }; if (hasSemver) digestData.semver = meta.semver; const digest = crypto.createHash('sha256').update(JSON.stringify(digestData)).digest('hex'); const duplicate = old && Object.values(old.versions).find(v => v.digest === digest && ['pending', 'approved'].includes(v.status)); if (duplicate) return { row: old, version: duplicate, notify: false, auto: false };
        const id = crypto.randomUUID(), location = path.join(stateDir, 'submissions', name, id); fs.mkdirSync(location, { recursive: true }); for (const file of checked.files) { const target = path.join(location, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 }); }
        const row = old || { author: user.unionId, authorName: user.name || name, installs: 0, live: null, versions: {} }; const currentLive = row.live && row.versions[row.live]; const manualReasons = []; if (!old || currentLive?.status !== 'approved') manualReasons.push({ rule: 'first-submission', label: '首次分享需人工审批' }); if (!hasSemver) manualReasons.push({ rule: 'no-semver', label: '未填写版本号' }); manualReasons.push(...checked.findings.filter(f => f.level === 'manual')); const version = { id, digest, displayName: meta.displayName, description: meta.description, example: meta.example, warnings: checked.warnings, findings: checked.findings, manualReasons, scripts: checked.scripts, status: 'pending', createdAt: new Date().toISOString() }; if (hasSemver) version.semver = meta.semver; row.versions[id] = version; state.skills[name] = row; save(); const auto = manualReasons.length === 0; if (auto) publish(name, id, 'auto'); return { row, version, notify: true, auto };
      });
      if (outcome.notify) { if (outcome.auto) await sendAuthor(name, outcome.version.id); else { await sendReview(name, outcome.version.id); if (outcome.row.live) await sendAuthor(name, outcome.version.id); } }
      return serial(() => summary(name, state.skills[name], state.skills[name].versions[outcome.version.id]));
    },
    async review(user, name, id, action, reason = '') { const outcome = await serial(async () => { if (!admin(user)) throw fail(403, '只有配置的审批人可以审批。'); const row = get(name), version = row.versions[id]; if (!version || !['approve', 'reject', 'resend', 'notify-author'].includes(action)) throw fail(400, '审批参数无效。'); if (action === 'notify-author') { if (version.status === 'pending') throw fail(409, '请先完成审批。'); return { row, version, notice: 'author' }; } if (action === 'resend') { if (version.status !== 'pending') throw fail(409, '这个版本已经审批。'); return { row, version, notice: 'review' }; } if (version.status !== 'pending') { const status = { approved: '已通过', rejected: '未通过', withdrawn: '已下架', superseded: '已被新版替代' }[version.status] || version.status; throw fail(409, `这个版本当前状态为“${status}”，不能重复审批，请刷新市场查看。`); } if (action === 'reject' && !text(reason, 1000)) throw fail(400, '拒绝时请填写原因。'); if (action === 'approve') return publish(name, id, user.unionId); version.status = 'rejected'; version.reason = reason; version.reviewedAt = new Date().toISOString(); version.reviewer = user.unionId; save(); return { row, version, notice: 'author' }; }); if (outcome.notice === 'review') await sendReview(name, id); else if (outcome.notice === 'author') await sendAuthor(name, id); return serial(() => summary(name, state.skills[name], state.skills[name].versions[id])); },
    withdraw(user, name) { return serial(() => { const row = get(name); if (!admin(user) && row.author !== user.unionId) throw fail(403, '只有作者或审批人可以下架。'); row.live = null; for (const version of Object.values(row.versions)) if (['approved', 'pending'].includes(version.status)) version.status = 'withdrawn'; save(); reconcile(name); return { name }; }); },
    install(user, name, execute) { return keyedSerial(`${user.slug}:${name}`, async () => { await serial(async () => { const row = get(name); if (!row.live) throw fail(404, '这个技能已经下架。'); reconcile(name); }); const result = await execute(user, 'shared-install', { name }); if (result.error) throw Object.assign(fail(result.error === 'not_found' ? 404 : 409, result.error === 'not_found' ? '这个技能已经下架。' : result.message), { code: result.error }); await serial(() => { if (result.changed && state.skills[name]) { state.skills[name].installs++; save(); } }); return { name, installed: true, changed: Boolean(result.changed) }; }); },
    uninstall(user, name, execute) { return keyedSerial(`${user.slug}:${name}`, async () => { const result = await execute(user, 'delete', { name }); if (!result.error && result.shared && state.skills[name]) await serial(() => { state.skills[name].installs = Math.max(0, state.skills[name].installs - 1); save(); }); return { ...result, installed: false }; }); },
    source(user, name, id) { if (!admin(user)) throw fail(403, '只有审批人可以查看待审内容。'); const row = get(name); if (!row.versions[id]) throw fail(404, '没有找到这个版本。'); const root = path.join(stateDir, 'submissions', name, id), sections = []; const visit = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) visit(file); else sections.push(`--- ${path.relative(root, file)} ---\n${fs.readFileSync(file, 'utf8')}`); } }; visit(root); return sections.join('\n\n'); },
    verifyReviewToken,
    reviewToken(token, name, id) {
      const version = state.skills[name]?.versions?.[id];
      const claims = version && verifyReviewToken?.(token, name, id, 'approve', version.reviewNoticeId);
      if (!claims || claims.name !== name || claims.id !== id || claims.action !== 'approve') return null;
      if (!version || claims.noticeId !== version.reviewNoticeId) return { processed: version.status !== 'pending', version };
      return { processed: version.status !== 'pending', version, claims };
    },
  };
}

export function createSharedSkillsHandler({ store, authenticate, tokenAuthenticate, origin, execute }) {
  const prefix = '/_wp/market/shared'; const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); };
  return async (req, res, url) => {
    if (url.pathname !== prefix && url.pathname !== `${prefix}/review`) return false;
    const started = Date.now(); let action = req.method === 'GET' ? 'list' : 'unknown'; let skillName = url.searchParams.get('name') || undefined; let actor;
    const logError = (error, status) => { const httpStatus = Number.isInteger(status) ? status : 503; const unknown = !Number.isInteger(error?.status); const entry = { event: 'market_shared_error', action, name: typeof skillName === 'string' && NAME.test(skillName) ? skillName : undefined, status: httpStatus, code: unknown ? (error?.name || 'Error') : (error?.code || `HTTP_${httpStatus}`), message: unknown ? undefined : String(error?.message || '操作失败').slice(0, 300), durationMs: Date.now() - started, user: actor }; (httpStatus >= 400 && httpStatus < 500 ? console.warn : console.error)(JSON.stringify(entry)); };
    try {
      const signed = tokenAuthenticate(req), user = signed || authenticate(req); actor = user?.slug;
      if (!user) { if (req.method === 'GET' && url.pathname.endsWith('/review')) { res.writeHead(302, { location: '/_wp/login?next=' + encodeURIComponent(url.pathname + url.search), 'cache-control': 'no-store' }); res.end(); return true; } throw fail(401, '请先登录工作伙伴。'); }
      if (!store.admin(user) && (user.backend !== 'aionui' || !/^[a-zA-Z0-9_-]+$/.test(user.slug))) throw fail(403, '请在新版工作伙伴中使用。');
      if (req.method === 'GET' && url.pathname.endsWith('/review')) {
        const name = url.searchParams.get('name'), id = url.searchParams.get('version'), requested = url.searchParams.get('action'), token = url.searchParams.get('t');
        if (requested === 'approve' && token && !store.admin(user)) throw fail(403, '只有配置的审批人可以审批。');
        if (requested === 'approve' && token && store.admin(user)) { const checked = store.reviewToken?.(token, name, id); if (checked?.processed) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(`<!doctype html><meta charset="utf-8"><title>审批完成</title><h1>这个版本已处理：${esc(checked.version?.status || '')}</h1>`); return true; } if (checked?.claims) { const result = await store.review(user, name, id, 'approve'); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(`<!doctype html><meta charset="utf-8"><title>审批完成</title><h1>已批准并发布 ${esc(result.semver ? `v${result.semver}` : '未标注')}</h1>`); return true; } }
        const source = store.source(user, name, id), catalog = store.list(user), info = [...catalog.pending, ...catalog.reviewed].find(v => v.name === name && v.version === id), hint = requested === 'approve' ? '链接已失效或需要确认，请在下方操作' : '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'", 'referrer-policy': 'no-referrer' });
        const reasons = [...(info?.manualReasons || []), ...(info?.findings || []).filter(f => f.level === 'manual')].map(f => `<li>${esc(f.file ? `${f.file} 第 ${f.line} 行：${f.label}` : `${f.rule}：${f.label}`)}</li>`).join('');
        const live = catalog.company.find(v => v.name === name);
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>技能审批</title><style>body{max-width:768px;margin:32px auto;padding:16px;font:16px/1.6 system-ui}pre{white-space:pre-wrap}.warning{color:#a22}</style><h1>${esc(info?.displayName || name)}</h1><p class="warning">${esc(hint)}</p><p>版本：${esc(info?.semver ? `v${info.semver}` : '未标注')}；当前上架：${esc(live?.semver ? `v${live.semver}` : '未标注')}</p><ul>${reasons}</ul><p>含脚本 ${info?.scripts ?? 0} 个。</p><form><label for="reason">拒绝原因</label><textarea id="reason" name="reason" ${requested === 'reject' ? 'autofocus' : ''} required></textarea></form><a href="/#/market">返回技能市场</a><pre>${esc(source)}</pre></html>`); return true;
      }
      if (req.method === 'GET') { json(res, 200, store.list(user)); return true; }
      if (req.method !== 'POST') { json(res, 405, { message: '请求方法不支持。' }); return true; }
      if (!signed && req.headers.origin !== origin) throw fail(403, '请求来源不受信任。');
      if (!signed && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '请求必须使用 JSON。');
      const chunks = []; for await (const chunk of req) chunks.push(chunk); let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, '请求格式无效。'); }
      if (!body || typeof body.name !== 'string' || !NAME.test(body.name)) throw fail(400, '技能名称无效。'); skillName = body.name; action = ['install', 'uninstall', 'withdraw', 'approve', 'reject', 'resend', 'notify-author', 'submit'].includes(body.action) ? body.action : 'unknown';
      if (['submit', 'install'].includes(body.action) && (user.backend !== 'aionui' || !/^[a-zA-Z0-9_-]+$/.test(user.slug))) throw fail(403, '请先开通新版工作伙伴。');
      let result; if (body.action === 'submit') { const bundle = await execute(user, 'export', { name: body.name }); if (bundle.error) throw fail(400, bundle.message); result = await store.submit(user, bundle, body); } else if (body.action === 'install') result = await store.install(user, body.name, execute); else if (body.action === 'uninstall') result = await store.uninstall(user, body.name, execute); else if (body.action === 'withdraw') result = await store.withdraw(user, body.name); else result = await store.review(user, body.name, body.version, body.action, body.reason); json(res, 200, result);
    } catch (error) { const status = error.status || 503; logError(error, status); json(res, status, { message: error.status ? error.message : '操作尚未确认完成，请刷新市场核实。', ...(error.findings ? { findings: error.findings } : {}) }); }
    return true;
  };
}

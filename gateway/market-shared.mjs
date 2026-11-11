/** Reviewed skills: private submissions, immutable releases and an atomic public live link. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;

function scanContent(source) {
  const warnings = [];
  if (/(?:sk-|ghp_)[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:口令|密码|password|secret)\s*[:=：]\s*["']?[A-Za-z0-9!@#$%^&*_-]{6,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)/u.test(source)) throw fail(400, '技能疑似包含密钥、口令或个人证件信息，请去掉后重新提交。');
  if (/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)|https?:\/\/[^\s/]+\.(?:internal|local|corp)(?:[./:\s]|$)|(?:\/Users\/|\/home\/|\/data\/|\/srv\/|[A-Za-z]:\\)/u.test(source)) warnings.push('含内部地址或本机路径，请核对是否已换成占位说明。');
  return warnings;
}

/** Validate the entire worker export before privileged writes; scan without exposing matched secrets. */
export function inspectSkill(bundle, protectedNames = [], reservedPrefixes = [], displayName = '') {
  if (!bundle || typeof bundle.name !== 'string' || !NAME.test(bundle.name) || protectedNames.includes(bundle.name)) throw fail(400, '技能名称无效或与预装技能重名。');
  if (reservedPrefixes.some(prefix => bundle.name.startsWith(prefix) || displayName.startsWith(prefix))) throw fail(400, '这个名称前缀留给官方技能。');
  if (!text(bundle.description, 4000) || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 200) throw fail(400, '技能说明或文件数量无效。');
  const seen = new Set(), files = [], warnings = new Set(); let size = 0, scripts = 0;
  for (const file of bundle.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.length > 512 || file.path.split('/').some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p)) || seen.has(file.path)) throw fail(400, '技能包含无效或重复的文件路径。');
    if (typeof file.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw fail(400, '技能文件无法读取。');
    const content = Buffer.from(file.content, 'base64'); size += content.length;
    if (size > 10 * 1024 * 1024) throw fail(413, '分享的技能总计不能超过 10 MB。');
    const source = content.toString('utf8');
    for (const warning of scanContent(source)) warnings.add(warning);
    if (file.executable || /\.(?:py|sh|bash|js|mjs|cjs|ts|ps1|bat|cmd|rb|pl)$/i.test(file.path) || source.startsWith('#!')) scripts++;
    seen.add(file.path); files.push({ path: file.path, content, executable: Boolean(file.executable) });
  }
  if (!seen.has('SKILL.md')) throw fail(400, '技能缺少 SKILL.md。');
  return { files, warnings: [...warnings], scripts };
}

/** One gateway process owns the state file; serialize its mutations and publish decisions before notifications. */
export function createSharedSkillStore({ stateDir, sharedDir, approvers = [], reservedPrefixes = [], protectedNames = [], notify = async () => {}, notifyAuthor = async () => {} }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const directory of [sharedDir, path.join(sharedDir, 'live'), path.join(sharedDir, 'releases')]) {
    fs.mkdirSync(directory, { recursive: true }); fs.chmodSync(directory, 0o755);
  }
  const stateFile = path.join(stateDir, 'catalog.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, skills: {} };
  if (state.version !== 1 || !state.skills || Array.isArray(state.skills)) throw new Error('Unsupported skill market state');
  let queue = Promise.resolve();
  const serial = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  function save() {
    const temporary = `${stateFile}.${crypto.randomUUID()}`;
    try { fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, stateFile); }
    catch (error) { state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, skills: {} }; throw error; }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  const admin = user => approvers.includes(user?.unionId);
  const get = name => { if (!NAME.test(name) || !Object.hasOwn(state.skills, name)) throw fail(404, '没有找到这个技能。'); return state.skills[name]; };
  function release(name, id) {
    const target = path.join(sharedDir, 'releases', name, id);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.chmodSync(path.dirname(target), 0o755);
    if (!fs.existsSync(target)) {
      const stage = `${target}.${crypto.randomUUID()}`;
      try {
        fs.cpSync(path.join(stateDir, 'submissions', name, id), stage, { recursive: true });
        function readable(directory) {
          fs.chmodSync(directory, 0o755);
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) readable(file);
            else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o755 : 0o644);
          }
        }
        readable(stage); fs.renameSync(stage, target);
      }
      finally { fs.rmSync(stage, { force: true, recursive: true }); }
    }
    if (!fs.existsSync(path.join(target, 'SKILL.md'))) throw new Error('Approved skill release is missing');
    return target;
  }
  const unavailable = new Set();
  function reconcile(name) {
    const row = get(name), link = path.join(sharedDir, 'live', name);
    if (!row.live) { fs.rmSync(link, { force: true }); return; }
    const target = release(name, row.live);
    const temp = `${link}.${crypto.randomUUID()}`;
    try { fs.symlinkSync(path.relative(path.dirname(link), target), temp); fs.renameSync(temp, link); unavailable.delete(name); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  for (const name of Object.keys(state.skills)) {
    try { reconcile(name); }
    catch (error) {
      unavailable.add(name);
      console.warn(`[skill-market] ${name}: release unavailable (${error.code || error.message}); skipped, gateway startup continues`);
    }
  }
  const summary = (name, row, version) => ({ name, version: version.id, displayName: version.displayName,
    description: version.description, example: version.example, author: row.authorName, installs: row.installs,
    status: version.status, reason: version.reason || '', warnings: version.warnings, scripts: version.scripts,
    reviewNotice: version.reviewNotice, authorNotice: version.authorNotice, createdAt: version.createdAt });
  async function sendReview(name, row, version) {
    try { await notify({ ...summary(name, row, version), approvers }); version.reviewNotice = 'sent'; }
    catch (error) { version.reviewNotice = 'failed'; }
    save();
  }
  async function sendAuthor(name, row, version) {
    try { await notifyAuthor({ ...summary(name, row, version), unionId: row.author }); version.authorNotice = 'sent'; }
    catch (error) { version.authorNotice = 'failed'; }
    save();
  }
  return {
    admin,
    list(user) {
      const company = [], mine = [], pending = [], reviewed = [];
      for (const [name, row] of Object.entries(state.skills)) {
        if (row.live && !unavailable.has(name)) company.push({ ...summary(name, row, row.versions[row.live]), canWithdraw: admin(user) || row.author === user.unionId });
        for (const version of Object.values(row.versions)) {
          if (row.author === user.unionId) mine.push(summary(name, row, version));
          if (admin(user) && version.status !== 'pending') reviewed.push(summary(name, row, version));
          if (admin(user) && version.status === 'pending') pending.push(summary(name, row, version));
        }
      }
      return { company: company.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name)), mine, pending, reviewed,
        isApprover: admin(user), submissionsEnabled: approvers.length > 0 };
    },
    submit(user, bundle, meta) { return serial(async () => {
      if (!approvers.length) throw fail(403, '管理员尚未开放技能分享。');
      if (!text(meta.displayName, 80) || !text(meta.description, 300) || !text(meta.example, 500)) throw fail(400, '请填写技能中文名、一句话说明和一个例句。');
      const checked = inspectSkill(bundle, protectedNames, reservedPrefixes, meta.displayName), name = bundle.name;
      checked.warnings = [...new Set([...checked.warnings, ...scanContent([name, meta.displayName, meta.description, meta.example].join('\n'))])];
      const old = Object.hasOwn(state.skills, name) ? state.skills[name] : undefined;
      if (old && old.author !== user.unionId) throw fail(409, '这个名称已由其他作者使用，请改名。');
      const digest = crypto.createHash('sha256').update(JSON.stringify({ displayName: meta.displayName, description: meta.description, example: meta.example, files: bundle.files })).digest('hex');
      const duplicate = old && Object.values(old.versions).find(v => v.digest === digest && ['pending', 'approved'].includes(v.status));
      if (duplicate) return summary(name, old, duplicate);
      const id = crypto.randomUUID(), location = path.join(stateDir, 'submissions', name, id);
      fs.mkdirSync(location, { recursive: true });
      for (const file of checked.files) {
        const target = path.join(location, file.path); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
      }
      const row = old || { author: user.unionId, authorName: user.name || name, installs: 0, live: null, versions: {} };
      const version = { id, digest, displayName: meta.displayName, description: meta.description, example: meta.example,
        warnings: checked.warnings, scripts: checked.scripts, status: 'pending', createdAt: new Date().toISOString() };
      row.versions[id] = version; state.skills[name] = row; save();
      await sendReview(name, row, version);
      return summary(name, row, version);
    }); },
    review(user, name, id, action, reason = '') { return serial(async () => {
      if (!admin(user)) throw fail(403, '只有配置的审批人可以审批。');
      const row = get(name), version = Object.hasOwn(row.versions, id) ? row.versions[id] : undefined;
      if (!version || !['approve', 'reject', 'resend', 'notify-author'].includes(action)) throw fail(400, '审批参数无效。');
      if (action === 'notify-author') { if (version.status === 'pending') throw fail(409, '请先完成审批。'); await sendAuthor(name, row, version); return summary(name, row, version); }
      if (action === 'resend') { if (version.status !== 'pending') throw fail(409, '这个版本已经审批。'); await sendReview(name, row, version); return summary(name, row, version); }
      if (version.status !== 'pending') {
        const status = { approved: '已通过', rejected: '未通过', withdrawn: '已下架' }[version.status] || version.status;
        throw fail(409, `这个版本当前状态为“${status}”，不能重复审批，请刷新市场查看。`);
      }
      if (action === 'reject' && !text(reason, 1000)) throw fail(400, '拒绝时请填写原因。');
      if (action === 'approve') {
        release(name, id);
        if (!row.live || row.versions[row.live].createdAt <= version.createdAt) row.live = id;
      }
      version.status = action === 'approve' ? 'approved' : 'rejected'; version.reason = action === 'reject' ? reason : '';
      version.reviewedAt = new Date().toISOString(); version.reviewer = user.unionId;
      save(); reconcile(name); await sendAuthor(name, row, version);
      return summary(name, row, version);
    }); },
    withdraw(user, name) { return serial(() => {
      const row = get(name);
      if (!admin(user) && row.author !== user.unionId) throw fail(403, '只有作者或审批人可以下架。');
      row.live = null;
      for (const version of Object.values(row.versions)) if (['approved', 'pending'].includes(version.status)) version.status = 'withdrawn';
      save(); reconcile(name); return { name };
    }); },
    install(user, name, execute) { return serial(async () => {
      const row = get(name); if (!row.live) throw fail(404, '这个技能已经下架。');
      reconcile(name);
      const result = await execute(user, 'shared-install', { name });
      if (result.error) throw fail(409, result.message);
      if (result.changed) { row.installs++; save(); }
      return { name };
    }); },
    uninstall(user, name, execute) { return serial(async () => {
      const result = await execute(user, 'delete', { name });
      if (!result.error && result.shared && Object.hasOwn(state.skills, name)) {
        state.skills[name].installs = Math.max(0, state.skills[name].installs - 1); save();
      }
      return result;
    }); },
    source(user, name, id) {
      if (!admin(user)) throw fail(403, '只有审批人可以查看待审内容。');
      const row = get(name); if (!Object.hasOwn(row.versions, id)) throw fail(404, '没有找到这个版本。');
      const root = path.join(stateDir, 'submissions', name, id), sections = [];
      function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file);
          else sections.push(`--- ${path.relative(root, file)} ---\n${fs.readFileSync(file, 'utf8')}`);
        }
      }
      visit(root); return sections.join('\n\n');
    },
  };
}

/** Cookie callers require same-origin JSON; signed container callers use the same routes and review policy. */
export function createSharedSkillsHandler({ store, authenticate, tokenAuthenticate, origin, execute }) {
  const prefix = '/_wp/market/shared';
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); };
  return async (req, res, url) => {
    if (url.pathname !== prefix && url.pathname !== `${prefix}/review`) return false;
    try {
      const signed = tokenAuthenticate(req), user = signed || authenticate(req);
      if (!user) {
        if (req.method === 'GET' && url.pathname.endsWith('/review')) {
          res.writeHead(302, { location: '/_wp/login?next=' + encodeURIComponent(url.pathname + url.search), 'cache-control': 'no-store' }); res.end(); return true;
        }
        throw fail(401, '请先登录工作伙伴。');
      }
      if (!store.admin(user) && (user.backend !== 'aionui' || !/^[a-zA-Z0-9_-]+$/.test(user.slug))) throw fail(403, '请在新版工作伙伴中使用。');
      if (req.method === 'GET' && url.pathname.endsWith('/review')) {
        const name = url.searchParams.get('name'), id = url.searchParams.get('version');
        const source = store.source(user, name, id);
        const catalog = store.list(user);
        const info = [...catalog.pending, ...catalog.reviewed].find(v => v.name === name && v.version === id);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'referrer-policy': 'no-referrer' });
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>技能审批</title><style>body{max-width:768px;margin:32px auto;padding:16px;font:16px/1.6 system-ui}pre{white-space:pre-wrap}textarea{display:block;width:100%}.warning{color:#a22}</style><h1>${esc(info?.displayName || name)}</h1><p class="warning">${esc(info?.warnings.join('；') || '')}</p><p>含脚本 ${info?.scripts ?? 0} 个。技能以安装者身份运行。请查看附带文件后审批。</p><a href="/#/market">返回技能市场查看所有待审版本</a><pre>${esc(source)}</pre><form><label>拒绝原因<textarea name="reason" maxlength="1000"></textarea></label><button name="action" value="approve">批准</button> <button name="action" value="reject">拒绝</button> <button name="action" value="resend">重发审批卡片</button></form><p role="status"></p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const p=document.querySelector('[role=status]');try{const r=await fetch(${JSON.stringify(prefix)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:e.submitter.value,name:${JSON.stringify(name)},version:${JSON.stringify(id)},reason:e.target.reason.value})});const v=await r.json();p.textContent=r.ok?'已保存，请返回市场查看结果。':v.message}catch(e){p.textContent='结果未确认，请刷新市场核实。'}};</script></html>`);
        return true;
      }
      if (req.method === 'GET') { json(res, 200, store.list(user)); return true; }
      if (req.method !== 'POST') throw fail(405, '请使用 POST 操作。');
      if ((!signed && req.headers.origin !== origin) || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(403, '请从工作伙伴页面操作。');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fail(413, '请求过大。'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) { throw fail(400, '请求格式无效。'); }
      if (!body || typeof body.name !== 'string' || !NAME.test(body.name)) throw fail(400, '技能名称无效。');
      if (['submit', 'install'].includes(body.action) && (user.backend !== 'aionui' || !/^[a-zA-Z0-9_-]+$/.test(user.slug))) throw fail(403, '请先开通新版工作伙伴。');
      let result;
      if (body.action === 'submit') {
        const bundle = await execute(user, 'export', { name: body.name });
        if (bundle.error) throw fail(400, bundle.message);
        result = await store.submit(user, bundle, body);
      } else if (body.action === 'install') result = await store.install(user, body.name, execute);
      else if (body.action === 'uninstall') result = await store.uninstall(user, body.name, execute);
      else if (body.action === 'withdraw') result = await store.withdraw(user, body.name);
      else result = await store.review(user, body.name, body.version, body.action, body.reason);
      json(res, 200, result);
    } catch (error) { json(res, error.status || 503, { message: error.status ? error.message : '操作尚未确认完成，请刷新市场核实。' }); }
    return true;
  };
}

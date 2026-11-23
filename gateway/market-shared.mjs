/** Shared skill market: validation, review, immutable releases and live links. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const semver = {
  valid(value) {
    const text = String(value);
    if (!/^\d+\.\d+\.\d+$/.test(text)) return null;
    if (text.split('.').some(part => Number(part) > 0xffffff)) return null;
    return text;
  },
  gt(a, b) {
    const left = String(a).split('.').map(Number);
    const right = String(b).split('.').map(Number);
    for (let index = 0; index < 3; index++) {
      if (left[index] !== right[index]) return left[index] > right[index];
    }
    return false;
  },
};

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_LINE = 4000;
const MAX_CONTINUATIONS = 32;
const MAX_LOGICAL_LINE = 16000;

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
const trusted = domains => (Array.isArray(domains) ? domains : []).map(String).map(value => value.toLowerCase());
const isTrusted = (host, domains) => {
  const lower = String(host || '').toLowerCase();
  return domains.some(domain => lower === domain || lower.endsWith(`.${domain}`));
};
const finding = (file, line, rule, label, level) => ({ file, line, rule, label, level });

function logicalLines(source) {
  const physical = String(source).split(/\r?\n/);
  const result = [];
  for (let index = 0; index < physical.length; index++) {
    const firstLine = index + 1;
    let value = physical[index];
    let continuations = 0;
    while (/\\\s*$/.test(value) && index + 1 < physical.length
      && continuations < MAX_CONTINUATIONS && value.length < MAX_LOGICAL_LINE) {
      value = value.replace(/\\\s*$/, '') + physical[++index];
      continuations++;
    }
    result.push({ line: firstLine, text: value });
  }
  return result;
}

function scanContent(source, file = 'SKILL.md', domains = []) {
  const results = [];
  const domainList = trusted(domains);
  for (const { line, text: lineText } of logicalLines(source)) {
    if (lineText.length > MAX_LINE) {
      results.push(finding(file, line, 'long-line', '单行过长，需要人工审核', 'manual'));
      continue;
    }
    const credential = /(?:sk-|ghp_)[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:口令|密码|password|secret)\s*[:=：]\s*["']?[A-Za-z0-9!@#$%^&*_-]{6,}|(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])|(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/u;
    if (credential.test(lineText)) {
      results.push(finding(file, line, 'credential', '疑似密钥、口令或个人证件信息', 'block'));
    }

    const target = "(?:^|\\s)(?:/|/\\*|~/?(?:\\*|$)|\\$HOME|[\"']\\$HOME[\"']|\\$\\{HOME\\})(?:\\s|$)";
    const recursive = /(?:-rf|-fr|-r\s+-f|-f\s+-r|--recursive[^\n]{0,4000}--force|--force[^\n]{0,4000}--recursive)/;
    const dangerousDelete = new RegExp(`\\brm\\b[^\\n]{0,4000}(?:--no-preserve-root|${target})`, 'u').test(lineText)
      && recursive.test(lineText);
    const dangerous = dangerousDelete
      || /\bmkfs(?:\.[A-Za-z0-9_-]+)?\b/i.test(lineText)
      || /\bdd\b[^\n]{0,4000}\bof\s*=\s*\/dev\//i.test(lineText)
      || /\bDROP\s+DATABASE\b/i.test(lineText);
    if (dangerous) results.push(finding(file, line, 'dangerous-delete', '危险删除命令', 'block'));

    const downloadExecute = /\b(?:curl|wget)\b[^\n]{0,4000}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|perl)\b/i.test(lineText)
      || /(?:bash|sh)\s+<\(\s*(?:curl|wget)\b/i.test(lineText)
      || /(?:bash|sh)\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/i.test(lineText);
    if (downloadExecute) results.push(finding(file, line, 'download-execute', '下载后直接执行', 'block'));

    const urls = [...lineText.matchAll(/https?:\/\/([^\s/\])'">]+)/gi)];
    for (const match of urls) {
      const host = match[1].toLowerCase().replace(/:\d+$/, '');
      if (!isTrusted(host, domainList)) {
        results.push(finding(file, line, `external-link:${host}`, `外部链接 ${host}`, 'manual'));
      }
      const egress = /(?:\bcurl\b[^\n]{0,4000}(?:\s(?:-d|--data(?:-[^\s]+)?|-T|--upload-file|-F|--form)(?:\s|=)|\s-X\s*(?:POST|PUT)\b)|\bwget\b[^\n]{0,4000}(?:--post-data|--post-file|--body-)|\b(?:nc|ncat)\b|\b(?:scp|rsync)\b[^\n]{0,4000}\s[^\s:]+:[^\s]+)/i.test(lineText);
      if (egress && !isTrusted(host, domainList)) {
        results.push(finding(file, line, 'external-egress', '向外部发送数据', 'manual'));
      }
    }
    const remote = lineText.match(/\b(?:nc|ncat)\s+(?:[^\s]+\s+)?([A-Za-z0-9.-]+)(?::\d+)?\b/i)?.[1]
      || lineText.match(/\b(?:scp|rsync)\b[^\n]{0,4000}\s([A-Za-z0-9.-]+):[^\s]+/i)?.[1];
    if (remote && !isTrusted(remote, domainList)) {
      results.push(finding(file, line, 'external-egress', '向外部发送数据', 'manual'));
    }

    const internal = /(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/i.test(lineText)
      || /https?:\/\/[^\s/]+\.(?:internal|local|corp)(?:[./:\s]|$)/i.test(lineText)
      || /(?:\/Users\/|\/home\/|\/data\/|\/srv\/|[A-Za-z]:\\)/.test(lineText);
    if (internal) {
      const hosts = [...lineText.matchAll(/https?:\/\/([^\s/\])'">]+)/gi)]
        .map(match => match[1].toLowerCase().replace(/:\d+$/, ''));
      if (!hosts.length || hosts.some(host => !isTrusted(host, domainList))) {
        results.push(finding(file, line, 'internal-path', '内部地址或本机路径', 'manual'));
      }
    }
  }
  return results;
}

function findingMessage(findings) {
  const first = findings.slice(0, 5).map(item => `${item.file} 第 ${item.line} 行：${item.label}`);
  return first.join('；') + (findings.length > 5 ? `；等 ${findings.length - 5} 处` : '');
}

function scriptFile(file) {
  const source = file.content.toString('utf8');
  return Boolean(file.executable) || /\.(?:py|sh|bash|js|mjs|cjs|ts|ps1|bat|cmd|rb|pl)$/i.test(file.path)
    || source.startsWith('#!') || file.path.startsWith('scripts/');
}

function scriptManifest(files) {
  return files.filter(scriptFile).map(file => ({
    path: file.path,
    digest: crypto.createHash('sha256').update(file.content).digest('hex'),
  }));
}

function storedScriptManifest(stateDir, name, version) {
  if (Array.isArray(version.scriptFiles)) return version.scriptFiles;
  const root = path.join(stateDir, 'submissions', name, version.id);
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else {
        const relative = path.relative(root, filename);
        const content = fs.readFileSync(filename);
        const stat = fs.statSync(filename);
        if (scriptFile({ path: relative, content, executable: Boolean(stat.mode & 0o111) })) {
          files.push({ path: relative, digest: crypto.createHash('sha256').update(content).digest('hex') });
        }
      }
    }
  };
  visit(root);
  return files;
}

function scriptsChanged(stateDir, name, live, files) {
  if (!live) return false;
  const previous = new Map(storedScriptManifest(stateDir, name, live).map(item => [item.path, item.digest]));
  return scriptManifest(files).some(item => !previous.has(item.path) || previous.get(item.path) !== item.digest);
}

export function inspectSkill(bundle, protectedNames = [], reservedPrefixes = [], displayName = '', trustedDomains = []) {
  if (!bundle || typeof bundle.name !== 'string' || !NAME.test(bundle.name) || protectedNames.includes(bundle.name)) {
    throw fail(400, '技能名称无效或与预装技能重名。');
  }
  if (reservedPrefixes.some(prefix => bundle.name.startsWith(prefix) || displayName.startsWith(prefix))) {
    throw fail(400, '这个名称前缀留给官方技能。');
  }
  if (!text(bundle.description, 4000) || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 200) {
    throw fail(400, '技能说明或文件数量无效。');
  }
  const seen = new Set();
  const files = [];
  const findings = [];
  const warnings = new Set();
  let size = 0;
  let scripts = 0;
  for (const file of bundle.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.length > 512
      || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))
      || seen.has(file.path)) {
      throw fail(400, '技能包含无效或重复的文件路径。');
    }
    if (typeof file.content !== 'string' || file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) {
      throw fail(400, '技能文件无法读取。');
    }
    const content = Buffer.from(file.content, 'base64');
    size += content.length;
    if (size > 10 * 1024 * 1024) throw fail(413, '分享的技能总计不能超过 10 MB。');
    const source = content.toString('utf8');
    const rows = scanContent(source, file.path, trustedDomains);
    findings.push(...rows);
    if (rows.some(item => item.rule === 'internal-path')) warnings.add('含内部地址或本机路径，请核对是否已换成占位说明。');
    const normalized = { path: file.path, content, executable: Boolean(file.executable) };
    if (scriptFile(normalized)) scripts++;
    seen.add(file.path);
    files.push(normalized);
  }
  if (!seen.has('SKILL.md')) throw fail(400, '技能缺少 SKILL.md。');
  const blocks = findings.filter(item => item.level === 'block');
  if (blocks.length) throw fail(400, `${findingMessage(blocks)}。`, { findings: blocks });
  return { files, findings, warnings: [...warnings], scripts, scriptFiles: scriptManifest(files) };
}

export function createSharedSkillStore({
  stateDir,
  sharedDir,
  approvers = [],
  reservedPrefixes = [],
  protectedNames = [],
  trustedDomains = [],
  notify = async () => {},
  notifyAuthor = async () => {},
  createReviewToken,
  verifyReviewToken,
}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const directory of [sharedDir, path.join(sharedDir, 'live'), path.join(sharedDir, 'releases')]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.chmodSync(directory, 0o755);
  }
  const stateFile = path.join(stateDir, 'catalog.json');
  let state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : { version: 1, skills: {} };
  if (state.version !== 1 || !state.skills || Array.isArray(state.skills)) throw new Error('Unsupported skill market state');

  let queue = Promise.resolve();
  const serial = work => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const keyedQueues = new Map();
  const keyedSerial = (key, work) => {
    const result = (keyedQueues.get(key) || Promise.resolve()).then(work);
    const settled = result.catch(() => {});
    keyedQueues.set(key, settled);
    void settled.then(() => {
      if (keyedQueues.get(key) === settled) keyedQueues.delete(key);
    });
    return result;
  };
  function save() {
    const temporary = `${stateFile}.${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, stateFile);
    } catch (error) {
      state = fs.existsSync(stateFile)
        ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        : { version: 1, skills: {} };
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const admin = user => approvers.includes(user?.unionId);
  const get = name => {
    if (!NAME.test(name) || !Object.hasOwn(state.skills, name)) throw fail(404, '没有找到这个技能。');
    return state.skills[name];
  };
  const versionOf = (row, id, message = '没有找到这个版本。') => {
    if (!row || typeof id !== 'string' || !Object.hasOwn(row.versions, id)) throw fail(404, message);
    return row.versions[id];
  };
  function release(name, id) {
    const target = path.join(sharedDir, 'releases', name, id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.chmodSync(path.dirname(target), 0o755);
    if (!fs.existsSync(target)) {
      const stage = `${target}.${crypto.randomUUID()}`;
      try {
        fs.cpSync(path.join(stateDir, 'submissions', name, id), stage, { recursive: true });
        const readable = directory => {
          fs.chmodSync(directory, 0o755);
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) readable(file);
            else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o755 : 0o644);
          }
        };
        readable(stage);
        fs.renameSync(stage, target);
      } finally {
        fs.rmSync(stage, { force: true, recursive: true });
      }
    }
    if (!fs.existsSync(path.join(target, 'SKILL.md'))) throw new Error('Approved skill release is missing');
    return target;
  }
  const unavailable = new Set();
  function reconcile(name) {
    const row = get(name);
    const link = path.join(sharedDir, 'live', name);
    if (!row.live) {
      fs.rmSync(link, { force: true });
      return;
    }
    const target = release(name, row.live);
    const temporary = `${link}.${crypto.randomUUID()}`;
    try {
      fs.symlinkSync(path.relative(path.dirname(link), target), temporary);
      fs.renameSync(temporary, link);
      unavailable.delete(name);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  let stale = 0;
  for (const [name, row] of Object.entries(state.skills)) {
    const live = row.live && Object.hasOwn(row.versions, row.live) ? row.versions[row.live] : null;
    if (live?.status === 'approved') {
      for (const version of Object.values(row.versions)) {
        if (version.status === 'pending' && version.createdAt < live.createdAt) {
          version.status = 'superseded';
          version.supersededBy = live.id;
          version.supersededAt = new Date().toISOString();
          stale++;
        }
      }
    }
    try {
      reconcile(name);
    } catch (error) {
      unavailable.add(name);
      console.warn(`[skill-market] ${name}: release unavailable (${error.code || error.message}); skipped, gateway startup continues`);
    }
  }
  if (stale) {
    save();
    console.warn(`[skill-market] superseded ${stale} stale pending versions`);
  }

  const summary = (name, row, version) => ({
    name,
    version: version.id,
    displayName: version.displayName,
    description: version.description,
    example: version.example,
    author: row.authorName,
    installs: row.installs,
    status: version.status,
    reason: version.reason || '',
    warnings: version.warnings || [],
    scripts: version.scripts || 0,
    reviewNotice: version.reviewNotice,
    authorNotice: version.authorNotice,
    createdAt: version.createdAt,
    semver: version.semver || '',
    currentSemver: row.live && Object.hasOwn(row.versions, row.live) ? row.versions[row.live]?.semver || '' : '',
    hasLive: Boolean(row.live),
    autoPublished: version.reviewer === 'auto',
    manualReasons: version.manualReasons || [],
    findings: version.findings || [],
    supersededBy: version.supersededBy,
  });

  async function sendReview(name, id) {
    const request = await serial(() => {
      const row = state.skills[name];
      if (!row) return null;
      const version = versionOf(row, id);
      const noticeId = crypto.randomUUID();
      version.reviewNoticeId = noticeId;
      delete version.reviewNotice;
      save();
      const reviewToken = createReviewToken?.(name, id, 'approve', noticeId);
      return { noticeId, payload: { ...summary(name, row, version), approvers, reviewToken } };
    });
    if (!request) return;
    let notice = 'sent';
    try {
      await notify(request.payload);
    } catch {
      notice = 'failed';
    }
    await serial(() => {
      const row = state.skills[name];
      let version;
      try { version = versionOf(row, id); } catch { return; }
      if (version.reviewNoticeId !== request.noticeId) return;
      version.reviewNotice = notice;
      save();
    });
  }

  async function sendAuthor(name, id) {
    const request = await serial(() => {
      const row = state.skills[name];
      if (!row) return null;
      const version = versionOf(row, id);
      const noticeId = crypto.randomUUID();
      version.authorNoticeId = noticeId;
      delete version.authorNotice;
      save();
      return { noticeId, payload: { ...summary(name, row, version), unionId: row.author } };
    });
    if (!request) return;
    let notice = 'sent';
    try {
      await notifyAuthor(request.payload);
    } catch {
      notice = 'failed';
    }
    await serial(() => {
      const row = state.skills[name];
      let version;
      try { version = versionOf(row, id); } catch { return; }
      if (version.authorNoticeId !== request.noticeId) return;
      version.authorNotice = notice;
      save();
    });
  }

  function newer(a, b) {
    return a?.semver && b?.semver ? semver.gt(a.semver, b.semver) : a.createdAt > b.createdAt;
  }

  function publish(name, id, reviewer) {
    const row = get(name);
    const version = versionOf(row, id);
    release(name, id);
    if (!row.live || newer(version, versionOf(row, row.live))) row.live = id;
    version.status = 'approved';
    version.reviewedAt = new Date().toISOString();
    version.reviewer = reviewer;
    version.reason = '';
    for (const old of Object.values(row.versions)) {
      if (old.id !== id && old.status === 'pending' && old.createdAt < version.createdAt) {
        old.status = 'superseded';
        old.supersededBy = id;
        old.supersededAt = new Date().toISOString();
      }
    }
    save();
    reconcile(name);
    return { row, version, notice: 'author' };
  }

  return {
    admin,
    list(user) {
      const company = [];
      const mine = [];
      const pending = [];
      const reviewed = [];
      for (const [name, row] of Object.entries(state.skills)) {
        if (row.live && !unavailable.has(name)) {
          const live = versionOf(row, row.live);
          company.push({ ...summary(name, row, live), canWithdraw: admin(user) || row.author === user.unionId });
        }
        for (const version of Object.values(row.versions)) {
          if (row.author === user.unionId) mine.push(summary(name, row, version));
          if (admin(user) && version.status !== 'pending') reviewed.push(summary(name, row, version));
          if (admin(user) && version.status === 'pending') pending.push(summary(name, row, version));
        }
      }
      return {
        company: company.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name)),
        mine,
        pending,
        reviewed,
        isApprover: admin(user),
        submissionsEnabled: approvers.length > 0,
      };
    },
    async submit(user, bundle, meta) {
      const name = bundle?.name;
      const outcome = await serial(async () => {
        if (!approvers.length) throw fail(403, '管理员尚未开放技能分享。');
        if (!text(meta.displayName, 80) || !text(meta.description, 300) || !text(meta.example, 500)) {
          throw fail(400, '请填写技能中文名、一句话说明和一个例句。');
        }
        const hasSemver = meta.semver !== undefined;
        if (hasSemver && (typeof meta.semver !== 'string' || !/^\d+\.\d+\.\d+$/.test(meta.semver)
          || meta.semver.split('.').some(part => part.length > 6 || (part.length > 1 && part.startsWith('0')))
          || !semver.valid(meta.semver))) {
          throw fail(400, '版本号格式应为 1.2.3');
        }
        let checked;
        try {
          checked = inspectSkill(bundle, protectedNames, reservedPrefixes, meta.displayName, trustedDomains);
        } catch (error) {
          if (error.findings) throw fail(400, `${findingMessage(error.findings)}。`, { findings: error.findings });
          throw error;
        }
        const formFindings = scanContent(
          [name, meta.displayName, meta.description, meta.example].join('\n'),
          '表单信息',
          trustedDomains,
        );
        checked.findings.push(...formFindings);
        if (formFindings.some(item => item.rule === 'internal-path')) {
          checked.warnings.push('含内部地址或本机路径，请核对是否已换成占位说明。');
        }
        checked.warnings = [...new Set(checked.warnings)];
        const blocks = checked.findings.filter(item => item.level === 'block');
        if (blocks.length) throw fail(400, `${findingMessage(blocks)}。`, { findings: blocks });

        const old = Object.hasOwn(state.skills, name) ? state.skills[name] : undefined;
        if (old && old.author !== user.unionId) throw fail(409, '这个名称已由其他作者使用，请改名。');
        if (hasSemver) {
          const versions = old
            ? Object.values(old.versions).filter(version => ['approved', 'pending', 'withdrawn'].includes(version.status))
            : [];
          const maximum = versions.reduce((current, version) => {
            const candidate = version.semver || '0.0.0';
            return semver.gt(candidate, current) ? candidate : current;
          }, '0.0.0');
          if (!semver.gt(meta.semver, maximum)) throw fail(400, `版本号需大于已有的 ${maximum}`);
        }
        const digestData = {
          displayName: meta.displayName,
          description: meta.description,
          example: meta.example,
          files: bundle.files,
        };
        if (hasSemver) digestData.semver = meta.semver;
        const digest = crypto.createHash('sha256').update(JSON.stringify(digestData)).digest('hex');
        const duplicate = old && Object.values(old.versions)
          .find(version => version.digest === digest && ['pending', 'approved'].includes(version.status));
        if (duplicate) return { row: old, version: duplicate, notify: false, auto: false };

        const id = crypto.randomUUID();
        const location = path.join(stateDir, 'submissions', name, id);
        fs.mkdirSync(location, { recursive: true });
        for (const file of checked.files) {
          const target = path.join(location, file.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, file.content, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
        }
        const row = old || { author: user.unionId, authorName: user.name || name, installs: 0, live: null, versions: {} };
        const currentLive = row.live && Object.hasOwn(row.versions, row.live) ? row.versions[row.live] : null;
        const manualReasons = [];
        if (!old || currentLive?.status !== 'approved') manualReasons.push({ rule: 'first-submission', label: '首次分享需人工审批' });
        if (!hasSemver) manualReasons.push({ rule: 'no-semver', label: '未填写版本号' });
        if (currentLive && scriptsChanged(stateDir, name, currentLive, checked.files)) {
          manualReasons.push({ rule: 'scripts-changed', label: '脚本有改动，需要人工审核' });
        }
        manualReasons.push(...checked.findings.filter(item => item.level === 'manual'));
        const version = {
          id,
          digest,
          displayName: meta.displayName,
          description: meta.description,
          example: meta.example,
          warnings: checked.warnings,
          findings: checked.findings,
          manualReasons,
          scripts: checked.scripts,
          scriptFiles: checked.scriptFiles,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        if (hasSemver) version.semver = meta.semver;
        row.versions[id] = version;
        state.skills[name] = row;
        save();
        const auto = manualReasons.length === 0;
        if (auto) publish(name, id, 'auto');
        return { row, version, notify: true, auto };
      });
      if (outcome.notify) {
        if (outcome.auto) await sendAuthor(name, outcome.version.id);
        else {
          await sendReview(name, outcome.version.id);
          if (outcome.row.live) await sendAuthor(name, outcome.version.id);
        }
      }
      return serial(() => summary(name, state.skills[name], versionOf(state.skills[name], outcome.version.id)));
    },
    async review(user, name, id, action, reason = '') {
      const outcome = await serial(async () => {
        if (!admin(user)) throw fail(403, '只有配置的审批人可以审批。');
        const row = get(name);
        const version = versionOf(row, id);
        if (!['approve', 'reject', 'resend', 'notify-author'].includes(action)) throw fail(400, '审批参数无效。');
        if (action === 'notify-author') {
          if (version.status === 'pending') throw fail(409, '请先完成审批。');
          return { row, version, notice: 'author' };
        }
        if (action === 'resend') {
          if (version.status !== 'pending') throw fail(409, '这个版本已经审批。');
          return { row, version, notice: 'review' };
        }
        if (version.status !== 'pending') {
          const status = {
            approved: '已通过', rejected: '未通过', withdrawn: '已下架', superseded: '已被新版替代',
          }[version.status] || version.status;
          throw fail(409, `这个版本当前状态为“${status}”，不能重复审批，请刷新市场查看。`);
        }
        if (action === 'reject' && !text(reason, 1000)) throw fail(400, '拒绝时请填写原因。');
        if (action === 'approve') return publish(name, id, user.unionId);
        version.status = 'rejected';
        version.reason = reason;
        version.reviewedAt = new Date().toISOString();
        version.reviewer = user.unionId;
        save();
        return { row, version, notice: 'author' };
      });
      if (outcome.notice === 'review') await sendReview(name, id);
      else if (outcome.notice === 'author') await sendAuthor(name, id);
      return serial(() => summary(name, state.skills[name], versionOf(state.skills[name], id)));
    },
    withdraw(user, name) {
      return serial(() => {
        const row = get(name);
        if (!admin(user) && row.author !== user.unionId) throw fail(403, '只有作者或审批人可以下架。');
        row.live = null;
        for (const version of Object.values(row.versions)) {
          if (['approved', 'pending'].includes(version.status)) version.status = 'withdrawn';
        }
        save();
        reconcile(name);
        return { name };
      });
    },
    install(user, name, execute) {
      return keyedSerial(`${user.slug}:${name}`, async () => {
        await serial(async () => {
          const row = get(name);
          if (!row.live) throw fail(404, '这个技能已经下架。');
          reconcile(name);
        });
        const result = await execute(user, 'shared-install', { name });
        if (result.error) {
          throw Object.assign(
            fail(result.error === 'not_found' ? 404 : 409, result.error === 'not_found' ? '这个技能已经下架。' : result.message),
            { code: result.error },
          );
        }
        await serial(() => {
          if (result.changed && Object.hasOwn(state.skills, name)) {
            state.skills[name].installs++;
            save();
          }
        });
        return { name, installed: true, changed: Boolean(result.changed) };
      });
    },
    uninstall(user, name, execute) {
      return keyedSerial(`${user.slug}:${name}`, async () => {
        const result = await execute(user, 'delete', { name });
        if (!result.error && result.shared && Object.hasOwn(state.skills, name)) {
          await serial(() => {
            state.skills[name].installs = Math.max(0, state.skills[name].installs - 1);
            save();
          });
        }
        return { ...result, installed: false };
      });
    },
    source(user, name, id) {
      if (!admin(user)) throw fail(403, '只有审批人可以查看待审内容。');
      const row = get(name);
      versionOf(row, id);
      const root = path.join(stateDir, 'submissions', name, id);
      const sections = [];
      const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file);
          else sections.push(`--- ${path.relative(root, file)} ---\n${fs.readFileSync(file, 'utf8')}`);
        }
      };
      visit(root);
      return sections.join('\n\n');
    },
    verifyReviewToken,
    reviewToken(token, name, id) {
      let row;
      try { row = get(name); } catch { return null; }
      let version;
      try { version = versionOf(row, id); } catch { return null; }
      const claims = verifyReviewToken?.(token, name, id, 'approve', version.reviewNoticeId);
      if (!claims || claims.name !== name || claims.id !== id || claims.action !== 'approve') return null;
      return { processed: version.status !== 'pending', version, claims };
    },
  };
}

/** Cookie callers require same-origin JSON; signed container callers use the same routes and review policy. */
export function createSharedSkillsHandler({ store, authenticate, tokenAuthenticate, origin, execute }) {
  const prefix = '/_wp/market/shared';
  const json = (res, status, data) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(data));
  };
  const html = (res, body) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': [
        "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
        "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'",
      ].join('; '),
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  };
  return async (req, res, url) => {
    if (url.pathname !== prefix && url.pathname !== `${prefix}/review`) return false;
    const started = Date.now();
    let action = req.method === 'GET' ? 'list' : 'unknown';
    let skillName = url.searchParams.get('name') || undefined;
    let actor;
    const logError = (error, status) => {
      const httpStatus = Number.isInteger(status) ? status : 503;
      const unknown = !Number.isInteger(error?.status);
      const entry = {
        event: 'market_shared_error',
        action,
        name: typeof skillName === 'string' && NAME.test(skillName) ? skillName : undefined,
        status: httpStatus,
        code: unknown ? (error?.name || 'Error') : (error?.code || `HTTP_${httpStatus}`),
        message: unknown ? undefined : String(error?.message || '操作失败').slice(0, 300),
        durationMs: Date.now() - started,
        user: actor,
      };
      (httpStatus >= 400 && httpStatus < 500 ? console.warn : console.error)(JSON.stringify(entry));
    };
    try {
      const signed = tokenAuthenticate(req);
      const user = signed || authenticate(req);
      actor = user?.slug;
      if (!user) {
        if (req.method === 'GET' && url.pathname.endsWith('/review')) {
          res.writeHead(302, {
            location: '/_wp/login?next=' + encodeURIComponent(url.pathname + url.search),
            'cache-control': 'no-store',
          });
          res.end();
          return true;
        }
        throw fail(401, '请先登录工作伙伴。');
      }
      if (!store.admin(user) && (user.backend !== 'aionui' || !/^[a-zA-Z0-9_-]+$/.test(user.slug))) {
        throw fail(403, '请在新版工作伙伴中使用。');
      }
      if (req.method === 'GET' && url.pathname.endsWith('/review')) {
        const name = url.searchParams.get('name');
        const id = url.searchParams.get('version');
        const requested = url.searchParams.get('action');
        const token = url.searchParams.get('t');
        if (requested === 'approve' && token && !store.admin(user)) throw fail(403, '只有配置的审批人可以审批。');
        if (requested === 'approve' && token && store.admin(user)) {
          const checked = store.reviewToken?.(token, name, id);
          if (checked?.processed) {
            html(res, `<!doctype html><meta charset="utf-8"><title>审批完成</title><h1>这个版本已处理：${esc(checked.version?.status || '')}</h1>`);
            return true;
          }
          if (checked?.claims) {
            const result = await store.review(user, name, id, 'approve');
            html(res, `<!doctype html><meta charset="utf-8"><title>审批完成</title><h1>已批准并发布 ${esc(result.semver ? `v${result.semver}` : '未标注')}</h1>`);
            return true;
          }
        }
        const source = store.source(user, name, id);
        const catalog = store.list(user);
        const info = [...catalog.pending, ...catalog.reviewed].find(item => item.name === name && item.version === id);
        const hint = requested === 'approve' ? '链接已失效或需要确认，请在下方操作' : '';
        const reasons = [...(info?.manualReasons || []), ...(info?.findings || []).filter(item => item.level === 'manual')]
          .map(item => `<li>${esc(item.file ? `${item.file} 第 ${item.line} 行：${item.label}` : `${item.rule}：${item.label}`)}</li>`)
          .join('');
        const live = catalog.company.find(item => item.name === name);
        const formName = JSON.stringify(name);
        const formVersion = JSON.stringify(id);
        const reviewScript = `<script>
          document.querySelector('form').onsubmit = async event => {
            event.preventDefault();
            const status = document.querySelector('[role=status]');
            try {
              const response = await fetch(${JSON.stringify(prefix)}, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: event.submitter.value,
                  name: ${formName},
                  version: ${formVersion},
                  reason: event.target.reason.value,
                }),
              });
              const result = await response.json();
              status.textContent = response.ok ? '已保存，请返回市场查看结果。' : result.message;
            } catch {
              status.textContent = '结果未确认，请刷新市场核实。';
            }
          };
        </script>`;
        const body = [
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>技能审批</title>',
          '<style>body{max-width:768px;margin:32px auto;padding:16px;font:16px/1.6 system-ui}',
          'pre{white-space:pre-wrap}textarea{display:block;width:100%;min-height:8em}.warning{color:#a22}</style>',
          `<h1>${esc(info?.displayName || name)}</h1><p class="warning">${esc(hint)}</p>`,
          `<p>版本：${esc(info?.semver ? `v${info.semver}` : '未标注')}；当前上架：${esc(live?.semver ? `v${live.semver}` : '未标注')}</p>`,
          `<ul>${reasons}</ul><p>含脚本 ${info?.scripts ?? 0} 个。技能以安装者身份运行。请查看附带文件后审批。</p>`,
          '<a href="/#/market">返回技能市场查看所有待审版本</a>',
          `<pre>${esc(source)}</pre>`,
          '<form><label for="reason">拒绝原因</label>',
          `<textarea id="reason" name="reason" maxlength="1000" ${requested === 'reject' ? 'autofocus' : ''}></textarea>`,
          '<button name="action" value="approve">批准</button> <button name="action" value="reject">拒绝</button>',
          '<button name="action" value="resend">重发审批卡片</button></form><p role="status"></p>',
          `${reviewScript}</html>`,
        ].join('');
        html(res, body);
        return true;
      }
      if (req.method === 'GET') {
        json(res, 200, store.list(user));
        return true;
      }
      if (req.method !== 'POST') {
        json(res, 405, { message: '请求方法不支持。' });
        return true;
      }
      if (!signed && req.headers.origin !== origin) throw fail(403, '请求来源不受信任。');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '请求必须使用 JSON。');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (size > 16384) throw fail(413, '请求过大。');
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw fail(400, '请求格式无效。');
      }
      if (!body || typeof body.name !== 'string' || !NAME.test(body.name)) throw fail(400, '技能名称无效。');
      skillName = body.name;
      action = ['install', 'uninstall', 'withdraw', 'approve', 'reject', 'resend', 'notify-author', 'submit'].includes(body.action)
        ? body.action : 'unknown';
      if (['submit', 'install'].includes(body.action) && (user.backend !== 'aionui' || !/^[a-zA-Z0-9_-]+$/.test(user.slug))) {
        throw fail(403, '请先开通新版工作伙伴。');
      }
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
    } catch (error) {
      const status = error.status || 503;
      logError(error, status);
      json(res, status, {
        message: error.status ? error.message : '操作尚未确认完成，请刷新市场核实。',
        ...(error.findings ? { findings: error.findings } : {}),
      });
    }
    return true;
  };
}

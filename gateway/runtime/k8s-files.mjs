import { workspaceName } from './k8s-exec.mjs';

const defaultPublishedFiles = ['.zp-market-token', '.wp-feishu-cli.json', '.zp-preview-relay-key'];
const defaultLeaseTtlMs = 30 * 60 * 1000;
// Docker reads have no cap. Limit K1 output to 16 MiB, including base64 and JSON overhead.
const maxReadOutputBytes = 16 * 1024 * 1024;

function parts(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid runtime path');
  return value.split('/');
}

// This function is serialized as a fixed program. File names and contents only arrive on stdin.
function fileWorker(validatePath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { spawn } = require('node:child_process');
  const root = process.argv[1];
  const control = process.argv[2];
  const safeError = error => ({ error: /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'EIO' });
  const source = `(${fileWorker.toString()})(${validatePath.toString()})`;
  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  async function response(filename) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await pause();
    }
    throw Object.assign(new Error(), { code: 'ETIMEDOUT' });
  }

  async function operate(request, holder = false) {
    for (const file of request.files || []) validatePath(file.path);
    for (const directory of request.directories || []) validatePath(directory.path);
    for (const filename of request.paths || []) validatePath(filename);
    for (const filename of request.cleanup || []) validatePath(filename);
    if (request.filename !== undefined) validatePath(request.filename);
    if (request.lease !== undefined && !/^\/tmp\/wp-runtime-[a-f0-9]{32}$/.test(request.lease)) throw new Error('Invalid file lease');
    if (request.operation === 'release') {
      if (!request.lease) throw new Error('Invalid file lease');
      const fd = fs.openSync(request.lease, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const directory = `/proc/self/fd/${fd}`;
      try {
        try { fs.writeFileSync(`${directory}/release`, '', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const result = await response(`${directory}/done`);
        fs.rmSync(request.lease, { recursive: true, force: true });
        return result;
      } finally { fs.closeSync(fd); }
    }
    if (request.operation === 'put' && request.cleanup && !holder) {
      // A separate process retains directory descriptors across exec calls, just like the Docker lease.
      const directory = `/tmp/wp-runtime-${crypto.randomBytes(16).toString('hex')}`;
      fs.mkdirSync(directory, { mode: 0o700 });
      let input, output, child;
      try {
        fs.writeFileSync(`${directory}/input`, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
        input = fs.openSync(`${directory}/input`, 'r');
        output = fs.openSync(`${directory}/ready`, 'wx', 0o600);
        child = spawn(process.execPath, ['-e', source, root, directory], { detached: true, stdio: [input, output, 'ignore'] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const result = await response(`${directory}/ready`);
        fs.unlinkSync(`${directory}/input`);
        fs.unlinkSync(`${directory}/ready`);
        if (result.error) fs.rmSync(directory, { recursive: true, force: true });
        child.unref();
        return result;
      } catch (error) {
        child?.kill();
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      } finally {
        if (input !== undefined) fs.closeSync(input);
        if (output !== undefined) fs.closeSync(output);
      }
    }
    const handles = [], locations = new Map();
    let retained = false;
    const close = () => { for (const fd of handles.reverse()) fs.closeSync(fd); handles.length = 0; };
    function openDirectory(destination) {
      if (!fs.lstatSync(destination).isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
      const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      handles.push(fd);
      return `/proc/self/fd/${fd}`;
    }
    function parent(segments, create = false) {
      let current = locations.get(''), relative = '';
      for (const segment of segments) {
        relative += (relative ? '/' : '') + segment;
        if (locations.has(relative)) { current = locations.get(relative); continue; }
        const destination = path.join(current, segment);
        if (create) {
          const spec = request.directories?.find(item => item.path === relative);
          try { fs.mkdirSync(destination, { mode: spec?.mode ?? 0o700 }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        current = openDirectory(destination);
        locations.set(relative, current);
      }
      return current;
    }
    function cleanup() {
      for (const filename of request.cleanup || []) {
        const segments = validatePath(filename), name = segments.pop();
        const directory = locations.get(segments.join('/'));
        if (directory) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
      }
    }
    try {
      locations.set('', openDirectory(root));
      if (request.operation === 'put') {
        for (const file of request.files) {
          const segments = validatePath(file.path), name = segments.pop();
          const directory = parent(segments, true);
          const temporary = path.join(directory, `.runtime-${crypto.randomBytes(12).toString('hex')}`);
          try {
            const fd = fs.openSync(temporary, 'wx', file.mode ?? 0o600);
            try { fs.writeFileSync(fd, Buffer.from(file.content, 'base64')); } finally { fs.closeSync(fd); }
            fs.renameSync(temporary, path.join(directory, name));
          } finally { fs.rmSync(temporary, { force: true }); }
        }
        if (holder) {
          const directory = openDirectory(control);
          let released = false;
          const release = (expired = false) => {
            if (released) return;
            released = true;
            clearInterval(timer);
            clearTimeout(expiry);
            let result = {};
            try { cleanup(); } catch (error) { result = safeError(error); }
            try {
              if (expired) fs.rmSync(control, { recursive: true, force: true });
              else fs.writeFileSync(`${directory}/done`, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
            }
            finally { close(); }
          };
          const timer = setInterval(() => {
            if (fs.existsSync(`${directory}/release`)) release();
          }, 200);
          const expiry = setTimeout(() => release(true), request.leaseTtlMs);
          for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { release(true); process.exit(); });
          retained = true;
          return { lease: control };
        }
        return {};
      }
      if (request.operation === 'read') {
        const segments = validatePath(request.filename), name = segments.pop();
        const fd = fs.openSync(path.join(parent(segments), name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile()) throw Object.assign(new Error(), { code: stat.isDirectory() ? 'EISDIR' : 'EINVAL' });
          return { content: fs.readFileSync(fd).toString('base64') };
        } finally { fs.closeSync(fd); }
      }
      if (request.operation === 'remove') {
        for (const filename of request.paths) {
          const segments = validatePath(filename), name = segments.pop();
          try { fs.rmSync(path.join(parent(segments), name), { recursive: true, force: true }); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return {};
      }
      throw new Error('Invalid file operation');
    } finally {
      if (!retained) {
        try { cleanup(); } finally {
          close();
          if (request.operation === 'remove' && request.lease) fs.rmSync(request.lease, { recursive: true, force: true });
        }
      }
    }
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    let result;
    try { result = await operate(JSON.parse(input), !!control); } catch (error) { result = safeError(error); }
    process.stdout.write(JSON.stringify(result));
  });
}

const fileScript = `(${fileWorker.toString()})(${parts.toString()})`;

/** exec is the slug-based method from createK8sExec; client follows the K1 REST interface. */
export function createK8sFiles({ client, exec, namespace, containerPrefix, userLabel = 'workpartner.next-user',
  publishedFiles = defaultPublishedFiles, cacheMs = 2000, now = Date.now, leaseTtlMs = defaultLeaseTtlMs } = {}) {
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0 || leaseTtlMs > 2147483647) throw new Error('Invalid file lease lifetime');
  const published = new Set(publishedFiles), cache = new Map(), versions = new Map(), leases = new WeakMap();
  for (const filename of published) {
    if (parts(filename).length !== 1 || !/^[a-zA-Z0-9._-]+$/.test(filename)) throw new Error('Invalid published file');
  }
  const collection = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`;
  const secretName = slug => `${workspaceName(slug, containerPrefix)}-published`;
  const route = slug => `${collection}/${encodeURIComponent(secretName(slug))}`;
  function invalidate(slug) { cache.delete(slug); versions.set(slug, (versions.get(slug) || 0) + 1); }
  async function secret(slug) {
    const cached = cache.get(slug);
    if (cached && cached.expires > now()) return cached.value;
    const version = versions.get(slug);
    const value = await client.get(route(slug));
    if (version === versions.get(slug)) cache.set(slug, { value, expires: now() + cacheMs });
    return value;
  }
  async function patch(slug, data, create) {
    invalidate(slug);
    try {
      if (!await client.get(route(slug))) {
        if (!create) return;
        try {
          await client.create(collection, { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: {
            name: secretName(slug), namespace,
            labels: { 'app.kubernetes.io/part-of': 'workpartner', 'workpartner/role': 'user', [userLabel]: slug },
          }, data: {} });
        } catch (error) { if (error.reason !== 'AlreadyExists') throw error; }
      }
      await client.patch(route(slug), { data }, 'merge');
    } finally { invalidate(slug); }
  }
  async function run(slug, request) {
    const result = await exec(slug, ['node', '-e', fileScript, '/data'], {
      stdin: JSON.stringify(request), strictOutput: true,
      ...(request.operation === 'read' ? { maxOutputBytes: maxReadOutputBytes } : {}),
    });
    if (result.exitCode !== 0) throw new Error('Runtime file operation failed');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new Error('Invalid runtime file response'); }
    if (!response || typeof response !== 'object') throw new Error('Invalid runtime file response');
    if (response.error) {
      const code = /^[A-Z][A-Z0-9_]+$/.test(response.error) ? response.error : 'EIO';
      throw Object.assign(new Error(`Runtime file operation failed: ${code}`), { code });
    }
    return response;
  }
  async function release(slug, control, paths) {
    try { await run(slug, { operation: 'release', lease: control }); }
    catch {
      // A killed or expired holder cannot acknowledge release. Cleanup must not mask installation results.
      try { await run(slug, { operation: 'remove', paths, lease: control }); } catch { /* Best effort after lease loss. */ }
    }
  }
  async function putFiles(slug, files, options = {}) {
    workspaceName(slug, containerPrefix);
    for (const file of files) parts(file.path);
    for (const directory of options.directories || []) parts(directory.path);
    for (const filename of options.cleanup || []) parts(filename);
    const data = Object.create(null), ordinary = [];
    for (const file of files) {
      const content = Buffer.from(file.content).toString('base64');
      if (published.has(file.path)) data[file.path] = content;
      else ordinary.push({ path: file.path, content, mode: file.mode });
    }
    const cleanup = options.cleanup?.filter(filename => !published.has(filename));
    let response;
    try {
      if (ordinary.length || cleanup?.length) response = await run(slug, {
        operation: 'put', files: ordinary, directories: options.directories || [], ...(cleanup?.length ? { cleanup, leaseTtlMs } : {}),
      });
      if (Object.keys(data).length) await patch(slug, data, true);
    } catch (error) {
      if (response?.lease) await release(slug, response.lease, cleanup);
      throw error;
    }
    if (options.cleanup) {
      const paths = [...options.cleanup];
      const lease = { slug, paths: [...paths] };
      leases.set(lease, { slug, paths, control: response?.lease, released: false });
      return lease;
    }
  }
  async function readFile(slug, filename) {
    workspaceName(slug, containerPrefix);
    parts(filename);
    if (published.has(filename)) {
      const value = await secret(slug);
      if (!Object.hasOwn(value?.data || {}, filename)) throw Object.assign(new Error('Runtime file not found'), { code: 'ENOENT' });
      return Buffer.from(value.data[filename], 'base64').toString('utf8');
    }
    const response = await run(slug, { operation: 'read', filename });
    if (typeof response.content !== 'string') throw new Error('Invalid runtime file response');
    return Buffer.from(response.content, 'base64').toString('utf8');
  }
  async function removeFiles(slug, paths, lease) {
    workspaceName(slug, containerPrefix);
    paths.forEach(parts);
    const state = lease && leases.get(lease);
    if (lease && (!state || state.slug !== slug || JSON.stringify(state.paths) !== JSON.stringify(paths))) throw new Error('Invalid file lease');
    if (state?.released) return;
    const data = Object.create(null), ordinary = [];
    for (const filename of paths) {
      if (published.has(filename)) data[filename] = null;
      else ordinary.push(filename);
    }
    try {
      if (Object.keys(data).length) await patch(slug, data, false);
    } finally {
      try {
        if (state?.control) await release(slug, state.control, ordinary);
        else if (!state && ordinary.length) await run(slug, { operation: 'remove', paths: ordinary });
      } finally { if (state) state.released = true; }
    }
  }
  return { putFiles, readFile, removeFiles };
}

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const runtimeNames = (slug, prefix = "workpartner-next-") => ({ container: `${prefix}${slug}`, network: `${prefix}${slug}-net` });

export function docker(method, path, body, timeoutMs, maxBytes = Infinity, { stdin } = {}) {
  if (stdin !== undefined) return startWithInput({ socketPath: "/var/run/docker.sock", method, path, timeout: timeoutMs }, body, stdin, maxBytes);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: "/var/run/docker.sock", method, path, ...(timeoutMs ? { timeout: timeoutMs } : {}),
      headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error('Runtime output too large'));
        else chunks.push(c);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error('Runtime response aborted')));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (timeoutMs) req.on("timeout", () => req.destroy(new Error("超时")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** Preserve synchronous token publication for existing organization extensions. */
export function writeContainerTokenFile(content, slug, root, uid) {
  const dir = `${root}/${slug}`;
  fs.mkdirSync(dir, { recursive: true });
  if (uid !== null) fs.chownSync(dir, uid, uid);
  const file = `${dir}/.zp-market-token`;
  const temp = `${file}.${crypto.randomBytes(12).toString("hex")}`;
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    if (uid !== null) fs.chownSync(temp, uid, uid);
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function output(value, strict = false) {
  const buffer = Buffer.from(value || ''), stdout = [], stderr = [], logs = [];
  for (let offset = 0; offset < buffer.length;) {
    if (offset + 8 > buffer.length) {
      if (strict) throw new Error('Truncated runtime output');
      break;
    }
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) {
      if (strict) throw new Error('Truncated runtime output');
      break;
    }
    const chunk = buffer.subarray(offset + 8, offset + 8 + size);
    (buffer[offset] === 2 ? stderr : stdout).push(chunk);
    logs.push(chunk);
    offset += 8 + size;
  }
  return { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), logs: Buffer.concat(logs).toString() };
}

/** Docker-backed personal runtime. Paths are relative to the user's data volume. */
export function createDockerRuntime(o = {}) {
  const transport = o.docker || docker;
  const names = slug => runtimeNames(slug, o.containerPrefix);
  const uid = o.uid === undefined ? 1001 : o.uid;
  const port = o.port || 25808;
  const request = async (method, route, body, statuses = [200], timeout, maxBytes) => {
    const result = await transport(method, route, body, timeout, maxBytes);
    if (!statuses.includes(result.status)) throw new Error(`Runtime request failed: ${method} ${route}: ${result.status}`);
    return result;
  };
  const inspectJson = async route => {
    const result = await request('GET', route, undefined, [200, 404]);
    return result.status === 404 ? null : JSON.parse(result.body);
  };
  async function ensureIsolation(slug) {
    const { network } = names(slug);
    let net = await inspectJson(`/networks/${network}`);
    if (!net) {
      const r = await transport("POST", "/networks/create", {
        Name: network, Driver: "bridge", CheckDuplicate: true, EnableIPv6: false,
        Options: { "com.docker.network.bridge.name": `wpn-${crypto.createHash("sha256").update(network).digest("hex").slice(0, 11)}` },
        Labels: { [o.userLabel || "workpartner.next-user"]: slug },
      });
      if (r.status !== 201 && r.status !== 409) throw new Error(`建网络失败：${r.status}`);
      net = await inspectJson(`/networks/${network}`);
    }
    const members = Object.entries(net.Containers || {});
    for (const who of [o.self, o.modelContainer].filter(Boolean)) {
      if (members.some(([id, c]) => id.startsWith(who) || c.Name === who)) continue;
      const r = await transport("POST", `/networks/${network}/connect`, { Container: who });
      if (r.status !== 200) throw new Error(`把 ${who} 接入 ${network} 失败：${r.status}`);
    }
  }

  async function create(user, { modelConfig } = {}) {
    const { slug } = user;
    const { container, network } = names(slug);
    const key = `${o.keyPrefix}${slug}.key`;
    if (!fs.existsSync(path.join(o.secureDir, key))) throw new Error(`没有 ${slug} 的模型钥匙`);
    await putFiles(slug, [], { directoryMode: 0o777 });
    const oldWork = o.hostUsers && fs.existsSync(path.join(o.usersDir, slug, "work"))
      ? [`${o.hostUsers}/${slug}/work:/data/old-work:ro`] : [];
    const r = await transport("POST", `/containers/create?name=${container}`, {
      Image: o.image, User: `${uid}:${uid}`, Hostname: container,
      Env: [`${o.modelBaseEnvironment || "MODEL_BASE_URL"}=${o.modelBaseUrl}`, `PARTNER_USER_NAME=${user.name || ""}`,
        ...(modelConfig ? [`WORKPARTNER_MODEL_CONFIG=${modelConfig}`] : [])],
      Labels: { [o.userLabel || "workpartner.next-user"]: slug },
      HostConfig: {
        Binds: [`${o.hostData}/${slug}:/data`, `${o.hostSecure}/${key}:${o.modelKeyFile || "/etc/partner/model.key"}:ro`, ...oldWork],
        NetworkMode: network, RestartPolicy: { Name: "unless-stopped" },
        Memory: o.memory, NanoCpus: o.nanoCpus, PidsLimit: o.pidsLimit,
      },
    });
    if (r.status !== 201) throw new Error(`建容器失败：${r.status} ${String(r.body).slice(0, 200)}`);
  }

  async function inspect(slug) {
    const info = await inspectJson(`/containers/${names(slug).container}/json`);
    if (!info) return { exists: false, running: false, image: null, imageId: null, address: null };
    const host = info.NetworkSettings?.Networks?.[names(slug).network]?.IPAddress;
    return { exists: true, running: !!info.State?.Running, image: info.Config?.Image, imageId: info.Image,
      env: info.Config?.Env || [], name: names(slug).container, address: host ? { host, port } : null };
  }

  async function execNamed(container, cmd, { stdin, detached = false, env, user, timeout = 30000, createTimeout = 10000, maxOutputBytes, strictOutput = false } = {}) {
    if (detached && stdin !== undefined) throw new Error('Detached exec cannot receive stdin');
    const created = await request('POST', `/containers/${container}/exec`, {
      ...(user !== undefined ? { User: String(user) } : {}), ...(env ? { Env: env } : {}),
      ...(stdin !== undefined ? { AttachStdin: true } : {}), AttachStdout: !detached, AttachStderr: !detached, Cmd: cmd,
    }, [201], createTimeout, maxOutputBytes);
    const id = encodeURIComponent(JSON.parse(created.body).Id);
    const route = `/exec/${id}/start`;
    const body = { Detach: detached, Tty: false };
    const started = stdin === undefined ? await request('POST', route, body, [200], timeout, maxOutputBytes)
      : await transport('POST', route, body, timeout, maxOutputBytes, { stdin });
    if (maxOutputBytes !== undefined && Buffer.byteLength(started.body || '') > maxOutputBytes) throw new Error('Runtime output too large');
    if (detached) return { exitCode: null, stdout: '', stderr: '', logs: '' };
    const inspected = await request('GET', `/exec/${id}/json`, undefined, [200], 10000, maxOutputBytes);
    return { exitCode: JSON.parse(inspected.body).ExitCode, ...output(started.body, strictOutput || maxOutputBytes !== undefined) };
  }

  async function runOnce(slug, spec) {
    const name = `${names(slug).container}-${spec.name || 'resetpass'}`;
    await transport('DELETE', `/containers/${name}?force=1`);
    await request('POST', `/containers/create?name=${name}`, {
      Image: spec.image || o.image, User: `${uid}:${uid}`, Entrypoint: spec.entrypoint, Cmd: spec.cmd,
      HostConfig: { Binds: [`${o.hostData}/${slug}:/data`], NetworkMode: 'none' },
    }, [201]);
    try {
      await transport('POST', `/containers/${name}/start`);
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime job timed out')), spec.timeoutMs ?? 60000); });
      const waited = await Promise.race([transport('POST', `/containers/${name}/wait`), timeout]).finally(() => clearTimeout(timer));
      const logs = await transport('GET', `/containers/${name}/logs?stdout=1&stderr=1`);
      let exitCode = null;
      try { exitCode = JSON.parse(waited.body).StatusCode ?? null; } catch { /* Historical callers ignore the wait response. */ }
      return { exitCode, logs: output(logs.body).logs };
    } finally { await transport('DELETE', `/containers/${name}?force=1`); }
  }

  // Pin every directory while accessing personal files; never follow a user-controlled symlink.
  function parts(value) {
    if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.startsWith('/')
      || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid runtime path');
    return value.split('/');
  }
  function home(slug, options, handles) {
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) throw new Error('Invalid workspace slug');
    const directory = path.join(o.dataDir, slug);
    if (options.create !== false) fs.mkdirSync(directory, { recursive: true, mode: options.directoryMode ?? 0o700 });
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    handles.push(fd);
    if (options.chown !== false && uid !== null) fs.fchownSync(fd, uid, uid);
    return `/proc/self/fd/${fd}`;
  }
  function parent(root, segments, handles, directories, locations) {
    let current = root, relative = '';
    for (const segment of segments) {
      relative += (relative ? '/' : '') + segment;
      const destination = path.join(current, segment);
      const spec = directories?.find(item => item.path === relative);
      if (directories) {
        try { fs.mkdirSync(destination, { mode: spec?.mode ?? 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      handles.push(fd);
      if (directories && spec?.owner !== false && uid !== null) fs.fchownSync(fd, uid, uid);
      current = `/proc/self/fd/${fd}`;
      locations?.set(relative, current);
    }
    return current;
  }
  // Optional cleanup paths return a lease that pins staging parents until removeFiles releases it.
  async function putFiles(slug, files, options = {}) {
    const handles = [], locations = new Map();
    let retained = false;
    const close = () => { handles.reverse().forEach(fd => fs.closeSync(fd)); handles.length = 0; };
    const cleanup = () => {
      for (const filename of options.cleanup || []) {
        const segments = parts(filename), name = segments.pop();
        const directory = locations.get(segments.join('/'));
        if (directory) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
      }
    };
    try {
      const root = home(slug, options, handles);
      locations.set('', root);
      for (const file of files) {
        const segments = parts(file.path), name = segments.pop();
        const directory = parent(root, segments, handles, options.directories || [], locations);
        const temporary = path.join(directory, `.runtime-${crypto.randomBytes(12).toString('hex')}`);
        try {
          const fd = fs.openSync(temporary, 'wx', file.mode ?? 0o600);
          try {
            fs.writeFileSync(fd, file.content);
            if (uid !== null) fs.fchownSync(fd, uid, uid);
          } finally { fs.closeSync(fd); }
          fs.renameSync(temporary, path.join(directory, name));
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      if (options.cleanup) {
        const lease = { slug, paths: [...options.cleanup], release: async () => {
          if (!handles.length) return;
          try { cleanup(); } finally { close(); }
        } };
        retained = true;
        return lease;
      }
    } finally {
      if (!retained) {
        try { cleanup(); } finally { close(); }
      }
    }
  }
  async function readFile(slug, filename) {
    const handles = [];
    try {
      const root = home(slug, { create: false, chown: false }, handles);
      const segments = parts(filename), name = segments.pop();
      const directory = parent(root, segments, handles);
      const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
    } finally { handles.reverse().forEach(fd => fs.closeSync(fd)); }
  }
  async function removeFiles(slug, paths, lease) {
    if (lease) {
      if (lease.slug !== slug || JSON.stringify(lease.paths) !== JSON.stringify(paths)) throw new Error('Invalid file lease');
      return lease.release();
    }
    const handles = [];
    try {
      const root = home(slug, { create: false, chown: false }, handles);
      for (const filename of paths) {
        const segments = parts(filename), name = segments.pop();
        const directory = parent(root, segments, handles);
        fs.rmSync(path.join(directory, name), { recursive: true, force: true });
      }
    } finally { handles.reverse().forEach(fd => fs.closeSync(fd)); }
  }
  return {
    inspect, ensureIsolation, create, putFiles, readFile, removeFiles, runOnce, execNamed,
    exec: (slug, cmd, options) => execNamed(names(slug).container, cmd, options),
    imageId: async ref => (await inspectJson(`/images/${encodeURIComponent(ref)}/json`))?.Id || null,
    address: async (slug, requestedPort, existing) => {
      const address = existing === undefined ? (await inspect(slug)).address
        : existing?.address || (existing?.ip ? { host: existing.ip } : null);
      return address && { ...address, port: requestedPort ?? address.port ?? existing?.port ?? port };
    },
    start: slug => request('POST', `/containers/${names(slug).container}/start`, undefined, [204, 304]),
    stop: slug => transport('POST', `/containers/${names(slug).container}/stop?t=10`),
    restart: slug => request('POST', `/containers/${names(slug).container}/restart?t=10`, undefined, [204], 30000),
    remove: slug => transport('DELETE', `/containers/${names(slug).container}?force=1`),
    processes: async (slug, timeout = 5000) => {
      const result = await request('GET', `/containers/${names(slug).container}/top?ps_args=${encodeURIComponent('-eo pid,ppid,args')}`, undefined, [200], timeout);
      const { Titles, Processes } = JSON.parse(result.body);
      const indices = ['PID', 'PPID', 'COMMAND'].map(key => Titles.findIndex(title => title.toUpperCase() === key));
      if (indices.some(index => index < 0)) throw new Error('Process output missing columns');
      return Processes.map(row => ({ pid: row[indices[0]], ppid: row[indices[1]], args: row[indices[2]] }));
    },
  };
}

function startWithInput(options, body, stdin, maxOutputBytes) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options,
      headers: { 'content-type': 'application/json', connection: 'Upgrade', upgrade: 'tcp' } });
    req.on('upgrade', (res, socket, head) => {
      const chunks = [head]; let size = head.length;
      socket.on('data', chunk => {
        size += chunk.length;
        if (size > (maxOutputBytes ?? Infinity)) socket.destroy(new Error('Runtime output too large'));
        else chunks.push(chunk);
      });
      socket.on('error', reject);
      socket.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      socket.setTimeout(options.timeout || 0, () => socket.destroy(new Error('Runtime exec timed out')));
      socket.end(stdin);
    });
    req.on('response', res => { res.resume(); reject(new Error(`Runtime stdin upgrade failed: ${res.statusCode}`)); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Runtime exec timed out')));
    req.end(JSON.stringify(body));
  });
}

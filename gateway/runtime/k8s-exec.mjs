export function workspaceName(slug, prefix = 'workpartner-next-') {
  if (typeof slug !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(slug)) throw new Error('Invalid workspace slug');
  return `${prefix}${slug}`;
}

function processReader() {
  const fs = require('node:fs');
  const root = process.argv[1];
  const processes = [];
  for (const pid of fs.readdirSync(root).filter(name => /^\d+$/.test(name))) {
    try {
      const stat = fs.readFileSync(`${root}/${pid}/stat`, 'utf8');
      // comm may contain spaces and parentheses; the remaining fields start after its last closing parenthesis.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      const args = fs.readFileSync(`${root}/${pid}/cmdline`, 'utf8').replace(/\0$/, '').replaceAll('\0', ' ');
      if (args) processes.push({ pid, ppid: fields[1], args });
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
    }
  }
  process.stdout.write(JSON.stringify(processes));
}

const processScript = `(${processReader.toString()})()`;

// Docker's unlimited (0) timeouts become a bounded 24-hour wait for K1's positive durations.
const unlimitedTimeoutMs = 24 * 60 * 60 * 1000;

/** K2a supplies the K1 client and the main container name used in its Pod template. */
export function createK8sExec({ client, namespace, systemNamespace = client.namespace, containerPrefix,
  uid = 1001, container = 'workspace', systemContainer } = {}) {
  async function execute(ns, pod, target, cmd, { stdin, detached = false, env, user,
    timeout = 30000, createTimeout = 10000, maxOutputBytes } = {}) {
    if (user !== undefined && ![String(uid), `${uid}:${uid}`].includes(String(user))) {
      throw new Error('Kubernetes exec cannot change the container user');
    }
    if (detached && stdin !== undefined) throw new Error('Detached exec cannot receive stdin');
    if (!Array.isArray(cmd) || !cmd.length || cmd.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error('Invalid runtime command');
    }
    if (env !== undefined && (!Array.isArray(env) || env.some(value => typeof value !== 'string'
      || !/^[^=\0]+=[^\0]*$/.test(value) || value.startsWith('-')))) throw new Error('Invalid runtime environment');
    let command = env?.length ? ['env', '--', ...env, ...cmd] : [...cmd];
    if (detached) command = ['/bin/sh', '-c', 'setsid "$@" </dev/null >/dev/null 2>&1 &', 'sh', ...command];
    const result = await client.exec(ns, pod, target, command, {
      stdin, timeoutMs: timeout === 0 ? unlimitedTimeoutMs : timeout,
      connectTimeoutMs: createTimeout === 0 ? unlimitedTimeoutMs : createTimeout, maxOutputBytes,
    });
    return detached ? { exitCode: null, stdout: '', stderr: '', logs: '' } : result;
  }
  const exec = async (slug, cmd, options) => execute(namespace, `${workspaceName(slug, containerPrefix)}-0`, container, cmd, options);
  return {
    exec,
    execNamed: (name, cmd, options) => execute(systemNamespace, name, systemContainer, cmd, options),
    processes: async (slug, timeout = 5000) => {
      const result = await exec(slug, ['node', '-e', processScript, '/proc'], { timeout });
      if (result.exitCode !== 0) throw new Error('Runtime process listing failed');
      let rows;
      try { rows = JSON.parse(result.stdout); } catch { throw new Error('Invalid runtime process output'); }
      if (!Array.isArray(rows) || rows.some(row => !row || !/^\d+$/.test(row.pid) || typeof row.pid !== 'string'
        || !/^\d+$/.test(row.ppid) || typeof row.ppid !== 'string' || typeof row.args !== 'string')) {
        throw new Error('Invalid runtime process output');
      }
      return rows.map(({ pid, ppid, args }) => ({ pid, ppid, args }));
    },
  };
}

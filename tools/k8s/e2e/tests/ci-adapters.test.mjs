import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execute } from '../controller.mjs';

// Run directly: node --test tools/k8s/e2e/tests/ci-adapters.test.mjs
// All external tools are local stubs: no network, Docker or cluster is used.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const adapter = name => path.join(root, 'tools/k8s/e2e', name);
const fixture = '#!/bin/sh\nexit 0\n';
const fixtureSha = createHash('sha256').update(fixture).digest('hex');
const otherSha = '0'.repeat(64);

test('workflow job env does not use runner context', async () => {
  const workflow = await fs.readFile(path.join(root, '.github/workflows/e2e-k3d.yml'), 'utf8');
  const jobEnvs = [...workflow.matchAll(/^    env:[^\n]*\n((?:[ \t]*\n| {6}[^\n]*\n)*)/gm)];
  assert.ok(jobEnvs.length > 0, 'expected a job-level env block');
  for (const [, env] of jobEnvs) assert.doesNotMatch(env, /runner\./);
});

async function sandbox(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-ci-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'), log = path.join(directory, 'calls.jsonl');
  await fs.mkdir(bin);
  const stub = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const tool = path.basename(process.argv[1]), args = process.argv.slice(2);
const input = fs.readFileSync(0);
fs.appendFileSync(process.env.CI_TEST_LOG, JSON.stringify({ tool, args, input: input.toString('base64') })+'\\n');
const fail = JSON.parse(process.env.CI_TEST_FAIL || 'null');
if (fail && tool === fail.tool && fail.args.every((v, i) => args[i] === v)) process.exit(29);
if (tool === 'curl') {
  const file = args[args.indexOf('-o') + 1];
  let data = ${JSON.stringify(fixture)};
  if (file === 'kubectl.sha256') data = process.env.CI_TEST_KUBECTL_SHA + '\\n';
  if (file === 'checksums.txt') process.exit(22);
  if (process.env.CI_TEST_CORRUPT === file) data += 'corrupt\\n';
  fs.writeFileSync(file, data);
}
if (tool === 'kubectl') {
  if (args.includes('nodes') && args.includes('get')) {
    const prefix = fs.readFileSync(path.join(process.env.CI_E2E_DIR, 'prefix'), 'utf8').trim();
    console.log(JSON.stringify({ items: ['server', 'agent'].map((role, i) => {
      const name = 'k3d-' + prefix + '-' + role + '-0';
      return { metadata: { name, labels: { 'kubernetes.io/hostname': name } }, spec: { podCIDR: '192.0.2.' + i * 128 + '/25' } };
    }) }));
  } else if (args.includes('config')) console.log('{}');
}
if (tool === 'k3d' && args[0] === 'kubeconfig') console.log('{}');
`;
  for (const tool of ['docker', 'curl', 'kubectl', 'k3d']) {
    await fs.writeFile(path.join(bin, tool), stub, { mode: 0o755 });
  }
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_TEST_LOG: log,
    CI_E2E_DIR: path.join(directory, 'run'), CI_E2E_SERVER: 'server', CI_E2E_AGENT: 'agent',
    K3S_BASE_IMAGE: 'images.test/k3s:v1', EXTERNAL_PROBE: 'probe.test:443',
    KUBECTL_VERSION: 'v1.37.2', K3D_VERSION: 'v5.8.3',
    KUBECTL_SHA256: fixtureSha, K3D_SHA256: fixtureSha,
    CI_TEST_KUBECTL_SHA: fixtureSha,
    CI_TEST_FAIL: '', CI_TEST_CORRUPT: '',
  };
  const run = (name, args, extra = {}, input = '') => {
    const result = execute('/bin/bash', [adapter(name), ...args], {
      cwd: root, env: { ...env, ...extra }, input, timeout: 15000, acceptFailure: true,
    });
    assert.ifError(result.error);
    return result;
  };
  const calls = async () => (await fs.readFile(log, 'utf8').catch(e => {
    if (e.code === 'ENOENT') return ''; throw e;
  })).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { directory, env, run, calls };
}

test('first workflow step rejects malformed external_probe with a format example', async t => {
  const f = await sandbox(t);
  const workflow = await fs.readFile(path.join(root, '.github/workflows/e2e-k3d.yml'), 'utf8');
  const firstStep = /    steps:\n      - name: [^\n]+\n        run: \|\n((?:          [^\n]*\n)+)/.exec(workflow);
  assert.ok(firstStep, 'first step must validate inputs before checkout or tool setup');
  const script = firstStep[1].replace(/^          /gm, '');
  for (const probe of ['', '192.0.2.1', '192.0.2.1:', ':443', '192.0.2.1:abc',
    '192.0.2.1:0', '192.0.2.1:65536', '192.0.2.1:99999999999999999999',
    '192.0.2.1:443/path', ' 192.0.2.1:443', '192.0.2.1:443\n',
    '192.0.2.1:443:443']) {
    const result = execute('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], {
      env: { ...f.env, EXTERNAL_PROBE: probe, RUNNER_TEMP: f.directory, GITHUB_ENV: path.join(f.directory, 'env') },
      acceptFailure: true,
    });
    assert.notEqual(result.status, 0, JSON.stringify(probe));
    assert.match(result.stderr, /external_probe.*host:port.*192\.0\.2\.1:443/);
  }
  for (const port of ['1', '443', '65535']) {
    const result = execute('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], {
      env: { ...f.env, EXTERNAL_PROBE: `192.0.2.1:${port}`, RUNNER_TEMP: f.directory, GITHUB_ENV: path.join(f.directory, 'env') },
      acceptFailure: true,
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('K6 adapter rewrites exact prefixes, preserves argv/stdin and rejects unknown commands', async t => {
  const f = await sandbox(t);
  const input = Buffer.from([0, 255, 13, 10, 39, 128]);
  const cases = [
    ["'k3s' 'crictl' 'images' '--output' 'json' ", "'crictl' 'images' '--output' 'json' "],
    ["'k3s' 'crictl' 'inspecti' 'images.test/fixture:v1' ", "'crictl' 'inspecti' 'images.test/fixture:v1' "],
    ["'k3s' 'ctr' '-n' 'k8s.io' 'images' 'import' '-' ", "'ctr' '-n' 'k8s.io' 'images' 'import' '-' "],
    ["'k3s' 'ctr' '-n' 'k8s.io' 'images' 'label' 'images.test/fixture:v1' 'io.cri-containerd.pinned=' ",
      "'ctr' '-n' 'k8s.io' 'images' 'label' 'images.test/fixture:v1' 'io.cri-containerd.pinned=' "],
    ["'df' '-Pk' '--' '/path with '\\''quote' ", "'df' '-Pk' '--' '/path with '\\''quote' "],
  ];
  for (const node of ['server', 'agent']) for (const [command, rewritten] of cases) {
    const result = f.run('ci-ssh.sh', ['-o', 'BatchMode=yes', '--', node, command], {}, input);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await f.calls()).at(-1), {
      tool: 'docker', args: ['exec', '-i', node, 'sh', '-c', rewritten], input: input.toString('base64'),
    });
  }
  const before = (await f.calls()).length;
  for (const command of ["'k3s' 'crictl'", "'k3s' 'ctr'", "'k3s' 'crictl-extra' 'images' ",
    "'k3s' 'ctr-extra' 'images' ", "'k3s' 'kubectl' 'get' ", "'crictl' 'images' ",
    "'sh' '-c' 'true' ", "'df-extra' '/' ", " 'df' '/' ", 'df /', '']) {
    assert.equal(f.run('ci-ssh.sh', ['-o', 'BatchMode=yes', '--', 'server', command]).status, 2);
  }
  for (const args of [['-o', 'BatchMode=yes', '--', 'unknown', "'df' '/' "],
    ['-o', 'BatchMode=no', '--', 'server', "'df' '/' "], ['server', "'df' '/' "]]) {
    assert.equal(f.run('ci-ssh.sh', args).status, 2);
  }
  assert.equal((await f.calls()).length, before, 'rejected input must not reach Docker');
  assert.equal(f.run('ci-ssh.sh', ['-o', 'BatchMode=yes', '--', 'server', "'df' '/' "], {
    CI_TEST_FAIL: JSON.stringify({ tool: 'docker', args: ['exec'] }),
  }).status, 29);
});

test('init rejects private literal IPs before creating directories, without DNS or tools', async t => {
  const f = await sandbox(t);
  for (const host of ['0.0.0.0', '0.0.0.1', '0.255.255.255', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.255', '127.0.0.1', '127.255.255.255',
    '169.254.0.1', '169.254.255.255', '100.64.0.1', '100.127.255.255',
    '[::1]', '[0:0:0:0:0:0:0:1]', '[fe80::1]', '[febf:ffff::1]', '[fe80::1%eth0]',
    '[fc00::1]', '[fdff:ffff::1]', '[::ffff:10.0.0.1]', '[::ffff:7f00:1]', '[::ffff:0.0.0.1]']) {
    const result = f.run('ci-k3d.sh', ['init'], { EXTERNAL_PROBE: `${host}:443` });
    assert.notEqual(result.status, 0, host);
    assert.match(result.stderr, /external_probe must not be/, host);
    await assert.rejects(fs.stat(f.env.CI_E2E_DIR), { code: 'ENOENT' });
  }
  // IPv6 remains unsupported by the unchanged shared endpoint parser.
  assert.match(f.run('ci-k3d.sh', ['init'], { EXTERNAL_PROBE: '[2001:db8::1]:443' }).stderr, /Expected IPv4-or-host:port/);
  for (const [i, host] of ['probe.test', '192.0.2.1', '198.51.100.1', '203.0.113.1'].entries()) {
    const result = f.run('ci-k3d.sh', ['init'], { CI_E2E_DIR: path.join(f.directory, `accepted-${i}`), EXTERNAL_PROBE: `${host}:443` });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(await f.calls(), []);
});

test('init rejects numeric and hexadecimal hostnames before creating directories', async t => {
  const f = await sandbox(t);
  for (const host of ['0', '2130706433', '2130706433.', '127.1', '0177.0.0.1',
    '7f000001', 'deadbeef', '7f.1', '0x7f000001', '0x7f.1', '0X7F.0x01',
    '0x7f.1.', '0x7f.probe.test', 'probe.0x7f.test']) {
    const result = f.run('ci-k3d.sh', ['init'], { EXTERNAL_PROBE: `${host}:443` });
    assert.notEqual(result.status, 0, host);
    assert.match(result.stderr, /external_probe must not be a numeric or hexadecimal hostname/, host);
    await assert.rejects(fs.stat(f.env.CI_E2E_DIR), { code: 'ENOENT' });
  }
  for (const [i, host] of ['123.probe.test', 'deadbeef.probe.test', 'probe-123.test'].entries()) {
    const result = f.run('ci-k3d.sh', ['init'], {
      CI_E2E_DIR: path.join(f.directory, `accepted-${i}`), EXTERNAL_PROBE: `${host}:443`,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(await f.calls(), []);
});

test('install verifies pinned binary hashes without fetching k3d checksums', async t => {
  for (const [name, extra, error] of [
    ['matching hashes', {}, null],
    ['missing kubectl pin', { KUBECTL_SHA256: '' }, /KUBECTL_SHA256/],
    ['missing k3d pin', { K3D_SHA256: '' }, /K3D_SHA256/],
    ['malformed pin', { K3D_SHA256: 'invalid' }, /Invalid pinned SHA256/],
    ['kubectl publication changed', { CI_TEST_KUBECTL_SHA: otherSha }, /Published kubectl SHA256 differs/],
    ['k3d pin differs from binary', { K3D_SHA256: otherSha }, /checksum did NOT match/],
    ['kubectl binary changed', { CI_TEST_CORRUPT: 'kubectl' }, /checksum did NOT match/],
    ['k3d binary changed', { CI_TEST_CORRUPT: 'k3d-linux-amd64' }, /checksum did NOT match/],
  ]) await t.test(name, async t => {
    const f = await sandbox(t);
    assert.equal(f.run('ci-k3d.sh', ['init']).status, 0);
    const result = f.run('ci-k3d.sh', ['install'], extra);
    if (error) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, error);
      for (const tool of ['kubectl', 'k3d']) await assert.rejects(fs.stat(path.join(f.env.CI_E2E_DIR, 'bin', tool)), { code: 'ENOENT' });
    } else {
      assert.equal(result.status, 0, result.stderr);
      for (const tool of ['kubectl', 'k3d']) assert.equal(await fs.readFile(path.join(f.env.CI_E2E_DIR, 'bin', tool), 'utf8'), fixture);
    }
  });
  const workflow = await fs.readFile(path.join(root, '.github/workflows/e2e-k3d.yml'), 'utf8');
  assert.match(workflow, /KUBECTL_SHA256: c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4\s/);
  assert.match(workflow, /K3D_SHA256: dbaa79a76ace7f4ca230a1ff41dc7d8a5036a8ad0309e9c54f9bf3836dbe853e\s/);
});

test('up verifies both standalone runtimes and waits for system deployments and API services', async t => {
  const f = await sandbox(t);
  assert.equal(f.run('ci-k3d.sh', ['init']).status, 0);
  const result = f.run('ci-k3d.sh', ['up']);
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.calls();
  const prefix = (await fs.readFile(path.join(f.env.CI_E2E_DIR, 'prefix'), 'utf8')).trim();
  for (const role of ['server', 'agent']) for (const command of [
    ['test', '-d', '/sys/class/net/flannel.1'], ['crictl', 'images', '-o', 'json'], ['ctr', '-n', 'k8s.io', 'images', 'ls', '-q'],
  ]) {
    const args = ['exec', `k3d-${prefix}-${role}-0`, ...command];
    assert.equal(calls.filter(c => c.tool === 'docker' && JSON.stringify(c.args) === JSON.stringify(args)).length, 1);
  }
  const kubeconfig = path.join(f.env.CI_E2E_DIR, 'kubeconfig.json');
  const waits = [
    ['--kubeconfig', kubeconfig, '-n', 'kube-system', 'wait', '--for=condition=Available', 'deployment', '--all', '--timeout=180s'],
    ['--kubeconfig', kubeconfig, 'wait', '--for=condition=Available', 'apiservice', '--all', '--timeout=180s'],
  ];
  assert.deepEqual(calls.slice(-2).map(c => c.args), waits);
});

test('up fails immediately if either runtime check or readiness wait fails', async t => {
  for (const kind of ['server-crictl', 'server-ctr', 'agent-crictl', 'agent-ctr', 'deployment', 'apiservice']) {
    await t.test(kind, async t => {
      const f = await sandbox(t);
      assert.equal(f.run('ci-k3d.sh', ['init']).status, 0);
      const prefix = (await fs.readFile(path.join(f.env.CI_E2E_DIR, 'prefix'), 'utf8')).trim();
      let fail;
      if (kind.includes('-')) {
        const [role, binary] = kind.split('-');
        fail = { tool: 'docker', args: ['exec', `k3d-${prefix}-${role}-0`, binary] };
      } else {
        const args = ['--kubeconfig', path.join(f.env.CI_E2E_DIR, 'kubeconfig.json')];
        if (kind === 'deployment') args.push('-n', 'kube-system');
        args.push('wait', '--for=condition=Available', kind);
        fail = { tool: 'kubectl', args };
      }
      const result = f.run('ci-k3d.sh', ['up'], { CI_TEST_FAIL: JSON.stringify(fail) });
      assert.equal(result.status, 29, result.stderr);
      const last = (await f.calls()).at(-1);
      assert.equal(last.tool, fail.tool);
      assert.deepEqual(last.args.slice(0, fail.args.length), fail.args);
    });
  }
});

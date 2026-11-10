import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = 'example.com/workspace:v1';
const config = JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const id = digest(config);
const oldId = `sha256:${'b'.repeat(64)}`;
const targets = ['ops@192.0.2.10', 'ops@192.0.2.11'];
const guardArgs = ['apply', '--pod-cidr', '10.42.0.0/16', '--tunnel-interface', 'flannel.1',
  '--node-ips', '192.0.2.10,192.0.2.11,2001:db8::10'];

// Minimal regular-file tar fixtures, with real config/manifest digests.
function imageArchive(format = 'docker') {
  const entries = {};
  const blob = content => {
    const ident = digest(content);
    entries[`blobs/sha256/${ident.slice(7)}`] = content;
    return { digest: ident, size: Buffer.byteLength(content) };
  };
  if (format === 'docker') {
    entries[`${id.slice(7)}.json`] = config;
    entries['manifest.json'] = JSON.stringify([{ Config: `${id.slice(7)}.json`, RepoTags: [image], Layers: [] }]);
  } else {
    const descriptor = blob(JSON.stringify({ schemaVersion: 2, config: blob(config), layers: [] }));
    let manifests = [descriptor];
    if (format === 'oci-multiple') manifests.push(blob(JSON.stringify({ config: blob('{}'), layers: [] })));
    if (format === 'oci-nested') manifests = [blob(JSON.stringify({ schemaVersion: 2, manifests }))];
    entries['index.json'] = JSON.stringify({ schemaVersion: 2, manifests });
    entries['oci-layout'] = '{"imageLayoutVersion":"1.0.0"}';
    if (format === 'oci-corrupt') entries[`blobs/sha256/${id.slice(7)}`] = '{}';
  }
  const blocks = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156);
    header.write('ustar\0', 257); header.write('00', 263);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function fixture(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-k8s-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.jsonl');
  const stateFile = path.join(dir, 'state.json');
  const archive = settings.corruptArchive ? Buffer.from('invalid archive') : imageArchive(settings.archiveFormat);
  const archiveFile = path.join(dir, 'image.tar');
  fs.writeFileSync(archiveFile, archive);
  fs.writeFileSync(log, '');
  fs.writeFileSync(stateFile, JSON.stringify({
    id, oldId, image, imported: {}, table: false,
    registry: { metadata: { resourceVersion: '7' }, data: {
      'images.json': JSON.stringify({ 'example.com/workspace:old': oldId }), other: 'preserved',
    } }, ...settings,
  }));
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE));
const target = process.env.FAKE_TARGET;
const save = () => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
const record = extra => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool, args, target, ...extra }) + '\\n');
const output = value => process.stdout.write(JSON.stringify(value));
const fail = stage => {
  if (state.fail === stage && (!state.failTarget || state.failTarget === target)) process.exit(19);
};
if (tool === 'ssh') {
  record();
  if (args[0] !== '-o' || args[1] !== 'BatchMode=yes' || args[2] !== '--' || args.length !== 5) process.exit(20);
  const result = spawnSync('bash', ['-c', args[4]], { stdio: 'inherit', env: { ...process.env, FAKE_TARGET: args[3] } });
  process.exit(result.status ?? 21);
}
if (tool === 'docker') {
  record();
  if (args[0] === 'image') {
    fail('source');
    output([{ Id: state.dockerId ?? state.oldId, Size: 4096 }]);
  } else if (args[0] === 'save') {
    process.stdout.write(fs.readFileSync(process.env.FAKE_ARCHIVE));
    fail('save');
  } else process.exit(22);
} else if (tool === 'df') {
  record(); fail('disk');
  console.log('Filesystem 1024-blocks Used Available Capacity Mounted on');
  console.log('/dev/fixture 99999999 1 ' + (state.lowDisk === target ? 1 : 99999998) + ' 1% /data');
} else if (tool === 'k3s') {
  const action = args.includes('import') ? 'import' : args.includes('label') ? 'label' : args.includes('inspecti') ? 'inspect' : 'list';
  const stdin = action === 'import' ? fs.readFileSync(0).toString('base64') : undefined;
  record({ stdin }); fail(action);
  if (action === 'import') { state.imported[target] = true; save(); }
  if (action === 'list') output({ images: state.existing?.[target] ? [{ id: state.existing[target], repoTags: [state.existingRef || state.image] }] : [] });
  if (action === 'inspect') {
    if (!state.imported[target]) process.exit(23);
    if (state.badJson) process.stdout.write('{');
    else output({ status: { id: state.mismatch === target ? state.oldId : state.id } });
  }
} else if (tool === 'kubectl') {
  const action = args.includes('get') ? 'get' : args.includes('patch') ? 'patch' : 'create';
  const option = action === 'patch' ? '--patch-file' : '-f';
  const body = action === 'get' ? undefined : JSON.parse(fs.readFileSync(args[args.indexOf(option) + 1]));
  record({ body }); fail(action);
  if (action === 'get') { if (state.registry !== null) output(state.registry); }
  else if (action === 'patch') {
    if (body.metadata.resourceVersion !== state.registry.metadata.resourceVersion) process.exit(24);
    state.registry.data = { ...state.registry.data, ...body.data }; save();
  } else { state.registry = body; save(); }
} else if (tool === 'nft') {
  const text = args.includes('-f') ? fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8') : undefined;
  record({ text }); fail(args.includes('-c') ? 'check' : 'nft');
  if (args[0] === 'list' && args[1] === 'tables') {
    console.log('table inet unrelated');
    if (state.table) console.log('table inet workpartner_guard');
  } else if (args[0] === 'list') console.log('counter packets 2 bytes 128');
  else if (args[0] === 'delete') { state.table = false; save(); }
  else if (!args.includes('-c')) { state.table = true; save(); }
} else process.exit(25);
`;
  for (const tool of ['docker', 'ssh', 'kubectl', 'k3s', 'df', 'nft']) {
    fs.writeFileSync(path.join(bin, tool), fake, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, FAKE_LOG: log, FAKE_STATE: stateFile, FAKE_ARCHIVE: archiveFile };
  delete env.NODE_TEST_CONTEXT;
  let sequence = 0;
  // File descriptors avoid requiring local sockets for CLI output capture.
  const capture = (command, args, environment = process.env) => {
    const stdout = path.join(dir, `stdout-${sequence}`);
    const stderr = path.join(dir, `stderr-${sequence++}`);
    const descriptors = [fs.openSync(stdout, 'w'), fs.openSync(stderr, 'w')];
    let result;
    try {
      result = spawnSync(command, args, { timeout: 20000, env: environment, stdio: ['ignore', ...descriptors] });
    } finally { descriptors.forEach(fd => fs.closeSync(fd)); }
    return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') };
  };
  return {
    dir,
    archive,
    capture,
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    state: () => JSON.parse(fs.readFileSync(stateFile)),
    run: (script, args) => capture('bash', [path.join(root, 'tools/k8s', script), ...args], env),
  };
}
const distributeArgs = [image, '--node', targets[0], '--node', targets[1], '--namespace', 'fixture-system'];
function success(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}
function mutations(calls) { return calls.filter(call => call.tool === 'kubectl' && call.body); }

test('node guard renders isolated rules, replaces atomically, reports counters and removes idempotently', t => {
  const f = fixture(t);
  const rendered = f.run('node-guard.sh', [...guardArgs, '--dry-run']);
  success(rendered);
  assert.deepEqual(f.calls(), []);
  assert.match(rendered.stdout, /add table inet workpartner_guard\ndelete table inet workpartner_guard\ntable inet workpartner_guard/);
  assert.match(rendered.stdout, /elements = \{ 192\.0\.2\.10, 192\.0\.2\.11 \}/);
  assert.match(rendered.stdout, /elements = \{ 2001:db8::10 \}/);
  assert.match(rendered.stdout, /iifname "cni0" ct state established,related counter accept\s+iifname "cni0" tcp dport \{ 6443, 10250 \} counter accept\s+#[^\n]*\n\s+iifname "cni0" icmpv6 type \{ nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, nd-router-advert \} counter accept\s+iifname "cni0" counter drop/);
  assert.match(rendered.stdout, /chain forward \{\s+type filter hook forward priority -10; policy accept;\s+ct state established,related counter accept\s+iifname "cni0" ip daddr/);
  assert.match(rendered.stdout, /IPv4 ARP does not traverse this table/);
  assert.doesNotMatch(rendered.stdout, /(?:ether type arp|arp (?:saddr|daddr|operation))/);
  assert.match(rendered.stdout, /iifname "flannel\.1" ct state new counter drop/);
  for (const [family, set] of [['ip', 'node_ipv4'], ['ip6', 'node_ipv6']]) {
    assert.ok(rendered.stdout.includes(`iifname "cni0" ${family} daddr @${set} meta l4proto tcp tcp dport { 6443, 10250 } counter accept`));
    assert.ok(rendered.stdout.includes(`iifname "cni0" ${family} daddr @${set} counter drop`));
  }
  assert.doesNotMatch(rendered.stdout, /flush ruleset|@[A-Z_]+@/);
  success(f.run('node-guard.sh', guardArgs));
  success(f.run('node-guard.sh', guardArgs));
  assert.deepEqual(f.calls().slice(0, 4).map(c => c.args.slice(0, -1)), [['-c', '-f'], ['-f'], ['-c', '-f'], ['-f']]);
  assert.ok(f.calls().slice(0, 4).every(c => c.text === rendered.stdout));
  const status = f.run('node-guard.sh', ['status']); success(status);
  assert.match(status.stdout, /counter packets 2 bytes 128/);
  success(f.run('node-guard.sh', ['remove']));
  success(f.run('node-guard.sh', ['remove']));
  assert.deepEqual(f.calls().filter(c => c.args[0] === 'delete').map(c => c.args), [['delete', 'table', 'inet', 'workpartner_guard']]);
});

test('node guard rejects malformed parameters and never loads failed syntax checks', t => {
  const f = fixture(t, { fail: 'check' });
  for (const [option, value] of [['--pod-cidr', '10.42.0.1/16'], ['--node-ips', '192.0.2.999'],
    ['--pod-cidr', '2001:db8::%scope\nflush ruleset/64'],
    ['--tunnel-interface', 'flannel.1"; flush ruleset'], ['--node-ips', '192.0.2.10,']]) {
    const args = [...guardArgs]; args[args.indexOf(option) + 1] = value;
    assert.notEqual(f.run('node-guard.sh', args).status, 0);
  }
  assert.notEqual(f.run('node-guard.sh', ['apply', '--node-ips']).status, 0);
  assert.deepEqual(f.calls(), []);
  assert.notEqual(f.run('node-guard.sh', guardArgs).status, 0);
  assert.equal(f.calls().length, 1);
  assert.equal(f.state().table, false);
});

test('rendered rules pass nft check when netlink access is available', { skip: process.env.WORKPARTNER_TEST_NFT_CHECK !== '1' && 'Coordinator opt-in: WORKPARTNER_TEST_NFT_CHECK=1' }, t => {
  const f = fixture(t);
  for (const addresses of ['192.0.2.10', '2001:db8::10', '192.0.2.10,2001:db8::10']) {
    const args = [...guardArgs, '--dry-run']; args[args.indexOf('--node-ips') + 1] = addresses;
    const rendered = f.run('node-guard.sh', args); success(rendered);
    const file = path.join(f.dir, 'guard.nft'); fs.writeFileSync(file, rendered.stdout);
    const result = f.capture('nft', ['-c', '-f', file]);
    if (result.error?.code === 'ENOENT') { t.skip('nft is not installed'); return; }
    if (result.status !== 0 && /Operation not permitted|Permission denied/.test(result.stderr) && !/syntax error/.test(result.stderr)) {
      t.skip('nft cannot access netlink in this sandbox'); return;
    }
    success(result);
  }
});

test('distribution preflights all nodes, streams archives, pins and verifies before preserving registration', t => {
  const f = fixture(t);
  const kubeconfig = path.join(f.dir, 'admin config.json'); fs.writeFileSync(kubeconfig, '{}');
  const dataDir = "/data/containerd 'quoted' $(false)";
  success(f.run('distribute-image.sh', [...distributeArgs, '--data-dir', dataDir, '--configmap', 'fixture-images', '--kubeconfig', kubeconfig]));
  const calls = f.calls();
  assert.deepEqual(calls.filter(c => c.tool === 'df').map(c => c.args), [['-Pk', '--', dataDir], ['-Pk', '--', dataDir]]);
  const imports = calls.filter(c => c.tool === 'k3s' && c.args.includes('import'));
  assert.deepEqual(imports.map(c => [c.target, c.args, c.stdin]), targets.map(target => [target, ['ctr', '-n', 'k8s.io', 'images', 'import', '-'], f.archive.toString('base64')]));
  assert.ok(calls.findIndex(c => c.tool === 'docker' && c.args[0] === 'save') > calls.findLastIndex(c => c.tool === 'df'));
  assert.equal(calls.filter(c => c.tool === 'docker' && c.args[0] === 'save').length, 1);
  assert.ok(calls.findIndex(c => c.tool === 'k3s' && c.args.includes('import')) > calls.findLastIndex(c => c.tool === 'k3s' && c.args.includes('images') && c.args.includes('--output')));
  assert.deepEqual(calls.filter(c => c.tool === 'k3s' && c.args.includes('label')).map(c => c.args), targets.map(() => ['ctr', '-n', 'k8s.io', 'images', 'label', image, 'io.cri-containerd.pinned=pinned']));
  assert.ok(calls.findIndex(c => c.tool === 'kubectl') > calls.findLastIndex(c => c.tool === 'k3s'));
  assert.deepEqual(calls.filter(c => c.tool === 'kubectl').map(c => c.args.slice(0, 4)), Array(2).fill(['--namespace', 'fixture-system', '--kubeconfig', kubeconfig]));
  assert.equal(mutations(calls)[0].body.metadata.resourceVersion, '7');
  assert.ok(mutations(calls)[0].args.includes('fixture-images'));
  assert.deepEqual(JSON.parse(f.state().registry.data['images.json']), { 'example.com/workspace:old': oldId, [image]: id });
  assert.equal(f.state().registry.data.other, 'preserved');
  success(f.run('distribute-image.sh', distributeArgs));
});

test('distribution creates an absent ConfigMap only after both nodes verify', t => {
  const f = fixture(t, { registry: null });
  success(f.run('distribute-image.sh', distributeArgs));
  const registry = f.state().registry;
  assert.deepEqual({ ...registry, data: undefined }, {
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'workpartner-images', namespace: 'fixture-system' },
    data: undefined,
  });
  assert.deepEqual(JSON.parse(registry.data['images.json']), { [image]: id });
});

test('a failed ConfigMap create is reported without leaving a registration', t => {
  const f = fixture(t, { registry: null, fail: 'create' });
  assert.notEqual(f.run('distribute-image.sh', distributeArgs).status, 0);
  assert.equal(f.state().registry, null);
  assert.equal(mutations(f.calls()).length, 1);
});

test('different existing IDs require --replace, matching IDs are repeatable', t => {
  const settings = { existing: { [targets[1]]: oldId } };
  const f = fixture(t, settings);
  const rejected = f.run('distribute-image.sh', distributeArgs);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /--replace/);
  // The archive must now exist to check config IDs; preflight still prevents all node mutations.
  assert.equal(f.calls().some(c => c.tool === 'k3s' && (c.args.includes('import') || c.args.includes('label'))), false);
  assert.deepEqual(mutations(f.calls()), []);
  success(f.run('distribute-image.sh', [...distributeArgs, '--replace']));
  const matching = fixture(t, { existing: { [targets[0]]: id, [targets[1]]: id } });
  success(matching.run('distribute-image.sh', distributeArgs));
});

test('low disk on the last node prevents all imports, including the default reserve', t => {
  const f = fixture(t, { lowDisk: targets[1] });
  for (const extra of [[], ['--min-free-bytes', '2048']]) {
    const result = f.run('distribute-image.sh', [...distributeArgs, ...extra]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Insufficient node disk/);
  }
  assert.equal(f.calls().some(c => c.tool === 'docker' && c.args[0] === 'save'), false);
  assert.deepEqual(mutations(f.calls()), []);
});

for (const stage of ['source', 'disk', 'list', 'save', 'import', 'label', 'inspect', 'get', 'patch']) {
  test(`distribution stops on ${stage} failure without changing registration`, t => {
    const f = fixture(t, { fail: stage });
    const original = f.state().registry;
    assert.notEqual(f.run('distribute-image.sh', distributeArgs).status, 0);
    assert.deepEqual(f.state().registry, original);
    if (!['get', 'patch'].includes(stage)) assert.equal(f.calls().some(c => c.tool === 'kubectl'), false);
    if (['import', 'label', 'inspect'].includes(stage)) {
      assert.equal(f.calls().some(c => c.tool === 'k3s' && c.target === targets[1] && c.args.includes('import')), false);
    }
  });
}

test('mismatched or malformed CRI IDs and corrupt registration never register', t => {
  for (const settings of [{ mismatch: targets[1] }, { badJson: true },
    { registry: { metadata: { resourceVersion: '7' }, data: { 'images.json': '[]' } } }]) {
    const f = fixture(t, settings);
    assert.notEqual(f.run('distribute-image.sh', distributeArgs).status, 0);
    assert.deepEqual(mutations(f.calls()), []);
  }
});

test('unpin removes only the label and normalizes a short Docker reference', t => {
  const f = fixture(t, { existing: { [targets[0]]: oldId, [targets[1]]: oldId }, existingRef: 'docker.io/library/workspace:old' });
  success(f.run('distribute-image.sh', ['--unpin', 'workspace:old', '--node', targets[0], '--node', targets[1]]));
  assert.deepEqual(f.calls().filter(c => c.tool === 'k3s' && c.args.includes('label')).map(c => c.args), targets.map(() =>
    ['ctr', '-n', 'k8s.io', 'images', 'label', 'docker.io/library/workspace:old', 'io.cri-containerd.pinned=']));
  assert.ok(f.calls().every(c => ['ssh', 'k3s'].includes(c.tool)));
});

test('unpin tolerates garbage-collected images and stops on label failures', t => {
  const absent = fixture(t);
  success(absent.run('distribute-image.sh', ['--unpin', image, '--node', targets[0]]));
  assert.equal(absent.calls().some(c => c.args.includes('label')), false);
  const failed = fixture(t, { existing: { [targets[0]]: oldId }, fail: 'label' });
  assert.notEqual(failed.run('distribute-image.sh', ['--unpin', image, '--node', targets[0], '--node', targets[1]]).status, 0);
  assert.equal(failed.calls().some(c => c.target === targets[1]), false);
});

test('distribution normalizes short tags for import checks and keeps the requested registration key', t => {
  const f = fixture(t, { existing: { [targets[0]]: oldId }, existingRef: 'docker.io/library/workspace:v1' });
  const args = ['workspace:v1', ...distributeArgs.slice(1)];
  assert.notEqual(f.run('distribute-image.sh', args).status, 0);
  success(f.run('distribute-image.sh', [...args, '--replace']));
  assert.equal(JSON.parse(f.state().registry.data['images.json'])['workspace:v1'], id);
  assert.ok(f.calls().filter(c => c.tool === 'k3s' && c.args.includes('inspecti'))
    .every(c => c.args.at(-1) === 'docker.io/library/workspace:v1'));
});

test('systemd template applies before k3s, reloads and removes only the guard', () => {
  const unit = fs.readFileSync(path.join(root, 'deploy/k8s/node-guard.service.tmpl'), 'utf8');
  assert.match(unit, /^Before=.*k3s\.service k3s-agent\.service$/m);
  assert.match(unit, /^After=.*\bnftables\.service$/m);
  assert.match(unit, /^PartOf=nftables\.service$/m);
  assert.match(unit, /^ReloadPropagatedFrom=nftables\.service$/m);
  assert.doesNotMatch(unit, /^(?:Requires|RequiredBy)=/m);
  assert.match(unit, /^Type=oneshot\nRemainAfterExit=yes$/m);
  for (const operation of ['ExecStart', 'ExecReload']) {
    assert.ok(unit.includes(`${operation}=@SCRIPT_PATH@ apply --pod-cidr @POD_CIDRS@ --tunnel-interface @TUNNEL_INTERFACE@ --node-ips @NODE_IPS@`));
  }
  assert.match(unit, /^ExecStop=@SCRIPT_PATH@ remove$/m);
});

test('invalid and missing arguments fail before external commands', t => {
  const f = fixture(t);
  for (const args of [[], [image, '--node'], [...distributeArgs, '--min-free-bytes', '-1'],
    [...distributeArgs, '--node', '-oProxyCommand=false'], [...distributeArgs, '--node', 'ops@192.0.2.10;false'],
    ['example.com/image:tag;false', ...distributeArgs.slice(1)], [...distributeArgs, '--unknown']]) {
    assert.notEqual(f.run('distribute-image.sh', args).status, 0);
  }
  assert.deepEqual(f.calls(), []);
});

for (const [family, addresses, cidr] of [
  ['ipv4', '192.0.2.10,192.0.2.11', '192.0.2.0/24'],
  ['ipv6', '2001:db8::10,2001:db8::11', '2001:db8::/64'],
]) {
  test(`node guard renders and applies ${family}-only sets without empty elements`, t => {
    const f = fixture(t);
    const args = [...guardArgs];
    args[args.indexOf('--node-ips') + 1] = addresses;
    args[args.indexOf('--pod-cidr') + 1] = cidr;
    const rendered = f.run('node-guard.sh', [...args, '--dry-run']);
    success(rendered);
    assert.deepEqual(f.calls(), []);
    for (const set of ['ipv4', 'ipv6']) {
      const body = rendered.stdout.match(new RegExp(`set node_${set} \\{([\\s\\S]*?)\\n    \\}`))[1];
      assert.match(body, new RegExp(`type ${set}_addr`));
      if (set === family) assert.ok(body.includes(`elements = { ${addresses.split(',').join(', ')} }`));
      else assert.doesNotMatch(body, /elements/);
    }
    assert.doesNotMatch(rendered.stdout, /elements\s*=\s*\{\s*\}|@[A-Z_]+@/);
    assert.equal(rendered.stdout.split('\n').filter(line => line.includes(cidr)).length, 1);
    assert.ok(rendered.stdout.includes(`# Configured Pod networks: ${cidr}`));
    assert.doesNotMatch(rendered.stdout, /\b(?:ip|ip6) saddr\b/);
    success(f.run('node-guard.sh', args));
    assert.deepEqual(f.calls().map(call => call.args.slice(0, -1)), [['-c', '-f'], ['-f']]);
    assert.ok(f.calls().every(call => call.text === rendered.stdout));
  });
}

test('node guard reports a missing Python dependency before rendering or nft calls', t => {
  const f = fixture(t);
  const emptyPath = path.join(f.dir, 'empty-bin'); fs.mkdirSync(emptyPath);
  const script = path.join(root, 'tools/k8s/node-guard.sh');
  const result = f.capture('/bin/bash', [script, ...guardArgs], { ...process.env, PATH: emptyPath });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-guard apply requires python3.*strict IP\/CIDR validation/);
  assert.deepEqual(f.calls(), []);
  const help = f.run('node-guard.sh', ['--help']); success(help);
  assert.match(help.stdout, /--pod-cidr is recorded\s+only, not matched/);
  assert.match(help.stdout, /reload node-guard: restart briefly removes the rules/);
  assert.match(help.stdout, /fail-open: k3s still starts if apply fails/);
  assert.match(help.stdout, /Operators decide whether\s+to add RequiredBy=/);
});

for (const archiveFormat of ['docker', 'oci', 'oci-nested']) {
  test(`distribution uses the ${archiveFormat} archive config digest despite a different Docker inspect ID`, t => {
    const f = fixture(t, { archiveFormat, dockerId: oldId, existing: { [targets[0]]: id, [targets[1]]: id } });
    success(f.run('distribute-image.sh', distributeArgs));
    const calls = f.calls();
    assert.equal(calls.filter(c => c.tool === 'docker' && c.args[0] === 'save').length, 1);
    assert.deepEqual(calls.filter(c => c.tool === 'k3s' && c.args.includes('import')).map(c => c.stdin),
      targets.map(() => f.archive.toString('base64')));
    assert.equal(JSON.parse(f.state().registry.data['images.json'])[image], id);
    assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith('tmp.')), false);
  });
}

for (const settings of [{ archiveFormat: 'oci-multiple' }, { archiveFormat: 'oci-corrupt' }, { corruptArchive: true }]) {
  test(`distribution rejects invalid or ambiguous archives before remote mutations: ${JSON.stringify(settings)}`, t => {
    const f = fixture(t, settings);
    const result = f.run('distribute-image.sh', distributeArgs);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /single-platform|digest mismatch|Invalid archive data/);
    assert.equal(f.calls().some(c => c.tool === 'k3s'), false);
    assert.deepEqual(mutations(f.calls()), []);
    assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith('tmp.')), false);
  });
}

for (const stage of ['import', 'label', 'inspect']) {
  test(`failure on the second node at ${stage} lists imported and possibly changed nodes with recovery`, t => {
    const f = fixture(t, { fail: stage, failTarget: targets[1] });
    const result = f.run('distribute-image.sh', distributeArgs);
    assert.notEqual(result.status, 0);
    const imported = stage === 'import' ? targets.slice(0, 1) : targets;
    assert.ok(result.stderr.includes(`Imported nodes: ${imported.join(' ')}\n`));
    assert.ok(result.stderr.includes(`Changed or possibly partially changed nodes: ${targets.join(' ')}\n`));
    assert.match(result.stderr, /--unpin IMAGE.*rerun distribution.*--replace/);
    assert.match(result.stderr, /Unpin does not restore old tags/);
    assert.deepEqual(mutations(f.calls()), []);
    assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith('tmp.')), false);
  });
}

test('registration and unpin failures report nodes already changed', t => {
  for (const stage of ['get', 'patch', 'create']) {
    const f = fixture(t, { fail: stage, ...(stage === 'create' ? { registry: null } : {}) });
    const result = f.run('distribute-image.sh', distributeArgs);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`Imported nodes: ${targets.join(' ')}\n`));
    assert.match(result.stderr, /--unpin IMAGE.*rerun distribution/);
  }
  const f = fixture(t, { fail: 'label', failTarget: targets[1], existing: { [targets[0]]: id, [targets[1]]: id } });
  const result = f.run('distribute-image.sh', ['--unpin', image, ...distributeArgs.slice(1, 5)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Imported nodes: \(none confirmed\)/);
  assert.ok(result.stderr.includes(`Changed or possibly partially changed nodes: ${targets.join(' ')}\n`));
  assert.match(result.stderr, /--unpin IMAGE.*rerun distribution/);
});

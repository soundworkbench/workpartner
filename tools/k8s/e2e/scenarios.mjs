import { assert, delay, until } from './context.mjs';

const command = script => ['node', '-e', script];
const counts = pod => Object.fromEntries((pod.status.containerStatuses || []).map(c => [c.name, c.restartCount]));
const rejected = async (fn, pattern) => assert.rejects(fn, pattern);
const read = async (c, slug, path) => c.runtime.exec(slug, command('process.stdout.write(require("node:fs").readFileSync(process.argv[1]))').concat(path));
async function once(c, slug, script, name = 'probe') {
  return c.runtime.runOnce(slug, { name, entrypoint: ['node'], cmd: ['-e', script], timeoutMs: 30000 });
}
async function checkMatrix(c, source, targets, rows) {
  for (const target of targets) {
    const result = await c.from(source, target);
    rows.push({ source, ...target, expectedOpen: target.open, ...result });
    c.evidence = { rows };
    assert.equal(result.open, target.open, `${source}: ${target.label}`);
  }
}
async function waitForPolicy(c, slugs, check) {
  let slug;
  try {
    await until(async () => {
      for (slug of slugs) await check(slug);
      return true;
    }, c.config.policyTimeoutMs ?? 60000, 200);
  } catch (error) {
    const last = error.cause;
    const reason = `Policy convergence timed out for Pod ${c.name(slug)}-0 (${slug}); last error: ${last?.reason || last?.message || String(last)}`;
    throw Object.assign(new Error(reason, { cause: error }), { reason });
  }
}
export const scenarios = [
  { id: 'S1', title: 'Lifecycle and persistent data', async run(c) {
    const s = 'lifecycle', r = c.runtime;
    await c.create(s);
    const created = await r.inspect(s);
    assert.equal(created.exists, true); assert.equal(created.running, false); assert.equal(created.replicas, 0);
    assert.deepEqual(created.annotations['workpartner/paused'], undefined);
    await c.ready(s);
    await r.putFiles(s, [{ path: 'persistent.txt', content: 'survives recreation' }]);
    await r.stop(s); assert.equal(await c.pod(s), null);
    await c.ready(s); const before = await c.pod(s);
    await r.restart(s); const after = await c.pod(s);
    assert.notEqual(before.metadata.uid, after.metadata.uid);
    await r.remove(s); assert.equal((await r.inspect(s)).exists, false);
    assert.equal(await c.client.get(`/apis/apps/v1/namespaces/${c.ns}/statefulsets/${c.name(s)}`), null);
    assert.ok(await c.client.get(`${c.core}/persistentvolumeclaims/${c.name(s)}-data`));
    await c.create(s); await c.ready(s);
    assert.equal(await r.readFile(s, 'persistent.txt'), 'survives recreation');
    return { oldUid: before.metadata.uid, newUid: after.metadata.uid, pvcRetained: true };
  } },
  { id: 'S2', title: 'Concurrent lifecycle never overlaps Pods', async run(c) {
    const s = 'concurrent'; await c.create(s);
    let done = false, violation, samples = 0, maximum = 0;
    const monitor = (async () => {
      while (!done) {
        try {
          // Include terminating Pods: they may still have live processes.
          const all = await c.pods(s);
          const pods = all.filter(p => !['Succeeded', 'Failed'].includes(p.status?.phase));
          const overlap = all.some(p => p.metadata.name === `${c.name(s)}-0`)
            && all.some(p => p.metadata.labels?.['workpartner/role'] === 'job');
          samples++; maximum = Math.max(maximum, pods.length);
          if (pods.length > 1 || overlap) {
            violation = new Error('Concurrent live Pods detected');
            for (const pod of all.filter(p => p.metadata.name !== `${c.name(s)}-0`)) {
              await c.client.remove(`${c.core}/pods/${pod.metadata.name}`);
            }
            break;
          }
        } catch (error) { violation = error; break; }
        await delay(200);
      }
    })();
    const operations = [];
    // Fixed, reproducible disorder: each operation occurs exactly ten times.
    const orders = [['start', 'runOnce', 'stop', 'restart'], ['restart', 'stop', 'runOnce', 'start'], ['stop', 'start', 'restart', 'runOnce']];
    for (let round = 0; round < 10; round++) for (const op of orders[round % orders.length]) operations.push(op);
    let results;
    try {
      results = await Promise.allSettled(operations.map(async op => {
        try {
          if (op === 'runOnce') await once(c, s, 'setTimeout(()=>process.exit(0),500)', 'race');
          else await c.runtime[op](s);
          return { op, status: 'fulfilled' };
        } catch (error) {
          // Only runOnce's explicit single-instance refusal is expected.
          if (op !== 'runOnce' || !/still has a Pod|active StatefulSet|already.*Pod/i.test(error.message)) throw error;
          return { op, status: 'rejected-active-pod' };
        }
      }));
    } finally { done = true; await monitor; }
    c.evidence = { intervalMs: 200, samples, maximum };
    if (violation) { await c.runtime.stop(s); throw violation; }
    const unexpected = results.find(result => result.status === 'rejected');
    if (unexpected) throw unexpected.reason;
    results = results.map(result => result.value);
    assert.ok(samples > 1); assert.ok(maximum <= 1);
    await c.runtime.stop(s);
    return { intervalMs: 200, samples, maximum, operations: results };
  } },
  { id: 'S3', title: 'Exec streams, bounds and detached process', async run(c) {
    const s = 'lifecycle', r = c.runtime;
    const result = await r.exec(s, command('process.stdout.write("one");setTimeout(()=>{process.stderr.write("two");setTimeout(()=>{process.stdout.write("three");process.exit(7)},150)},150)'));
    assert.equal(result.exitCode, 7); assert.equal(result.stdout, 'onethree'); assert.equal(result.stderr, 'two'); assert.equal(result.logs, 'onetwothree');
    const echo = await r.exec(s, command('process.stdin.pipe(process.stdout)'), { stdin: 'stdin-value' });
    assert.equal(echo.exitCode, 0); assert.equal(echo.stdout, 'stdin-value');
    const env = await r.exec(s, command('process.stdout.write(process.env.E2E_VALUE)'), { env: ['E2E_VALUE=spaces ; $ remain literal'] });
    assert.equal(env.stdout, 'spaces ; $ remain literal');
    await rejected(() => r.exec(s, command('process.stdout.write("x".repeat(4096))'), { maxOutputBytes: 64 }), error => /Output|Limit/i.test(error.reason || error.message));
    await rejected(() => r.exec(s, command('setTimeout(()=>{},10000)'), { timeout: 100 }), error => /Timeout/i.test(error.reason || error.message));
    await rejected(() => r.exec(s, ['id'], { user: '0' }), /user/i);
    const before = counts(await c.pod(s));
    assert.equal((await r.exec(s, command('require("node:fs").writeFileSync("/data/detached.pid",String(process.pid));setTimeout(()=>{},60000)'), { detached: true })).exitCode, null);
    await until(async () => (await read(c, s, '/data/detached.pid')).exitCode === 0);
    await delay(1200);
    assert.equal((await r.exec(s, command('const f=require("node:fs");process.kill(+f.readFileSync("/data/detached.pid"),0)'))).exitCode, 0);
    assert.deepEqual(counts(await c.pod(s)), before);
    await r.exec(s, command('process.kill(+require("node:fs").readFileSync("/data/detached.pid"),"SIGTERM")'));
    return { exitCode: result.exitCode, streamOrder: result.logs, restartCount: before };
  } },
  { id: 'S4', title: 'Process parent and child', async run(c) {
    const rows = await c.runtime.processes('lifecycle');
    const parent = rows.find(row => row.args.includes('/cc-connect.mjs'));
    assert.ok(parent); const child = rows.find(row => row.ppid === parent.pid && row.args.includes('/cc-child.mjs'));
    assert.ok(child); assert.equal(typeof child.pid, 'string');
    return { parent: parent.pid, child: child.pid };
  } },
  { id: 'S5', title: 'Published files and safe staging leases', async run(c) {
    const s = 'lifecycle', r = c.runtime, updates = [];
    for (const version of [1, 2]) {
      const files = [
        { path: '.zp-market-token', content: `fixture-token-${version}` },
        { path: '.wp-feishu-cli.json', content: JSON.stringify({ fixture: version }) },
        { path: '.zp-preview-relay-key', content: String(version).repeat(64) },
      ];
      const start = Date.now();
      await r.putFiles(s, files);
      await until(async () => {
        const values = await Promise.all(files.map(file => read(c, s, `/data/${file.path}`)));
        return values.every((value, index) => value.exitCode === 0 && value.stdout === files[index].content);
      }, 90000, 1000);
      updates.push(Date.now() - start);
    }
    // The real relay reads its key at startup, so reload after the rotation assertion.
    await r.restart(s); await c.ready(s);
    await rejected(() => r.readFile(s, 'missing-file'), { code: 'ENOENT' });
    const lease = await r.putFiles(s, [{ path: 'stage/upload', content: 'archive' }], { cleanup: ['stage/upload'] });
    assert.equal(await r.readFile(s, 'stage/upload'), 'archive');
    assert.equal((await r.exec(s, command('const f=require("node:fs");f.renameSync("/data/stage","/data/retained");f.mkdirSync("/data/stage");f.writeFileSync("/data/stage/upload","replacement")'))).exitCode, 0);
    await r.removeFiles(s, ['stage/upload'], lease);
    await rejected(() => r.readFile(s, 'retained/upload'), { code: 'ENOENT' });
    assert.equal(await r.readFile(s, 'stage/upload'), 'replacement');
    for (const path of ['../escape', '/absolute', 'a/../escape', 'a\\b']) {
      await rejected(() => r.putFiles(s, [{ path, content: 'bad' }]), /path/i);
      await rejected(() => r.readFile(s, path), /path/i);
      await rejected(() => r.removeFiles(s, [path]), /path/i);
    }
    await r.exec(s, command('const f=require("node:fs");f.writeFileSync("/tmp/e2e-target","untouched");f.symlinkSync("/tmp/e2e-target","/data/link");f.symlinkSync("/tmp","/data/link-dir")'));
    await rejected(() => r.readFile(s, 'link'));
    await rejected(() => r.putFiles(s, [{ path: 'link-dir/e2e-target', content: 'bad' }]));
    await r.putFiles(s, [{ path: 'link', content: 'replacement' }]);
    assert.equal((await read(c, s, '/tmp/e2e-target')).stdout, 'untouched');
    return { publishedUpdateMs: updates, leaseRetainsDirectory: true, symlinkTargetUnchanged: true };
  } },
  { id: 'S6', title: 'Offline one-off reset', async run(c) {
    const s = 'lifecycle';
    await rejected(() => c.runtime.runOnce(s, { entrypoint: ['aionui-web'], cmd: ['resetpass'] }), /Pod|StatefulSet/i);
    await c.runtime.stop(s);
    const reset = await c.runtime.runOnce(s, { entrypoint: ['aionui-web'], cmd: ['resetpass'] });
    assert.equal(reset.exitCode, 0); assert.match(reset.logs, /new password: [a-f0-9]+/);
    const gateway = new URL(c.org.runtime.gatewayOrigin);
    const result = await once(c, s, `const n=require('node:net');const s=n.connect(${Number(gateway.port)},${JSON.stringify(gateway.hostname)});s.setTimeout(2000);s.on('connect',()=>process.exit(9));s.on('error',()=>process.exit(0));s.on('timeout',()=>{s.destroy();process.exit(0)})`);
    assert.equal(result.exitCode, 0); assert.deepEqual(await c.pods(s), []);
    const nonzero = await once(c, s, 'process.exit(17)', 'nonzero'); assert.equal(nonzero.exitCode, 17);
    await c.ready(s);
    return { resetExitCode: reset.exitCode, passwordLinePresent: true, networkDenied: true, nonzeroExitCode: nonzero.exitCode };
  } },
  { id: 'S7', title: 'Image identity and unregistered reference', async run(c) {
    const info = await c.runtime.inspect('lifecycle');
    const current = await c.runtime.imageId(c.org.runtime.nextImage);
    assert.notEqual(current, info.imageId); assert.equal(current, c.config.changedImageId);
    const unknown = c.makeRuntime({ image: `${c.org.runtime.nextImage}-unregistered` });
    await rejected(() => c.create('unregistered', unknown), /register|image/i);
    assert.equal((await unknown.inspect('unregistered')).exists, false);
    return { storedId: info.imageId, registeredId: current, unregisteredRejected: true };
  } },
  { id: 'S8', title: 'Dynamic and static scheduling', async run(c) {
    for (const [slug, node] of [['node-server', c.config.serverNode], ['node-agent', c.config.agentNode]]) {
      const rt = c.makeRuntime({ newUserNodeSelector: { 'kubernetes.io/hostname': node } });
      await c.create(slug, rt); await c.ready(slug, rt);
      assert.equal((await c.pod(slug)).spec.nodeName, node);
    }
    const evidence = { dynamicAgent: c.config.agentNode, dynamicServer: c.config.serverNode };
    if (!c.config.staticPvNode) evidence.static = { status: 'SKIP', reason: 'No static node/directory access supplied' };
    else {
      await c.create('static'); await c.ready('static');
      assert.equal((await c.pod('static')).spec.nodeName, c.config.staticPvNode);
      evidence.static = { status: 'PASS', node: c.config.staticPvNode };
    }
    return evidence;
  } },
  { id: 'S9', title: 'Missing policy fails closed', async run(c, phase) {
    if (phase === 'prepare') { await c.runtime.stop('lifecycle'); return {}; }
    if (phase === 'missing') {
      await rejected(() => c.runtime.start('lifecycle'), /policy/i);
      assert.equal(await c.pod('lifecycle'), null); return { refused: true };
    }
    await c.ready('lifecycle'); return { recovered: true };
  } },
  { id: 'S10', title: 'Two-node network matrix', async run(c) {
    const rows = [], gateway = new URL(c.org.runtime.gatewayOrigin), model = new URL(c.org.model.baseUrl);
    await waitForPolicy(c, ['node-server', 'node-agent'], async slug => {
      const dns = await c.from(slug, { kind: 'dns', host: gateway.hostname });
      assert.deepEqual([...new Set(dns)], [c.config.gatewayIp]);
    });
    for (const slug of ['node-server', 'node-agent']) {
      const dns = await c.from(slug, { kind: 'dns', host: gateway.hostname });
      assert.deepEqual([...new Set(dns)], [c.config.gatewayIp]);
      rows.push({ source: slug, kind: 'dns', matchesGatewayPod: true });
      const other = await c.pod(slug === 'node-server' ? 'node-agent' : 'node-server');
      const cni = await c.from(slug, { kind: 'route' });
      const targets = [
        { host: gateway.hostname, port: c.org.runtime.gatewayPort, open: true, label: 'gateway HTTP' },
        { host: gateway.hostname, port: c.org.runtime.internalPort, open: true, label: 'gateway internal' },
        { host: model.hostname, port: +model.port, open: true, label: 'model egress' },
        { host: c.config.gatewayIp, port: c.config.samplePort, open: false, label: 'gateway other listening port' },
        ...[25808, 3092].map(port => ({ host: other.status.podIP, port, open: false, label: 'other user' })),
        ...c.config.nodeIps.flatMap(host => [22, 6443, 10250, c.config.samplePort].map(port => ({ host, port, open: false, label: 'node' }))),
        { host: cni, port: c.config.samplePort, open: false, label: 'local cni0' },
        { ...c.config.apiProbe, open: false, label: 'API service' },
        { host: '169.254.169.254', port: 80, open: false, label: 'metadata' },
        { ...c.config.privateProbe, open: false, label: 'private sample' },
      ];
      if (c.config.externalProbe) targets.push({ ...c.config.externalProbe, open: true, label: 'external' });
      await checkMatrix(c, slug, targets, rows);
      const pod = await c.pod(slug);
      for (const port of [25808, 3092]) {
        assert.equal((await c.probe({ host: pod.status.podIP, port })).open, true, 'gateway to user');
        assert.equal((await c.fromProbe({ host: pod.status.podIP, port })).open, false, 'probe namespace to user');
        rows.push({ source: 'gateway/probe', target: slug, port, gatewayAllowed: true, probeDenied: true });
      }
      // Run the job on this user's bound volume/node, testing IPs as well as DNS.
      await c.runtime.stop(slug);
      const jobTargets = targets.map(({ host, port }) => ({ host, port })).concat([
        { host: c.config.gatewayIp, port: c.org.runtime.gatewayPort },
        { host: other.status.podIP, port: 25808 }, { ...c.config.apiProbe },
        ...c.config.nodeIps.map(host => ({ host, port: c.config.samplePort })),
      ]);
      const script = `const net=require('node:net');const targets=${JSON.stringify(jobTargets)}; Promise.all(targets.map(t=>new Promise(r=>{const s=net.connect(t.port,t.host);const done=v=>{s.destroy();r(v)};s.setTimeout(1500,()=>done(false));s.on('error',()=>done(false));s.on('connect',()=>done(true))}))).then(v=>{console.log(JSON.stringify(v));process.exit(v.some(Boolean)?9:0)})`;
      try { const result = await once(c, slug, script, 'matrix'); assert.equal(result.exitCode, 0, 'job network must be denied'); }
      finally { await c.ready(slug); }
      rows.push({ source: `${slug}/job`, deniedTargets: jobTargets.length });
    }
    return { rows, external: c.config.externalProbe ? 'PASS' : 'SKIP: no --external-probe' };
  } },
  { id: 'S11', title: 'Relay authenticates gateway source address', async run(c) {
    const results = [];
    for (const slug of ['node-server', 'node-agent']) {
      const key = await c.runtime.readFile(slug, '.zp-preview-relay-key');
      const p = await c.pod(slug);
      const spec = { kind: 'http', host: p.status.podIP, port: 3092, headers: { 'x-zp-relay-key': key, 'x-zp-preview-port': '18080' } };
      await until(async () => {
        assert.equal((await c.probe(spec)).status, 200);
        assert.equal((await c.fromProbe(spec)).status, 403);
        return true;
      }, c.config.policyTimeoutMs ?? 60000, 200);
      results.push({ slug, gatewayStatus: 200, otherPodStatus: 403 });
    }
    return results;
  } },
  { id: 'S12', title: 'nft alone denies node access', async run(c) {
    if (!c.config.guard) return { status: 'SKIP', reason: '--guard not supplied' };
    const rows = [];
    for (const slug of ['node-server', 'node-agent']) {
      const cni = await c.from(slug, { kind: 'route' });
      await waitForPolicy(c, [slug], async () => {
        // Only the allowed control may retry while policy removal converges.
        assert.equal((await c.from(slug, { host: c.config.gatewayIp, port: c.config.samplePort })).open, true);
      });
      await checkMatrix(c, slug, [...new Set([...c.config.nodeIps, cni])].flatMap(host => [22, c.config.samplePort].map(port => ({ host, port, open: false, label: 'nft node denial' }))), rows);
      // These are documented exceptions, not negative assertions.
      for (const host of c.config.nodeIps) for (const port of [6443, 10250]) rows.push({ source: slug, host, port, exception: true, ...await c.from(slug, { host, port }) });

    }
    return { rows, exceptions: [6443, 10250] };
  } },
  { id: 'S13', title: 'Gateway restart preserves users and takes ownership', async run(c, phase) {
    if (phase === 'prepare') {
      await c.create('takeover');
      const users = {};
      for (const slug of ['lifecycle', 'node-server', 'node-agent']) {
        const pod = await c.pod(slug); users[slug] = { uid: pod.metadata.uid, restarts: counts(pod) };
      }
      return { users };
    }
    for (const [slug, old] of Object.entries(c.config.beforeRestart.users)) {
      const pod = await c.pod(slug);
      assert.equal(pod.metadata.uid, old.uid); assert.deepEqual(counts(pod), old.restarts);
      assert.equal((await c.runtime.inspect(slug)).running, true);
    }
    await until(async () => (await c.runtime.inspect('takeover')).running);
    assert.equal((await c.runtime.inspect('takeover')).replicas, 1);
    return { unchangedUsers: Object.keys(c.config.beforeRestart.users), takeover: 'started by K3 keepRunning' };
  } },
];

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKubeClient } from '../gateway/runtime/kube-client.mjs';
import { createCertificate, createFakeKube, sendChannel, sendStatus } from './fixtures/fake-kube.mjs';

const secret = 'fixture-secret-never-in-errors';
const encode = value => Buffer.from(value).toString('base64');
const resource = '/api/v1/namespaces/users/secrets';

function kubeconfig(server, user = { token: secret }, cluster = {}) {
  return { 'current-context': 'selected', contexts: [
    { name: 'unused', context: { cluster: 'unused', user: 'unused' } },
    { name: 'selected', context: { cluster: 'cluster', user: 'client', namespace: 'users' } },
  ], clusters: [{ name: 'cluster', cluster: { server, ...cluster } }], users: [{ name: 'client', user }] };
}

async function fake(t, options) {
  const server = await createFakeKube(options);
  t.after(() => server.close());
  return server;
}

function client(server, options = {}) {
  return createKubeClient({ kubeconfigJson: kubeconfig(server.url), ...options });
}

function safeError(reason, status = 0) {
  return error => {
    assert.equal(error.status, status);
    assert.equal(error.reason, reason);
    assert.equal(String(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.stack.includes(secret), false);
    assert.equal(error.cause, undefined);
    return true;
  };
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-kube-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('REST selects the kubeconfig context, authenticates, and sends JSON and both patch types', async t => {
  const server = await fake(t, { onRequest(record, res) {
    res.statusCode = record.method === 'POST' ? 201 : 200;
    res.end(JSON.stringify(record.body || { kind: 'SecretList', items: [] }));
  } });
  const api = client(server, { kubeconfigJson: JSON.stringify(kubeconfig(server.url)) });
  assert.equal(api.namespace, 'users');
  assert.deepEqual(await api.get(resource), { kind: 'SecretList', items: [] });
  const body = { metadata: { name: 'published' }, stringData: { token: secret } };
  assert.deepEqual(await api.create(resource, body), body);
  const merge = { data: { token: null } };
  assert.deepEqual(await api.patch(`${resource}/published`, merge, 'merge'), merge);
  const patch = [{ op: 'replace', path: '/metadata/labels/role', value: 'user' }];
  assert.deepEqual(await api.patch(`${resource}/published`, patch, 'json'), patch);
  assert.equal(await api.remove(`${resource}/published`, { propagationPolicy: 'Foreground', gracePeriodSeconds: 10 }), true);
  assert.deepEqual(server.requests.map(r => r.method), ['GET', 'POST', 'PATCH', 'PATCH', 'DELETE']);
  for (const record of server.requests) assert.equal(record.headers.authorization, `Bearer ${secret}`);
  assert.equal(server.requests[1].headers['content-type'], 'application/json');
  assert.equal(server.requests[1].headers['content-length'], String(Buffer.byteLength(JSON.stringify(body))));
  assert.equal(server.requests[2].headers['content-type'], 'application/merge-patch+json');
  assert.equal(server.requests[3].headers['content-type'], 'application/json-patch+json');
  assert.deepEqual(server.requests[4].body, { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground', gracePeriodSeconds: 10 });
  await assert.rejects(api.patch(resource, {}, secret), safeError('InvalidPatchType'));
  assert.equal(server.requests.length, 5);
});

test('REST maps missing objects and conflicts, ignores sensitive response details, and never follows redirects', async t => {
  const server = await fake(t, { onRequest(record, res) {
    const status = Number(new URL(record.path, 'http://example.com').searchParams.get('status'));
    res.statusCode = status;
    if (status === 302) res.setHeader('Location', `http://example.com/${secret}`);
    res.end(JSON.stringify({ reason: status === 403 ? 'Forbidden' : secret, message: secret, details: { secret } }));
  } });
  const api = client(server);
  assert.equal(await api.get(`${resource}/missing?status=404`), null);
  assert.equal(await api.remove(`${resource}/missing?status=404`), false);
  await assert.rejects(api.create(`${resource}?status=409`, { secret }), safeError('AlreadyExists', 409));
  await assert.rejects(api.patch(`${resource}/published?status=409`, { secret }), safeError('Conflict', 409));
  await assert.rejects(api.get(`${resource}?status=403`), safeError('Forbidden', 403));
  await assert.rejects(api.get(`${resource}?status=302`), safeError('ApiError', 302));
  assert.equal(server.requests.length, 6);
});

test('REST handles empty success, invalid JSON, transport aborts, and an overall deadline', async t => {
  const server = await fake(t, { onRequest(record, res) {
    if (record.path === '/empty') { res.statusCode = 204; res.end(); }
    if (record.path === '/invalid') res.end(secret);
    if (record.path === '/abort') { res.write('{'); res.socket.destroy(); }
    if (record.path === '/slow') {
      const timer = setInterval(() => res.write(' '), 5);
      res.on('close', () => clearInterval(timer));
    }
  } });
  const api = client(server, { timeoutMs: 80 });
  assert.equal(await api.remove('/empty'), true);
  await assert.rejects(api.get('/invalid'), safeError('InvalidResponse', 200));
  await assert.rejects(api.get('/abort'), safeError('TransportError'));
  await assert.rejects(api.get('/slow'), safeError('Timeout'));
  const cycle = { secret }; cycle.self = cycle;
  await assert.rejects(api.create(resource, cycle), safeError('InvalidBody'));
  await assert.rejects(api.get(`//example.com/${secret}`), safeError('InvalidPath'));
});

test('ServiceAccount rereads token and CA for REST, logs, and exec requests', async t => {
  const directory = temporary(t), material = createCertificate(), other = createCertificate();
  const server = await fake(t, { tls: material, onRequest(record, res) {
    res.end(record.path.includes('/log?') ? 'line\n' : '{}');
  } });
  const tokenFile = path.join(directory, 'token'), caFile = path.join(directory, 'ca.crt'), namespaceFile = path.join(directory, 'namespace');
  fs.writeFileSync(tokenFile, `${secret}\n`);
  fs.writeFileSync(caFile, material.cert);
  fs.writeFileSync(namespaceFile, 'users\n');
  const api = createKubeClient({ inCluster: { server: server.url, tokenFile, caFile, namespaceFile } });
  assert.equal(api.namespace, 'users');
  await api.get(resource);
  fs.writeFileSync(tokenFile, `${secret}-rotated\n`);
  await api.create(resource, {});
  assert.equal(await api.logs('users', 'workspace-0', 'main'), 'line\n');
  await api.exec('users', 'workspace-0', 'main', ['true']);
  assert.equal(server.requests[0].headers.authorization, `Bearer ${secret}`);
  for (const record of [...server.requests.slice(1), ...server.executions]) assert.equal(record.headers.authorization, `Bearer ${secret}-rotated`);
  fs.writeFileSync(caFile, other.cert);
  await assert.rejects(api.get(resource), safeError('TransportError'));
  await assert.rejects(api.exec('users', 'workspace-0', 'main', ['true']), safeError('TransportError'));
  fs.writeFileSync(caFile, material.cert);
  await api.get(resource);
  fs.rmSync(tokenFile);
  await assert.rejects(api.get(resource), safeError('CredentialsUnavailable'));
  await assert.rejects(api.exec('users', 'workspace-0', 'main', ['true']), safeError('CredentialsUnavailable'));
});

test('flattened JSON kubeconfig supports verified TLS and client certificate authentication', async t => {
  const material = createCertificate();
  const server = await fake(t, { tls: { ...material, ca: material.cert, requestCert: true, rejectUnauthorized: true } });
  const config = kubeconfig(server.url, { 'client-certificate-data': encode(material.cert), 'client-key-data': encode(material.key) },
    { 'certificate-authority-data': encode(material.cert) });
  const api = createKubeClient({ kubeconfigJson: config });
  await api.get(resource);
  await api.exec('users', 'workspace-0', 'main', ['true']);
  assert.equal(server.requests[0].authorized, true);
  assert.equal(server.executions[0].authorized, true);
  assert.equal(server.requests[0].headers.authorization, undefined);
  const untrusted = client(server);
  await assert.rejects(untrusted.get(resource), safeError('TransportError'));
});

test('configuration errors never quote credentials, malformed JSON, or file paths', () => {
  for (const value of [secret, `{"token":"${secret}"`, {}, kubeconfig('https://example.com', { exec: { command: secret } }),
    kubeconfig('https://example.com', {}), kubeconfig('https://example.com', { token: secret }, { 'insecure-skip-tls-verify': true }),
    kubeconfig(`https://${secret}@example.com`), kubeconfig('https://example.com', { 'client-certificate-data': encode(secret) })]) {
    assert.throws(() => createKubeClient({ kubeconfigJson: value }), safeError('InvalidConfiguration'));
  }
  assert.throws(() => createKubeClient({ inCluster: { namespaceFile: `/missing/${secret}` } }), safeError('InvalidConfiguration'));
});

test('kubeconfig namespace defaults to default and preserves a server URL prefix', async t => {
  const server = await fake(t);
  const config = kubeconfig(`${server.url}/cluster`);
  delete config.contexts[1].context.namespace;
  const api = createKubeClient({ kubeconfigJson: config });
  assert.equal(api.namespace, 'default');
  await api.get(resource);
  assert.equal(server.requests[0].path, `/cluster${resource}`);
});

test('exec prefers v5, encodes repeated command arguments, and preserves output arrival order', async t => {
  const server = await fake(t, { onExec(socket) {
    sendChannel(socket, 1, 'first'); sendChannel(socket, 2, 'warning'); sendChannel(socket, 1, 'last'); sendStatus(socket);
  } });
  const result = await client(server).exec('users', 'workspace-0', 'main', ['sh', '-c', 'printf "a & b"']);
  assert.deepEqual(result, { exitCode: 0, stdout: 'firstlast', stderr: 'warning', logs: 'firstwarninglast' });
  const record = server.executions[0];
  assert.equal(record.path, '/api/v1/namespaces/users/pods/workspace-0/exec');
  assert.deepEqual(record.query.getAll('command'), ['sh', '-c', 'printf "a & b"']);
  assert.equal(record.query.get('container'), 'main');
  assert.equal(record.query.get('stdin'), 'false');
  assert.equal(record.query.get('stdout'), 'true');
  assert.equal(record.query.get('stderr'), 'true');
  assert.equal(record.query.get('tty'), 'false');
  assert.equal(record.protocol, 'v5.channel.k8s.io');
  assert.equal(record.headers.authorization, `Bearer ${secret}`);
});

test('exec decodes UTF-8 across output messages and parses nonzero status causes', async t => {
  const server = await fake(t, { onExec(socket) {
    const output = Buffer.from('result: ✓');
    sendChannel(socket, 1, output.subarray(0, -1)); sendChannel(socket, 1, output.subarray(-1));
    sendChannel(socket, 2, 'failed');
    sendChannel(socket, 3, JSON.stringify({ status: 'Failure', reason: 'NonZeroExitCode', message: secret,
      details: { causes: [{ reason: 'Other', message: secret }, { reason: 'ExitCode', message: '23' }] } }));
    socket.close();
  } });
  assert.deepEqual(await client(server).exec('users', 'workspace-0', 'main', ['false']), {
    exitCode: 23, stdout: 'result: ✓', stderr: 'failed', logs: 'result: ✓failed',
  });
});

test('exec sends stdin and v5 EOF without closing the output streams, including empty and large inputs', async t => {
  const server = await fake(t, { onExec(socket) {
    socket.on('message', data => {
      if (data[0] === 0) sendChannel(socket, 1, data.subarray(1));
      else if (data.equals(Buffer.from([255, 0]))) { sendChannel(socket, 2, 'eof'); sendStatus(socket); }
    });
  } });
  const api = client(server);
  for (const stdin of ['', 'input\n✓', Buffer.from('bytes'), Buffer.alloc(150000, 120)]) {
    const result = await api.exec('users', 'workspace-0', 'main', ['cat'], { stdin });
    assert.deepEqual(result, { exitCode: 0, stdout: String(stdin), stderr: 'eof', logs: `${stdin}eof` });
    const record = server.executions.at(-1);
    assert.equal(record.query.get('stdin'), 'true');
    assert.deepEqual(record.frames.at(-1), Buffer.from([255, 0]));
    assert.deepEqual(Buffer.concat(record.frames.slice(0, -1).map(frame => frame.subarray(1))), Buffer.from(stdin));
  }
});

test('exec permits v4 only when stdin is absent', async t => {
  const server = await fake(t, { protocols: ['v4.channel.k8s.io'] });
  const api = client(server);
  assert.equal((await api.exec('users', 'workspace-0', 'main', ['true'])).exitCode, 0);
  assert.equal(server.executions[0].protocol, 'v4.channel.k8s.io');
  await assert.rejects(api.exec('users', 'workspace-0', 'main', ['cat'], { stdin: '' }), safeError('TransportError'));
});

test('exec deadlines cover idle execution and stalled handshakes and disconnect the socket', async t => {
  const server = await fake(t, { onExec() {} });
  const api = client(server);
  await assert.rejects(api.exec('users', 'workspace-0', 'main', ['sleep'], { timeoutMs: 40 }), safeError('Timeout'));
  await api.waitFor(() => server.sockets.size === 0, { intervalMs: 5 });
  const stalled = await fake(t, { onUpgrade() { return false; } });
  await assert.rejects(client(stalled).exec('users', 'workspace-0', 'main', ['true'], { connectTimeoutMs: 40 }), safeError('ConnectTimeout'));
});

test('exec enforces the combined stdout/stderr byte limit and disconnects on overflow', async t => {
  const server = await fake(t, { onExec(socket) {
    sendChannel(socket, 1, '✓'); sendChannel(socket, 2, '12'); sendStatus(socket);
  } });
  const api = client(server);
  assert.equal((await api.exec('users', 'workspace-0', 'main', ['true'], { maxOutputBytes: 5 })).logs, '✓12');
  await assert.rejects(api.exec('users', 'workspace-0', 'main', ['true'], { maxOutputBytes: 4 }), safeError('OutputLimitExceeded'));
  await api.waitFor(() => server.sockets.size === 0, { intervalMs: 5 });
});

test('exec rejects an oversized WebSocket message before retaining the payload', async t => {
  const server = await fake(t, { onExec(socket) { sendChannel(socket, 1, Buffer.alloc(70000)); } });
  const api = client(server);
  await assert.rejects(api.exec('users', 'workspace-0', 'main', ['true'], { maxOutputBytes: 10 }), safeError('OutputLimitExceeded'));
  await api.waitFor(() => server.sockets.size === 0, { intervalMs: 5 });
});

test('exec validates options before connecting and accepts zero output when the cap is zero', async t => {
  const server = await fake(t);
  const api = client(server);
  for (const options of [{ timeoutMs: 0 }, { connectTimeoutMs: -1 }, { maxOutputBytes: -1 }, { stdin: { secret } }]) {
    await assert.rejects(api.exec('users', 'workspace-0', 'main', ['true'], options), safeError('InvalidOptions'));
  }
  await assert.rejects(api.exec('users', 'workspace-0', 'main', []), safeError('InvalidOptions'));
  assert.equal(server.executions.length, 0);
  assert.deepEqual(await api.exec('users', 'workspace-0', 'main', ['true'], { maxOutputBytes: 0 }), {
    exitCode: 0, stdout: '', stderr: '', logs: '',
  });
});

test('exec rejects malformed statuses, missing status, invalid channels, and abnormal closes without leaking output', async t => {
  const scenarios = [
    [socket => { sendChannel(socket, 3, secret); socket.close(); }, 'InvalidExecStatus'],
    [socket => { sendChannel(socket, 3, JSON.stringify({ status: 'Failure', reason: secret, message: secret })); socket.close(); }, 'InvalidExecStatus'],
    [socket => { sendChannel(socket, 3, JSON.stringify({ reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: secret }] } })); socket.close(); }, 'InvalidExecStatus'],
    [socket => { sendChannel(socket, 1, secret); socket.close(); }, 'MissingExecStatus'],
    [socket => sendChannel(socket, 9, secret), 'InvalidExecResponse'],
    [socket => socket.send(secret), 'InvalidExecResponse'],
    [socket => socket.close(1011, secret), 'TransportError'],
  ];
  for (const [onExec, reason] of scenarios) {
    const server = await fake(t, { onExec });
    await assert.rejects(client(server).exec('users', 'workspace-0', 'main', ['true']), safeError(reason));
  }
});

test('exec maps denied upgrades without including HTTP response bodies', async t => {
  const server = await fake(t, { onUpgrade(req, socket) {
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(secret)}\r\nConnection: close\r\n\r\n${secret}`);
    return false;
  } });
  await assert.rejects(client(server).exec('users', 'workspace-0', 'main', ['true']), safeError('Forbidden', 403));
});

test('logs returns text, sends limitBytes, and enforces the response byte cap', async t => {
  const server = await fake(t, { onRequest(record, res) { res.end('line\n'); } });
  const api = client(server);
  assert.equal(await api.logs('users', 'workspace-0', 'main', { limitBytes: 5 }), 'line\n');
  const url = new URL(server.requests[0].path, 'http://example.com');
  assert.equal(url.pathname, '/api/v1/namespaces/users/pods/workspace-0/log');
  assert.equal(url.searchParams.get('container'), 'main');
  assert.equal(url.searchParams.get('limitBytes'), '5');
  await assert.rejects(api.logs('users', 'workspace-0', 'main', { limitBytes: 4 }), safeError('OutputLimitExceeded'));
  assert.equal(await api.logs('users', 'workspace-0', 'main'), 'line\n');
  assert.equal(server.requests.at(-1).path.includes('limitBytes'), false);
});

test('log HTTP failures retain their status even when the error body exceeds limitBytes', async t => {
  const server = await fake(t, { onRequest(record, res) {
    res.statusCode = 403;
    res.end(JSON.stringify({ reason: 'Forbidden', message: secret }));
  } });
  await assert.rejects(client(server).logs('users', 'workspace-0', 'main', { limitBytes: 1 }), safeError('Forbidden', 403));
});

test('waitFor returns the first truthy value, does not overlap polls, and propagates predicate errors', async () => {
  const api = createKubeClient({ kubeconfigJson: kubeconfig('https://example.com') });
  let calls = 0, active = false;
  const result = await api.waitFor(async () => {
    assert.equal(active, false); active = true;
    await new Promise(resolve => setTimeout(resolve, 5)); active = false;
    return ++calls === 3 ? { ready: true } : null;
  }, { intervalMs: 5 });
  assert.deepEqual(result, { ready: true });
  assert.equal(calls, 3);
  const error = new Error('predicate failed');
  await assert.rejects(api.waitFor(() => { throw error; }), value => value === error);
  await assert.rejects(api.waitFor(() => false, { timeoutMs: 20, intervalMs: 100 }), safeError('Timeout'));
  await assert.rejects(api.waitFor(() => new Promise(() => {}), { timeoutMs: 20 }), safeError('Timeout'));
});

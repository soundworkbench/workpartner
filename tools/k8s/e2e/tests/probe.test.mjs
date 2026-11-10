import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { probe } from '../probe.mjs';

test('lookup returns all addresses and elapsed milliseconds without live DNS', async t => {
  const addresses = [{ address: 'fixture-address-v4', family: 4 }, { address: 'fixture-address-v6', family: 6 }];
  t.mock.method(dns, 'lookup', async (host, options) => {
    assert.equal(host, 'gateway.fixture-system.svc.cluster.invalid.');
    assert.deepEqual(options, { all: true });
    return addresses;
  });
  const result = await probe({ kind: 'lookup', host: 'gateway.fixture-system.svc.cluster.invalid.' });
  assert.deepEqual(result.addresses, addresses);
  assert.ok(Number.isFinite(result.ms) && result.ms >= 0);
});

test('lookup returns error codes and timing for rejected and synchronous errors, never exception text', async t => {
  for (const sync of [false, true]) await t.test(String(sync), async t => {
    const error = Object.assign(new Error('DO-NOT-SERIALIZE'), { code: 'ENOTFOUND' });
    t.mock.method(dns, 'lookup', () => { if (sync) throw error; return Promise.reject(error); });
    const result = await probe({ kind: 'lookup', host: 'missing.invalid' });
    assert.equal(result.error, 'ENOTFOUND');
    assert.ok(Number.isFinite(result.ms) && result.ms >= 0);
    assert.deepEqual(Object.keys(result).sort(), ['error', 'ms']);
  });
});

test('resolv returns only search and options lines', async t => {
  t.mock.method(fs, 'readFileSync', (file, encoding) => {
    assert.equal(file, '/etc/resolv.conf');
    assert.equal(encoding, 'utf8');
    return '# private comment\nnameserver resolver-address\nsearch users.svc.cluster.invalid system.svc.cluster.invalid\noptions ndots:5\ndomain private.invalid\n';
  });
  assert.deepEqual(await probe({ kind: 'resolv' }), [
    'search users.svc.cluster.invalid system.svc.cluster.invalid', 'options ndots:5',
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForListener } from '../controller.mjs';

const target = { namespace: 'fixture', pod: 'probe', node: 'selected-node', port: 18081 };
function clock() {
  let elapsed = 0;
  const sleeps = [];
  return {
    now: () => elapsed,
    sleep: async ms => { sleeps.push(ms); elapsed += ms; },
    advance: ms => { elapsed += ms; },
    sleeps,
  };
}

test('listener wait retries failed connections and returns once listening', async () => {
  const time = clock();
  let attempts = 0;
  const kubectl = (args, options) => {
    assert.deepEqual(args.slice(0, 7), ['exec', '-n', 'fixture', 'probe', '--', 'node', '-e']);
    assert.equal(args.length, 8);
    assert.equal(options.acceptFailure, true);
    assert.ok(options.timeout > 0 && options.timeout <= 30000 - time.now());
    return { status: ++attempts < 4 ? 1 : 0 };
  };
  await waitForListener(kubectl, target, time);
  assert.equal(attempts, 4);
  assert.deepEqual(time.sleeps, [500, 500, 500]);
});

test('listener wait times out with node, port, pod and last command log', async () => {
  const time = clock();
  let attempts = 0;
  await assert.rejects(waitForListener(() => {
    attempts++;
    return { status: 1, logPath: 'command.log' };
  }, target, time), error => {
    assert.match(error.message, /listener.*not ready.*30000ms/i);
    for (const value of [target.node, String(target.port), target.pod, 'command.log']) assert.ok(error.message.includes(value));
    assert.equal(error.logPath, 'command.log');
    return true;
  });
  assert.equal(time.now(), 30000);
  assert.equal(attempts, 60);
  assert.ok(time.sleeps.every(ms => ms === 500));
});

test('listener wait includes command time and caps the last attempt to the remaining budget', async () => {
  const time = clock();
  const timeouts = [];
  await assert.rejects(waitForListener((_args, options) => {
    timeouts.push(options.timeout);
    time.advance(options.timeout);
    return { status: null, error: new Error('Command timed out') };
  }, target, time), /listener.*not ready/i);
  assert.equal(time.now(), 30000);
  assert.ok(timeouts.every(ms => ms > 0 && ms <= 5000));
  assert.equal(timeouts.at(-1), 2500);
});

test('listener wait retries command exceptions without treating them as readiness', async () => {
  const time = clock();
  let attempts = 0;
  await waitForListener(() => {
    if (++attempts === 1) throw new Error('Transport unavailable');
    return { status: 0 };
  }, target, time);
  assert.equal(attempts, 2);
  assert.deepEqual(time.sleeps, [500]);
});

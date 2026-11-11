// Names shared between the gateway and the user image: every name the image side uses must have a producer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { organizationData, nextEnvironment } from '../gateway/organization/resolve.mjs';
import { defaultPublishedFiles } from '../gateway/runtime/published-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const list = (directory, filter = () => true) => fs.readdirSync(path.join(root, directory), { withFileTypes: true })
  .filter(entry => entry.isFile() && filter(entry.name)).map(entry => path.join(directory, entry.name));
const walk = directory => fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  if (entry.isDirectory()) return ['tests', 'node_modules'].includes(entry.name) ? [] : walk(file);
  return entry.name.endsWith('.mjs') ? [file] : [];
});

const consumers = [
  ...list('image/bin'), ...list('image/rebrand/overlay', name => name.endsWith('.js')),
  ...list('preview', name => name.endsWith('.mjs') && name !== 'gateway.mjs'), 'image/rebrand/rebrand.py',
];
const producers = [...walk('gateway'), 'preview/gateway.mjs'];
const found = (files, pattern) => {
  const names = new Map();
  for (const file of files) for (const match of read(file).replaceAll('\\/', '/').matchAll(pattern)) {
    if (!names.has(match[0])) names.set(match[0], new Set());
    names.get(match[0]).add(file);
  }
  return names;
};
const report = (missing, names) => missing.map(name => `${name} (${[...names.get(name)].join(', ')})`).join('\n');

test('every gateway-published file the image reads is published by the gateway', () => {
  // Credential and configuration hand-offs: hidden names ending in token, key or cli.json.
  const names = found(consumers, /\.(?:zp|wp)-[a-z0-9-]*(?:token|key|cli\.json)\b/g);
  for (const name of defaultPublishedFiles) assert.ok(names.has(name), `${name} is published but never read`);
  const missing = [...names.keys()].filter(name => !defaultPublishedFiles.includes(name));
  assert.equal(missing.length, 0, `Published file names without a producer:\n${report(missing, names)}`);
});

test('every workspace environment variable the image reads is set by the gateway or the image', () => {
  const data = organizationData({});
  Object.assign(data.model, { baseUrl: 'https://model.example.test/v1', quickLineModel: 'quick-model' });
  const produced = new Set(Object.keys(nextEnvironment(data, {})));
  // Per-person values set by both runtimes, and build-time defaults from the image.
  for (const file of ['gateway/runtime/docker.mjs', 'gateway/runtime/k8s.mjs', 'image/Dockerfile']) {
    for (const [name] of read(file).matchAll(/\b(?:WORKPARTNER|PARTNER)_[A-Z0-9_]+\b/g)) produced.add(name);
  }
  // Test seams with built-in defaults; no deployment sets them.
  for (const name of ['WORKPARTNER_WORKSPACE']) produced.add(name);
  const names = found(consumers, /\b(?:WORKPARTNER|PARTNER)_[A-Z0-9_]+\b/g);
  const missing = [...names.keys()].filter(name => !produced.has(name));
  assert.equal(missing.length, 0, `Environment variables without a producer:\n${report(missing, names)}`);
});

test('every /_wp route the image calls is handled by the gateway', () => {
  const pattern = /\/_wp\/[A-Za-z0-9_.\/-]*/g;
  const routes = [...found(producers, pattern).keys()];
  const names = found(consumers, pattern);
  // A route matches exactly, or falls under a handled prefix that enumerates no narrower routes.
  const handled = route => {
    if (routes.includes(route)) return true;
    const prefix = routes.filter(item => route.startsWith(item.endsWith('/') ? item : `${item}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) return false;
    const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return !routes.some(item => item.startsWith(base) && item.length > base.length);
  };
  const missing = [...names.keys()].filter(route => !handled(route));
  assert.equal(missing.length, 0, `Routes without a gateway handler:\n${report(missing, names)}`);
});

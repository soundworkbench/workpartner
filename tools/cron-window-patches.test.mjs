import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const overlay = read('../image/rebrand/overlay/wp-cron-window.js');
const fixture = read('./fixtures/aionui-2.1.47-cron.js');
const extracted = spawnSync('python3', ['-I', '-c', `
import ast, json, sys
from pathlib import Path
tree = ast.parse(Path(sys.argv[1]).read_text())
patches = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'UI_PATCHES' for t in n.targets))
print(json.dumps(patches))
`, new URL('../image/rebrand/rebrand.py', import.meta.url).pathname], { encoding: 'utf8' });
assert.equal(extracted.status, 0, extracted.stderr);
const patches = JSON.parse(extracted.stdout);
const windowPatches = patches.filter(([, b]) => b.includes('window.wpCronWindow'));
// Explicit ownership prevents a changed anchor from silently disappearing from this fixture.
const formOnly = ['case"custom":', 't.createElement(f,', 'g.mode===', 'g.mode!==', 'je=async', 'x(!0);'];
const functionPatches = windowPatches.filter(([a]) => !formOnly.some(prefix => a.startsWith(prefix)));
assert.equal(functionPatches.length, 9);
let patched = fixture;
for (const [a, b] of functionPatches) {
  assert.equal(fixture.split(a).length - 1, 1, `fixture anchor: ${a}`);
  patched = patched.replace(a, b);
}
for (const [a, b] of patches.filter(pair => !windowPatches.includes(pair))) {
  if (patched.includes(a)) { assert.equal(patched.split(a).length - 1, 1, a); patched = patched.replace(a, b); }
}
function app(source, withOverlay = true) {
  const context = vm.createContext({ window: { wpUI: { isChinese: () => true } } });
  if (withOverlay) vm.runInContext(overlay, context);
  vm.runInContext(source, context);
  return context;
}
const native = app(fixture), fixed = app(patched);
const plain = value => JSON.parse(JSON.stringify(value));
const withoutWpw = value => { const { wpw, ...rest } = plain(value); return rest; };

test('legacy recognized and advanced expressions retain native interpretation', () => {
  for (const expr of ['0 9 * * *', '0 * * * *', '30 8 * * MON-FRI', '0 9 * * MON', '*/5 * * * *', '0 */2 * * *', '0 9 15 * *', '0,30 1-2 * * *', '5 4 * * SUN', '']) {
    assert.deepEqual(plain(fixed.yt(expr)), plain(native.yt(expr)), expr);
    assert.deepEqual(withoutWpw(fixed.vt(expr)), plain(native.vt(expr)), expr);
    if (fixed.yt(expr).frequency === 'custom') assert.equal(fixed.xt(fixed.vt(expr)), expr);
  }
});
test('multiple weekdays stay weekly custom, instead of becoming daily', () => {
  const expr = '0 9 * * MON,WED';
  assert.equal(fixed.yt(expr).frequency, 'custom'); assert.equal(fixed.vt(expr).mode, 'weekly');
  assert.equal(fixed.xt(fixed.vt(expr)), expr);
});
test('window expressions reopen and display readable labels', () => {
  for (const [expr, description] of [
    ['*/30 1-2 * * *', '每天 01:00–03:00 每 30 分钟'],
    ['*/30 1-2 * * MON', '每周一 01:00–03:00 每 30 分钟'],
    ['*/30 1-2 * * MON,WED,FRI', '每周一、三、五 01:00–03:00 每 30 分钟'],
    ['*/30 1-2 * * MON,FRI', '每周一、五 01:00–03:00 每 30 分钟'],
    ['0 9-11 1,15 * *', '每月 1、15 日 09:00–12:00 每小时'],
    ['*/15 0-1,22-23 * * *', '每天 22:00–次日 02:00 每 15 分钟'],
    ['*/30 23 * * *', '每天 23:00–24:00 每 30 分钟'],
    ['0 22-23 * * SAT', '每周六 22:00–24:00 每小时'],
    ['*/30 1 * * *', '每天 01:00–02:00 每 30 分钟'],
    ['30 8 1,15 * *', '每月 1、15 日 08:30 执行一次'],
  ]) {
    assert.equal(fixed.yt(expr).frequency, 'custom', expr); assert.equal(fixed.vt(expr).mode, 'window', expr);
    assert.equal(fixed.xt(fixed.vt(expr)), expr); assert.equal(fixed.Obo(expr, () => 'native'), description);
  }
});
test('unrecognized hour and minute syntax never renders as a clock time', () => {
  for (const expr of ['0,30 1-2 * * *', '0 */2 * * *', '*/30 1-2 * * MON-FRI', '*/5 * * * MON', '0 24 * * MON', '0 9 * * * *']) {
    assert.equal(fixed.yt(expr).frequency, 'custom', expr);
    assert.equal(fixed.xt(fixed.vt(expr)), expr);
  }
  for (const expr of ['0,30 1-2 * * *', '*/5 * * * MON', '*/30 1-2 * * MON-FRI']) assert.equal(fixed.Obo(expr, () => 'native'), null);
});
test('missing overlay retains original function behavior', () => {
  const fallback = app(patched, false);
  for (const expr of ['0 9 * * MON,WED', '*/30 1-2 * * MON', '*/30 1-2 * * *', '', '0 9 * * *', '0 * * * *']) {
    assert.deepEqual(plain(fallback.yt(expr)), plain(native.yt(expr)));
    assert.deepEqual(plain(fallback.vt(expr)), plain(native.vt(expr)));
    assert.equal(fallback.xt(fallback.vt(expr)), native.xt(native.vt(expr)));
    assert.equal(fallback.Obo(expr, key => key), native.Obo(expr, key => key));
  }
});
const replacement = prefix => {
  const found = windowPatches.filter(([a]) => a.startsWith(prefix));
  assert.equal(found.length, 1, prefix); return found[0][1];
};
test('save rejects invalid windows before validation or a request', async () => {
  const context = app(patched);
  const errors = []; let validations = 0, requests = 0;
  Object.assign(context, { b: 'custom', g: { mode: 'window', wpw: { ...context.window.wpCronWindow.defaults(), days: 'weekly', start: '22:00', end: '02:00' } },
    le: { error: e => errors.push(e) }, u: { validate: () => { validations++; } }, request: () => { requests++; } });
  vm.runInContext(`var ${replacement('je=async')}request()}catch(e){throw e}};`, context);
  await context.je(); assert.equal(errors.length, 1); assert.match(errors[0], /不能跨过 0 点/);
  assert.equal(validations, 0); assert.equal(requests, 0);
  context.g.wpw = context.window.wpCronWindow.defaults(); await context.je();
  assert.equal(validations, 1); assert.equal(requests, 1);
});
test('unchanged old schedules preserve exact stored bytes; edited controls use the new expression', () => {
  const context = app(patched);
  const snippet = replacement('x(!0);');
  Object.assign(context, { x() {}, V: true, tt: (expr, description) => ({ expr, description }) });
  vm.runInContext(`function schedule(){${snippet}result=N;return result}`, context);
  for (const expr of ['0 9 * * *', '0 9 * * MON,WED', '*/5 * * * *', '0 9 15 * *', '*/30 1-2 * * MON,WED,FRI', '15 10 * * MON-FRI', ' 0,30 1-2 * * * ', '05 09 * * MON', '*/05 * * * *', '0 9 * * WED,MON']) {
    const initial = context.yt(expr);
    Object.assign(context, { n: { schedule: { kind: 'cron', expr } }, b: initial.frequency, C: initial.time, R: initial.weekday, g: context.vt(expr), re: { expr: 'normalized value', description: 'rule' } });
    assert.equal(context.schedule().expr, expr, expr);
    if (initial.frequency === 'custom') context.g = { ...context.g, mode: 'advanced', advancedExpression: '0 12 * * *' };
    else context.C = '12:00';
    assert.equal(context.schedule().expr, 'normalized value', expr);
  }
});

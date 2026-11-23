import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const overlay = read('../image/rebrand/overlay/wp-cron-window.js');
const css = read('../image/rebrand/overlay/wp-overlay.css');
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
const requiredFormAnchors = [
  'u.setFieldsValue({name:n.name,assistant:o,prompt:n.target.payload.text})',
  'g.mode==="advanced"&&t.createElement(E,{label:a("cron.page.form.cronExpr"),field:"customCronExpr"',
  'className:"w-[min(560px,calc(100vw-32px))] max-w-560px"',
];
for (const prefix of requiredFormAnchors) {
  const pair = patches.find(([a]) => a.startsWith(prefix));
  assert.ok(pair, `missing form patch: ${prefix}`);
  assert.equal(fixture.split(pair[0]).length - 1, 1, `fixture form anchor: ${pair[0]}`);
}
for (const [a, b] of windowPatches.filter(([a]) => formOnly.some(prefix => a.startsWith(prefix)))) {
  if (fixture.includes(a)) { assert.equal(fixture.split(a).length - 1, 1, `fixture form anchor: ${a}`); patched = patched.replace(a, b); }
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
test('advanced cron validation accepts mixed weekday syntax and rejects invalid ranges', () => {
  const validate = fixed.window.wpCronWindow.validateAdvanced;
  for (const expr of [
    '0,30 1-2 * * *',
    '0 9 * * *',
    '0 9 * * TUE,WED',
    '0 9 * * WED,MON',
    '0 9 * * SAT-SUN',
    '0 9 * * 1-5',
    '0 9 * * 0,7',
    '*/15 * * * *',
    '0 9 * * MON-FRI/2',
  ]) assert.equal(validate(expr), '', expr);
  for (const expr of [
    '61 * * * *',
    'a b c',
    '0 9 * * FOO',
    '0 9 * * 5-1',
    '0 9 * *',
    '0 9 * * * *',
    '*/0 * * * *',
  ]) assert.match(validate(expr), /Cron/, expr);
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
test('advanced save rejects invalid expressions and preserves a legacy expression', async () => {
  const context = app(patched);
  const errors = []; const requests = [];
  Object.assign(context, {
    b: 'custom', g: { mode: 'advanced', advancedExpression: '0 9 * * FOO' },
    le: { error: e => errors.push(e) },
    u: { validate: async () => {
      if (context.g.mode === 'advanced') {
        const error = context.window.wpCronWindow.validateAdvanced(context.g.advancedExpression);
        if (error) throw new Error(error);
      }
      return {};
    } },
    request: expr => requests.push(expr), x: () => {}, V: true,
    n: { schedule: { kind: 'cron', expr: '0,30 1-2 * * *' } },
    tt: () => ({}), re: { expr: 'normalized value', description: 'rule' },
  });
  vm.runInContext(`var ${replacement('je=async')}${replacement('x(!0);')}result=N;request(r)}catch(e){le.error(e)}};`, context);
  await context.je();
  assert.equal(requests.length, 0);
  assert.equal(errors.length, 1);

  const expr = '0,30 1-2 * * *';
  context.g = context.vt(expr);
  context.n.schedule.expr = expr;
  context.re = { expr: 'normalized value', description: 'rule' };
  await context.je();
  assert.deepEqual(requests, [expr]);
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

test('advanced legacy edits populate the required form field and preserve the expression', () => {
  const fields = {};
  const expr = '0,30 1-2 * * *';
  fixed.cronEditInit({ setFieldsValue: value => Object.assign(fields, value) }, { name: 'legacy', target: { payload: { text: 'run' } } }, fixed.yt(expr), 'assistant', expr);
  assert.equal(fields.customCronExpr, expr);
  assert.equal(fixed.window.wpCronWindow.validateAdvanced(expr), '');
  assert.match(fixed.window.wpCronWindow.validateAdvanced('not a cron expression'), /Cron/);
  assert.match(fixed.window.wpCronWindow.validateAdvanced('99 99 * * *'), /Cron/);
  const field = fixed.cronAdvancedField({ createElement: (type, props, ...children) => ({ type, props, children }) }, 'Item', 'TextArea', key => key,
    { mode: 'advanced', advancedExpression: expr }, () => {}, { setFieldsValue: value => Object.assign(fields, value) });
  field.children[0].props.onChange('bad');
  assert.equal(fields.customCronExpr, 'bad');
  assert.match(patched, /customCronExpr:r\.frequency==="custom"\?e:void 0/);
  assert.match(patched, /validateAdvanced\(e\)/);
});

test('automation modal inputs use a mobile 16px rule scoped to the modal', () => {
  const mobile = css.slice(css.lastIndexOf('@media (max-width: 767px)'));
  assert.match(mobile, /\.wp-cron-modal input/);
  assert.match(mobile, /\.wp-cron-modal textarea/);
  assert.match(mobile, /font-size: 16px/);
  assert.match(patched, /wp-cron-modal w-\[min\(560px/);
});

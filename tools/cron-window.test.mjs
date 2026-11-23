import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = { wpUI: { isChinese: () => true } };
vm.runInNewContext(fs.readFileSync(new URL('../image/rebrand/overlay/wp-cron-window.js', import.meta.url), 'utf8'), context);
const api = context.wpCronWindow;
const state = patch => ({ ...api.defaults(), ...patch });
const rows = [
  ['daily half hour', { start: '01:00', end: '03:00' }, '*/30 1-2 * * *', true],
  ['weekly half hour', { days: 'weekly', weekdays: ['MON', 'WED', 'FRI'], start: '01:00', end: '03:00' }, '*/30 1-2 * * MON,WED,FRI', true],
  ['weekday order', { days: 'weekly', weekdays: ['FRI', 'MON', 'FRI'], start: '01:00', end: '03:00' }, '*/30 1-2 * * MON,FRI', true],
  ['month day order', { days: 'monthly', monthDays: [15, 1, 15], end: '12:00', every: 60 }, '0 9-11 1,15 * *', true],
  ['overnight daily', { start: '22:00', end: '02:00', every: 15 }, '*/15 0-1,22-23 * * *', true],
  ['midnight end', { start: '23:00', end: '00:00' }, '*/30 23 * * *', true],
  ['Saturday midnight end', { days: 'weekly', weekdays: ['SAT'], start: '22:00', end: '00:00', every: 60 }, '0 22-23 * * SAT', true],
  ['one hour', { start: '01:00', end: '02:00' }, '*/30 1 * * *', true],
  ['weekly overnight invalid', { days: 'weekly', weekdays: ['MON'], start: '22:00', end: '02:00' }, '', false],
  ['equal times invalid', { start: '01:00', end: '01:00' }, '', false],
  ['weekly once native', { days: 'weekly', weekdays: ['MON', 'WED', 'FRI'], start: '01:00', once: true }, '0 1 * * MON,WED,FRI', false],
  ['monthly once', { days: 'monthly', monthDays: [1, 15], start: '08:30', once: true }, '30 8 1,15 * *', true],
  ['daily once native', { start: '07:05', once: true }, '5 7 * * *', false],
];
for (const [name, patch, cron, claimed] of rows) test(name, () => {
  const s = state(patch);
  assert.equal(api.build(s), cron);
  assert.equal(api.validate(s) === '', !!cron);
  const parsed = api.parse(cron);
  assert.equal(parsed !== null, claimed);
  if (claimed) assert.equal(api.build(parsed), cron);
});

test('invalid selection and time errors block build and preview', () => {
  for (const patch of [{ days: 'weekly', weekdays: [] }, { days: 'monthly', monthDays: [] },
    { days: 'monthly', start: '22:00', end: '02:00' }, { start: '01:30' }, { end: '25:00' }, { every: 5 }]) {
    const s = state(patch);
    assert.ok(api.validate(s)); assert.equal(api.build(s), ''); assert.equal(api.runTimes(s).length, 0);
  }
  assert.equal(api.validate(state({ days: 'weekly', start: '22:15', end: '02:00', once: true })), '');
  assert.equal(api.validate(state({ days: 'weekly', start: '22:00', end: '02:00' })), '每周或每月的时间段不能跨过 0 点：请把结束时间设在 24:00 以前，或改成每天，或拆成两个自动化');
});

test('parse leaves native, noncanonical and unsupported expressions alone', () => {
  for (const expr of ['0 9 * * *', '0 9 * * MON', '0 9 * * MON,WED', '0 9 15 * *', '*/5 * * * *', '0 */2 * * *', '0 * * * *', '15 10 * * MON-FRI', '0,30 1-2 * * *', '*/30 1-2 * * MON-FRI', '*/30 1-2 1 * MON', '*/30 0-23 * * *', '', '0 1 * *', '0 1 * * * *', '*/30 1,2 * * *', '*/30 1-2 * * FRI,MON', '*/30 1-2 * * 1', '*/30 1,3 * * *', '*/30 22-23,0-1 * * *', '*/30 1-2 32 * *', '30 25 1,15 * *']) {
    assert.equal(api.parse(expr), null, expr); assert.equal(api.label(expr), null, expr);
  }
  assert.equal(api.build(api.parse('  */30 1-2 * * *  ')), '*/30 1-2 * * *');
});

test('all hours and intervals round trip across day selections', () => {
  let claimed = 0;
  for (const selection of [{ days: 'daily' }, { days: 'weekly', weekdays: ['MON'] }, { days: 'weekly', weekdays: ['FRI', 'MON'] }, { days: 'monthly', monthDays: [1] }, { days: 'monthly', monthDays: [31, 15, 1] }]) {
    for (let start = 0; start < 24; start++) for (let end = 0; end < 24; end++) for (const every of [15, 30, 60]) {
      const s = state({ ...selection, start: `${String(start).padStart(2, '0')}:00`, end: `${String(end).padStart(2, '0')}:00`, every });
      const expr = api.build(s);
      assert.equal(!!expr, !api.validate(s));
      if (!expr) continue;
      const parsed = api.parse(expr);
      if (parsed) { claimed++; assert.equal(api.build(parsed), expr); assert.deepEqual(Array.from(api.runTimes(parsed)), Array.from(api.runTimes(s))); }
      else assert.equal(every === 60 && api.runTimes(s).length === 1 && (s.days !== 'monthly' || s.monthDays.length === 1), true, expr);
    }
  }
  assert.ok(claimed > 4000);
});

test('descriptions in Chinese and English', () => {
  for (const [patch, zh, en] of [
    [{ start: '01:00', end: '03:00' }, '每天 01:00–03:00 每 30 分钟', 'Daily 01:00–03:00, every 30 min'],
    [{ days: 'weekly', weekdays: ['FRI', 'MON', 'WED'], start: '01:00', end: '03:00' }, '每周一、三、五 01:00–03:00 每 30 分钟', 'Mon, Wed, Fri 01:00–03:00, every 30 min'],
    [{ days: 'monthly', monthDays: [15, 1], end: '12:00', every: 60 }, '每月 1、15 日 09:00–12:00 每小时', 'Monthly on day 1, 15 09:00–12:00, hourly'],
    [{ start: '22:00', end: '02:00', every: 15 }, '每天 22:00–次日 02:00 每 15 分钟', 'Daily 22:00–next day 02:00, every 15 min'],
    [{ start: '23:00', end: '00:00' }, '每天 23:00–24:00 每 30 分钟', 'Daily 23:00–24:00, every 30 min'],
    [{ days: 'weekly', weekdays: ['MON', 'WED', 'FRI'], start: '01:00', once: true }, '每周一、三、五 01:00 执行一次', 'Mon, Wed, Fri 01:00, once'],
  ]) { assert.equal(api.describe(state(patch), 'zh-CN'), zh); assert.equal(api.describe(state(patch), 'en-US'), en); }
});

test('run times are ordered from start and exclude end', () => {
  for (const [patch, expected] of [
    [{ start: '01:00', end: '03:00' }, ['01:00', '01:30', '02:00', '02:30']],
    [{ start: '22:00', end: '02:00', every: 60 }, ['22:00', '23:00', '00:00', '01:00']],
    [{ start: '23:00', end: '00:00', every: 15 }, ['23:00', '23:15', '23:30', '23:45']],
    [{ start: '07:05', once: true }, ['07:05']],
  ]) assert.deepEqual(Array.from(api.runTimes(state(patch))), expected);
});

function panel(s) {
  let current = s;
  const tree = api.render({ createElement: (type, props, ...children) => ({ type, props, children }) }, {
    state: s, setState: value => { current = value; }, t: key => key, Select: 'Select', Option: 'Option', FormItem: 'FormItem', Switch: 'Switch', TimePicker: 'TimePicker', dayjs: v => v,
    weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map(value => ({ value, label: value })),
  });
  function nodes(v) { return v && typeof v === 'object' ? Array.isArray(v) ? v.flatMap(nodes) : [v, ...v.children.flatMap(nodes)] : []; }
  return { tree, nodes: nodes(tree), current: () => current };
}
test('panel controls update isolated state, allow empty choices and expose errors', () => {
  const p = panel(state({ days: 'weekly' }));
  const controls = p.nodes.filter(n => ['Select', 'Switch', 'TimePicker'].includes(n.type));
  assert.ok(controls.every(n => n.props['aria-label']));
  controls.find(n => n.props['aria-label'] === '星期').props.onChange([]);
  assert.equal(p.current().weekdays.length, 0);
  assert.ok(panel(p.current()).nodes.some(n => n.props?.role === 'alert'));
  const end = controls.find(n => n.props['aria-label'] === '结束时间');
  const options = end.children.flat();
  assert.equal(options.length, 24); assert.equal(options.at(-1).props.value, '00:00'); assert.equal(options.at(-1).children[0], '24:00');
  const once = panel(state({ once: true, start: '07:05' }));
  assert.ok(!once.nodes.some(n => ['结束时间', '间隔'].includes(n.props?.['aria-label'])));
  once.nodes.find(n => n.type === 'Switch').props.onChange(false);
  assert.equal(once.current().start, '07:00');
});
test('panel previews first eight runs and missing month days', () => {
  const p = panel(state({ days: 'monthly', monthDays: [29, 30, 31], end: '12:00', every: 15 }));
  const serialized = JSON.stringify(p.tree);
  assert.match(serialized, /…共 12 次/); assert.match(serialized, /没有这一天的月份不执行/); assert.doesNotMatch(serialized, /11:45/);
});

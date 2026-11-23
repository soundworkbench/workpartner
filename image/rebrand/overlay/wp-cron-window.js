(function (root) {
  'use strict';
  var WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  var ZH_WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  function chinese(lang) {
    return lang ? /^zh/i.test(lang) : !!(root.wpUI && root.wpUI.isChinese && root.wpUI.isChinese());
  }
  function copy(zh, en, lang) { return chinese(lang) ? zh : en; }
  function defaults() {
    return { days: 'daily', weekdays: WEEK.slice(0, 5), monthDays: [1], start: '09:00', end: '11:00', every: 30, once: false };
  }
  function clock(n) { return String(Math.floor(n / 60) % 24).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); }
  function minutes(s) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : NaN; }
  function weekdays(s) { return WEEK.filter(function (day) { return s.weekdays.includes(day); }); }
  function monthDays(s) { return Array.from(new Set(s.monthDays)).sort(function (a, b) { return a - b; }); }
  function validate(s) {
    if (!s || !['daily', 'weekly', 'monthly'].includes(s.days)) return copy('请选择哪几天执行', 'Choose the days to run');
    if (s.days === 'weekly' && (!Array.isArray(s.weekdays) || !s.weekdays.length || s.weekdays.some(function (d) { return !WEEK.includes(d); }))) return copy('请至少选择一个星期', 'Select at least one weekday');
    if (s.days === 'monthly' && (!Array.isArray(s.monthDays) || !s.monthDays.length || s.monthDays.some(function (d) { return !Number.isInteger(d) || d < 1 || d > 31; }))) return copy('请至少选择一个日期（1–31）', 'Select at least one day (1–31)');
    var start = minutes(s.start), end = minutes(s.end);
    if (!Number.isFinite(start)) return copy('请选择有效的开始时间', 'Choose a valid start time');
    if (s.once) return '';
    if (!Number.isFinite(end) || start % 60 || end % 60) return copy('开始和结束时间必须为整点', 'Start and end times must be on the hour');
    if (![15, 30, 60].includes(s.every)) return copy('间隔只能为 15、30 或 60 分钟', 'Choose an interval of 15, 30 or 60 minutes');
    if (start === end) return copy('开始时间不能等于结束时间', 'Start and end times must differ');
    // A single cron cannot shift the selected weekday or month day after midnight.
    if (s.days !== 'daily' && end !== 0 && end < start) return copy('每周或每月的时间段不能跨过 0 点：请把结束时间设在 24:00 以前，或改成每天，或拆成两个自动化', 'Weekly or monthly windows cannot cross midnight: end by 24:00, choose daily, or split into two automations');
    return '';
  }
  function runTimes(s) {
    if (validate(s)) return [];
    if (s.once) return [s.start];
    var start = minutes(s.start), end = minutes(s.end), result = [];
    if (end <= start) end += 1440;
    for (var n = start; n < end; n += s.every) result.push(clock(n));
    return result;
  }
  function ranges(values) {
    var result = [], start = values[0], last = start;
    values.slice(1).concat([Infinity]).forEach(function (n) {
      if (n !== last + 1) { result.push(start === last ? String(start) : start + '-' + last); start = n; }
      last = n;
    });
    return result.join(',');
  }
  function build(s) {
    if (validate(s)) return '';
    var start = minutes(s.start);
    var minute = s.once ? String(start % 60) : s.every === 60 ? '0' : '*/' + s.every;
    var hours = s.once ? String(Math.floor(start / 60)) : ranges(Array.from(new Set(runTimes(s).map(function (v) { return Number(v.slice(0, 2)); }))).sort(function (a, b) { return a - b; }));
    // Use names: the scheduler's weekday numbers differ from standard cron.
    return [minute, hours, s.days === 'monthly' ? monthDays(s).join(',') : '*', '*', s.days === 'weekly' ? weekdays(s).join(',') : '*'].join(' ');
  }
  function parse(expr) {
    if (typeof expr !== 'string') return null;
    var value = expr.trim(), parts = value.split(/\s+/);
    if (parts.length !== 5) return null;
    var minute = parts[0], hour = parts[1], day = parts[2], month = parts[3], week = parts[4];
    if (month !== '*' || (day !== '*' && week !== '*')) return null;
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && (day === '*' || /^\d+$/.test(day))) return null;
    var s = defaults();
    if (day !== '*') { if (!/^\d+(?:,\d+)*$/.test(day)) return null; s.days = 'monthly'; s.monthDays = day.split(',').map(Number); }
    if (week !== '*') { s.days = 'weekly'; s.weekdays = week.split(','); }
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
      if (+minute > 59 || +hour > 23) return null;
      s.once = true; s.start = clock(+hour * 60 + +minute);
    } else {
      if (!['*/15', '*/30', '0'].includes(minute) || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(hour)) return null;
      var hours = [];
      for (var segment of hour.split(',')) {
        var bounds = segment.split('-').map(Number), from = bounds[0], to = bounds.length === 2 ? bounds[1] : from;
        if (from > to || to > 23) return null;
        for (var h = from; h <= to; h++) hours.push(h);
      }
      hours = Array.from(new Set(hours)).sort(function (a, b) { return a - b; });
      if (hours.length === 24) return null;
      var starts = hours.filter(function (h) { return !hours.includes((h + 23) % 24); });
      if (starts.length !== 1) return null;
      s.start = clock(starts[0] * 60); s.end = clock(((starts[0] + hours.length) % 24) * 60);
      s.every = minute === '0' ? 60 : Number(minute.slice(2));
    }
    return build(s) === value ? s : null;
  }
  function describe(s, lang) {
    if (validate(s)) return '';
    var zh = chinese(lang), days = zh ? '每天' : 'Daily';
    if (s.days === 'weekly') days = weekdays(s).map(function (d) { return zh ? ZH_WEEK[WEEK.indexOf(d)] : d[0] + d.slice(1).toLowerCase(); }).join(zh ? '、' : ', '), days = (zh ? '每周' : '') + days;
    if (s.days === 'monthly') days = (zh ? '每月 ' : 'Monthly on day ') + monthDays(s).join(zh ? '、' : ', ') + (zh ? ' 日' : '');
    if (s.once) return days + ' ' + s.start + (zh ? ' 执行一次' : ', once');
    var end = s.end === '00:00' ? '24:00' : (minutes(s.end) < minutes(s.start) ? (zh ? '次日 ' : 'next day ') : '') + s.end;
    return days + ' ' + s.start + '–' + end + (zh ? ' ' : ', ') + (s.every === 60 ? (zh ? '每小时' : 'hourly') : (zh ? '每 ' + s.every + ' 分钟' : 'every ' + s.every + ' min'));
  }
  function label(expr, lang) { var s = parse(expr); return s ? describe(s, lang) : null; }
  function render(h, ctx) {
    var s = ctx.state || defaults(), el = h.createElement, zh = chinese(), error = validate(s);
    function text(a, b) { return zh ? a : b; }
    function update(patch) { ctx.setState(Object.assign({}, s, patch)); }
    function option(value, title) { return el(ctx.Option, { key: value, value: value }, title); }
    function select(name, value, onChange, options, multiple) {
      return el(ctx.Select, { 'aria-label': name, value: value, onChange: onChange, mode: multiple ? 'multiple' : undefined, style: { width: '100%', minWidth: 0 } }, options);
    }
    function field(name, control) { return el(ctx.FormItem, { label: name, className: 'wp-cron-window-field' }, control); }
    var daysName = text('哪几天', 'Days'), startName = text('开始时间', 'Start time'), endName = text('结束时间', 'End time'), intervalName = text('间隔', 'Interval');
    var times = runTimes(s), preview = text('执行时间：', 'Run times: ') + times.slice(0, 8).join(zh ? '、' : ', ') + (times.length > 8 ? text('…共 ' + times.length + ' 次', '…' + times.length + ' runs total') : text('（共 ' + times.length + ' 次）', ' (' + times.length + ' runs total)'));
    return el('div', { className: 'wp-cron-window' },
      field(daysName, select(daysName, s.days, function (v) { update({ days: v }); }, [option('daily', text('每天', 'Daily')), option('weekly', text('每周', 'Weekly')), option('monthly', text('每月', 'Monthly'))])),
      s.days === 'weekly' && field(text('星期', 'Weekdays'), select(text('星期', 'Weekdays'), s.weekdays, function (v) { update({ weekdays: v }); }, ctx.weekdays.map(function (d) { return option(d.value, ctx.t('cron.page.weekday.' + d.label)); }), true)),
      s.days === 'monthly' && field(text('日期', 'Month days'), select(text('日期', 'Month days'), s.monthDays, function (v) { update({ monthDays: v }); }, Array.from({ length: 31 }, function (_, i) { return option(i + 1, i + 1); }), true)),
      field(text('只在开始时执行一次', 'Run once at the start'), el(ctx.Switch, { 'aria-label': text('只在开始时执行一次', 'Run once at the start'), checked: s.once, onChange: function (v) { update({ once: v, start: v ? s.start : s.start.slice(0, 2) + ':00' }); } })),
      el('div', { className: 'wp-cron-window-times' },
        field(startName, s.once ? el(ctx.TimePicker, { 'aria-label': startName, format: 'HH:mm', value: ctx.dayjs('2000-01-01 ' + s.start), allowClear: false, style: { width: '100%' }, onChange: function (_, date) { if (date) update({ start: date.format('HH:mm') }); } }) : select(startName, s.start, function (v) { update({ start: v }); }, Array.from({ length: 24 }, function (_, i) { return option(clock(i * 60), clock(i * 60)); }))),
        !s.once && field(endName, select(endName, s.end, function (v) { update({ end: v }); }, Array.from({ length: 24 }, function (_, i) { var v = clock((i + 1) * 60); return option(v, i === 23 ? '24:00' : (minutes(v) < minutes(s.start) ? text('次日 ', 'Next day ') : '') + v); }))),
        !s.once && field(intervalName, select(intervalName, s.every, function (v) { update({ every: v }); }, [15, 30, 60].map(function (n) { return option(n, text('每 ' + n + ' 分钟', 'Every ' + n + ' min')); })))),
      error ? el('div', { role: 'alert', className: 'wp-cron-window-error' }, error) : el('div', { className: 'wp-cron-window-preview', 'aria-live': 'polite' },
        el('div', null, describe(s)), el('div', null, preview), el('div', null, text('生成的 Cron：', 'Generated Cron: '), el('code', null, build(s)))),
      s.days === 'monthly' && s.monthDays.some(function (d) { return d >= 29; }) && el('div', null, text('没有这一天的月份不执行', 'Months without this day are skipped')));
  }
  root.wpCronWindow = { defaults: defaults, build: build, validate: validate, parse: parse, describe: describe, label: label, runTimes: runTimes, render: render };
})(typeof window === 'object' ? window : globalThis);

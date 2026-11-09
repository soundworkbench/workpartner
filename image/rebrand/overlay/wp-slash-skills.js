// Both native composers use this catalog before filtering their slash menu.
(function () {
  'use strict';
  const translations = __WP_SKILLS_ZH__;
  const COPY = {
    'zh-CN': { empty: '暂无可用技能', unmatched: '没有匹配的技能', failed: '技能加载失败，请重新输入 / 重试。', loading: '正在加载技能…' },
    'en-US': { empty: 'No skills available', unmatched: 'No matching skills', failed: 'Could not load skills. Type / again to retry.', loading: 'Loading skills…' }
  };
  const locale = () => window.wpSettings.get().language === 'en-US' ? 'en-US' : 'zh-CN';

  // The translation catalog admits preinstalled skills; personal installs keep
  // their own names. Native/ACP commands alone never admit a menu entry.
  function commands(native, personal, builtin, language) {
    const known = new Map();
    for (const skill of personal) if (skill.preinstalled === false || translations[skill.name]?.name) known.set(skill.name, skill);
    for (const skill of builtin) if (skill.is_auto_inject && translations[skill.name]?.name && !known.has(skill.name)) known.set(skill.name, skill);
    const rows = Array.from(known.values()).map(skill => {
      const original = native.find(command => command.name === skill.name);
      const zh = skill.preinstalled !== false ? translations[skill.name] : null;
      return { ...original, name: skill.name, kind: 'template', source: 'skill', selectionBehavior: 'insert',
        wpLabel: language === 'zh-CN' && zh ? zh.name : skill.name,
        description: language === 'zh-CN' && zh ? zh.description : skill.description };
    });
    const open = native.find(command => command.name === 'open' && command.kind === 'builtin');
    if (open) rows.push({ ...open, description: language === 'en-US' ? 'Upload files' : '上传文件' });
    return rows;
  }

  function useCommands(React, native, input) {
    const [catalog, setCatalog] = React.useState({ personal: [], builtin: [], state: 'loading' });
    const opening = input.startsWith('/');
    React.useEffect(() => {
      if (!opening) return;
      const controller = new AbortController();
      setCatalog(previous => ({ ...previous, state: 'loading' }));
      async function read(url, key) {
        const response = await fetch(url, { signal: controller.signal });
        const value = await response.json();
        if (!response.ok || value.success === false || !Array.isArray(value[key])) throw new Error('Skill catalog unavailable');
        return value[key];
      }
      Promise.allSettled([read('/_wp/market/skills', 'skills'), read('/api/skills', 'data')]).then(results => {
        if (controller.signal.aborted) return;
        setCatalog({ personal: results[0].status === 'fulfilled' ? results[0].value : [],
          builtin: results[1].status === 'fulfilled' ? results[1].value : [],
          state: results.some(result => result.status === 'rejected') ? 'failed' : 'ready' });
      });
      return () => controller.abort();
    }, [opening]);
    const rows = commands(native, catalog.personal, catalog.builtin, locale());
    return { commands: rows, state: catalog.state === 'ready' && !rows.some(row => row.source === 'skill') ? 'empty' : catalog.state };
  }

  window.wpSlashSkills = { commands, useCommands,
    matches: (command, query) => [command.name, command.wpLabel].some(value => value?.toLowerCase().includes(query.toLowerCase())),
    status: state => state === 'ready' ? '' : COPY[locale()][state],
    empty: (query, state) => COPY[locale()][state === 'failed' || state === 'loading' ? state : query ? 'unmatched' : 'empty'] };
})();

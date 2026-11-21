/* Pure project helpers.  The browser surface and the unit tests use the same rules. */
(function (root) {
  'use strict';
  function text(value) { return typeof value === 'string' ? value : ''; }
  function safeDirectory(name, id) {
    // The directory is derived from the generated id, never from a user supplied name.
    var token = text(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
    return token ? 'project-' + token : 'project-' + Math.random().toString(36).slice(2, 14);
  }
  function mergeExtra(extra, patch) {
    var result = extra && typeof extra === 'object' ? Object.assign({}, extra) : {};
    Object.keys(patch || {}).forEach(function (key) {
      var value = patch[key];
      if (value === null || value === undefined || value === '') delete result[key];
      else result[key] = value;
    });
    return result;
  }
  function time(value) {
    var date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function bucket(value, now) {
    var date = time(value), current = time(now) || new Date();
    if (!date) return 'earlier';
    var start = new Date(current.getFullYear(), current.getMonth(), current.getDate());
    var day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var days = Math.floor((start - day) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return 'week';
    return 'earlier';
  }
  function normalizeProject(project) {
    if (!project || typeof project !== 'object') return null;
    var id = text(project.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
    var name = text(project.name).trim().slice(0, 120);
    if (!id || !name) return null;
    return { id: id, name: name, icon: text(project.icon) || 'folder', color: text(project.color) || '#9b9b87',
      order: Number.isFinite(project.order) ? project.order : 0, description: text(project.description).slice(0, 4000),
      directory: safeDirectory(name, id), updatedAt: project.updatedAt || null };
  }
  function normalizeProjects(value) {
    var list = Array.isArray(value) ? value : value && Array.isArray(value.projects) ? value.projects : [];
    return list.map(normalizeProject).filter(Boolean).sort(function (a, b) { return a.order - b.order || a.name.localeCompare(b.name); });
  }
  function pinned(c) {
    var extra = c.extra || {};
    return extra.pinned !== undefined ? !!extra.pinned : extra.wp_pinned === true;
  }
  function activityTime(c) {
    return c.wp_last_message_at || c.extra && c.extra.wp_activity_at || c.modified_at || c.updated_at || c.created_at;
  }

  function safeFilename(value) {
    var name = Array.from(text(value).replace(/[\\/\x00-\x1f\x7f-\x9f]/g, '').replace(/\.\./g, '')).slice(0, 100).join('');
    // Linux names are limited by bytes, not characters.
    while (new TextEncoder().encode(name).length > 240) name = Array.from(name).slice(0, -1).join('');
    return name && name !== '.' ? name : 'file';
  }
  function groupConversations(conversations, projects, now) {
    var byId = new Map((projects || []).map(function (project) { return [project.id, project]; }));
    var grouped = { projects: new Map(), pinned: [], recent: { today: [], yesterday: [], week: [], earlier: [] } };
    (conversations || []).forEach(function (conversation) {
      if (!conversation || !conversation.id || conversation.extra && conversation.extra.wp_archived) return;
      var projectId = conversation.extra && conversation.extra.wp_project_id;
      var project = byId.get(projectId);
      if (pinned(conversation)) grouped.pinned.push(conversation);
      else if (project) {
        if (!grouped.projects.has(project.id)) grouped.projects.set(project.id, []);
        grouped.projects.get(project.id).push(conversation);
      }
      else grouped.recent[bucket(activityTime(conversation), now)].push(conversation);
    });
    grouped.projects.forEach(function (list) { list.sort(function (a, b) { return new Date(activityTime(b) || 0) - new Date(activityTime(a) || 0); }); });
    grouped.pinned.sort(function (a, b) { return (b.extra.pinned_at || 0) - (a.extra.pinned_at || 0); });
    Object.keys(grouped.recent).forEach(function (key) { grouped.recent[key].sort(function (a, b) { return new Date(activityTime(b) || 0) - new Date(activityTime(a) || 0); }); });
    return grouped;
  }
  root.WpProjectsLogic = { pinned: pinned, activityTime: activityTime, safeFilename: safeFilename, safeDirectory: safeDirectory, mergeExtra: mergeExtra, bucket: bucket,
    normalizeProject: normalizeProject, normalizeProjects: normalizeProjects, groupConversations: groupConversations };
})(typeof window === 'object' ? window : globalThis);

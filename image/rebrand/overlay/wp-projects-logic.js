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
  function groupConversations(conversations, projects, now) {
    var byId = new Map((projects || []).map(function (project) { return [project.id, project]; }));
    var grouped = { projects: new Map(), pinned: [], recent: { today: [], yesterday: [], week: [], earlier: [] } };
    (conversations || []).forEach(function (conversation) {
      if (!conversation || !conversation.id) return;
      var projectId = conversation.extra && conversation.extra.wp_project_id;
      var project = byId.get(projectId);
      if (project) {
        if (!grouped.projects.has(project.id)) grouped.projects.set(project.id, []);
        grouped.projects.get(project.id).push(conversation);
      } else if (conversation.extra && conversation.extra.wp_pinned === true) grouped.pinned.push(conversation);
      else grouped.recent[bucket(conversation.modified_at || conversation.updated_at || conversation.created_at, now)].push(conversation);
    });
    grouped.projects.forEach(function (list) { list.sort(function (a, b) { return new Date(b.modified_at || b.updated_at || 0) - new Date(a.modified_at || a.updated_at || 0); }); });
    grouped.pinned.sort(function (a, b) { return new Date(b.modified_at || b.updated_at || 0) - new Date(a.modified_at || a.updated_at || 0); });
    Object.keys(grouped.recent).forEach(function (key) { grouped.recent[key].sort(function (a, b) { return new Date(b.modified_at || b.updated_at || 0) - new Date(a.modified_at || a.updated_at || 0); }); });
    return grouped;
  }
  root.WpProjectsLogic = { safeDirectory: safeDirectory, mergeExtra: mergeExtra, bucket: bucket,
    normalizeProject: normalizeProject, normalizeProjects: normalizeProjects, groupConversations: groupConversations };
})(typeof window === 'object' ? window : globalThis);

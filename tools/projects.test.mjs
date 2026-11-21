import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../image/rebrand/overlay/wp-projects-logic.js', import.meta.url), 'utf8');
const context = { Math, Date, Map, Set };
vm.runInNewContext(source, context);
const logic = context.WpProjectsLogic;

test('project directories never contain user supplied path syntax', () => {
  const directory = logic.safeDirectory('../客户/very-long-name', 'p_abc-123');
  assert.equal(directory, 'project-p_abc-123');
  assert.match(directory, /^project-[A-Za-z0-9_-]+$/);
  assert.ok(directory.length <= 56);
});

test('mergeExtra preserves unrelated flags and removes a project', () => {
  assert.equal(JSON.stringify(logic.mergeExtra({ backend: 'codex', wp_project_id: 'old' }, { wp_project_id: null })), JSON.stringify({ backend: 'codex' }));
  assert.equal(JSON.stringify(logic.mergeExtra({ wp_archived: true }, { wp_project_id: 'p1' })), JSON.stringify({ wp_archived: true, wp_project_id: 'p1' }));
});

test('conversations are split into local calendar buckets', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  assert.equal(logic.bucket('2026-11-21T01:00:00Z', now), 'today');
  assert.equal(logic.bucket('2026-11-20T23:00:00Z', now), 'yesterday');
  assert.equal(logic.bucket('2026-11-17T12:00:00Z', now), 'week');
  assert.equal(logic.bucket('2026-11-10T12:00:00Z', now), 'earlier');
});

test('grouping keeps unknown project ids in recent chats', () => {
  const projects = logic.normalizeProjects([{ id: 'p1', name: 'Alpha', order: 0 }]);
  const grouped = logic.groupConversations([
    { id: 'a', modified_at: '2026-11-21T10:00:00Z', extra: { wp_project_id: 'p1' } },
    { id: 'b', modified_at: '2026-11-21T09:00:00Z', extra: { wp_project_id: 'missing' } },
    { id: 'c', modified_at: '2026-11-21T08:00:00Z', extra: { wp_pinned: true } },
  ], projects, new Date('2026-11-21T12:00:00Z'));
  assert.equal(JSON.stringify(grouped.projects.get('p1').map(c => c.id)), JSON.stringify(['a']));
  assert.equal(JSON.stringify(grouped.recent.today.map(c => c.id)), JSON.stringify(['b']));
  assert.equal(JSON.stringify(grouped.pinned.map(c => c.id)), JSON.stringify(['c']));
});

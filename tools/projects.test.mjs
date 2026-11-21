import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../image/rebrand/overlay/wp-projects-logic.js', import.meta.url), 'utf8');
const context = { Math, Date, Map, Set, TextEncoder };
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


test('native pin wins over legacy pin and includes project chats', () => {
  const grouped = logic.groupConversations([
    { id: 'native', extra: { wp_project_id: 'p1', pinned: true, pinned_at: 12 } },
    { id: 'old', extra: { wp_pinned: true } },
    { id: 'unpin', extra: { pinned: false, wp_pinned: true } },
    { id: 'archived', extra: { pinned: true, wp_archived: true } },
  ], [{ id: 'p1' }]);
  assert.deepEqual(Array.from(grouped.pinned, c => c.id), ['native', 'old']);
  assert.equal(grouped.projects.size, 0);
  assert.deepEqual(Array.from(grouped.recent.earlier, c => c.id), ['unpin']);
});

test('metadata updates preserve activity until a new message arrives', () => {
  const c = { updated_at: '2026-11-21T12:00:00Z', extra: { wp_activity_at: '2026-11-18T12:00:00Z' } };
  assert.equal(logic.bucket(logic.activityTime(c), new Date('2026-11-21T12:00:00Z')), 'week');
  c.wp_last_message_at = '2026-11-21T12:01:00Z';
  assert.equal(logic.bucket(logic.activityTime(c), new Date('2026-11-21T12:01:00Z')), 'today');
});

test('upload filenames preserve Unicode and strip traversal/control characters', () => {
  assert.equal(logic.safeFilename('../客户/方案\\说明.txt'), '客户方案说明.txt');
  assert.equal(logic.safeFilename('a\x00b\x7fc'), 'abc');
  assert.ok(new TextEncoder().encode(logic.safeFilename('中'.repeat(300))).length <= 240);
  assert.equal(logic.safeFilename('..'), 'file');
});

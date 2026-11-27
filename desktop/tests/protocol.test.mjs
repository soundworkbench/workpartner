import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProtocol } from '../dist/main/protocol.js';

test('协议注册失败追加到用户日志，成功不写日志', t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'desktop.log');
  const warn = t.mock.method(console, 'warn', () => {});
  registerProtocol('sample', dir, () => true);
  assert.equal(existsSync(file), false);
  registerProtocol('sample', dir, () => false);
  registerProtocol('sample', dir, () => { throw new Error('unavailable'); });
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Z 桌面深链协议注册失败 sample$/);
  assert.match(lines[1], /Z 桌面深链协议注册失败 sample Error: unavailable$/);
  assert.equal(warn.mock.callCount(), 2);
});

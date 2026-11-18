import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { guidHideGuardClient } from '../guid-hide-guard-client.mjs';

class Element {
  constructor(tag = 'div', classes = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    const names = new Set(classes);
    this.classList = { contains: name => names.has(name), add: name => names.add(name), remove: name => names.delete(name) };
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  matches(selector) {
    return selector === '.wp-hide' && this.classList.contains('wp-hide');
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if ((selector === '.wp-hide' && child.classList.contains('wp-hide'))
          || (selector === '[data-testid="guid-input"]' && child.testId === 'guid-input')) result.push(child);
        visit(child);
      }
    };
    visit(this); return result;
  }
}

test('guid hide guard removes only wp-hide ancestors of the composer input', () => {
  const root = new Element('html'), existing = new Element('section', ['wp-hide']);
  const input = new Element('textarea'); input.testId = 'guid-input'; existing.append(input);
  const unrelated = new Element('section', ['wp-hide']); root.append(existing, unrelated);
  let callback;
  class MutationObserver {
    constructor(fn) { callback = fn; }
    observe() {}
  }
  const document = { documentElement: root };
  vm.runInNewContext(guidHideGuardClient(), { document, MutationObserver });
  assert.equal(existing.classList.contains('wp-hide'), false);
  assert.equal(unrelated.classList.contains('wp-hide'), true);

  const dynamic = new Element('section', ['wp-hide']); const dynamicInput = new Element('textarea');
  dynamicInput.testId = 'guid-input'; dynamic.append(dynamicInput); root.append(dynamic);
  callback([{ target: root, addedNodes: [dynamic] }]);
  assert.equal(dynamic.classList.contains('wp-hide'), false);
});

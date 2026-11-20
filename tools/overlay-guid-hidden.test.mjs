import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../image/rebrand/overlay/wp-overlay.js', import.meta.url), 'utf8');
const start = source.indexOf('  var SIDEBAR_ITEMS =');
const end = source.indexOf('  function messageTableScroll', start);
const applyStart = source.indexOf('    leaves(HOME_ITEMS', end);
const applyEnd = source.indexOf('    // 定时任务页', applyStart);

class Element {
  constructor(tag, text = '', classes = []) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.ownText = text;
    const names = new Set(classes); this._classNames = names;
    this.classList = { contains: name => names.has(name), add: name => names.add(name) };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    return selector.split(',').map(v => v.trim()).some(part => {
      if (part === 'textarea') return this.tagName === 'TEXTAREA';
      if (part === '[data-testid="guid-input"]') return this.testId === 'guid-input';
      const clsMatch = /^\[class\*="([^"]+)"\]$/.exec(part);
      if (clsMatch) return [...this.classListNames()].some(name => name.includes(clsMatch[1]));
      return false;
    });
  }
  classListNames() { return this._classNames || []; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const result = [];
    const matches = node => selectors.some(value => {
      if (/^[a-z]+$/.test(value)) return node.tagName === value.toUpperCase();
      if (value === 'textarea,input,[contenteditable]') return ['TEXTAREA', 'INPUT'].includes(node.tagName) || node.contentEditable;
      if (value === 'button') return node.tagName === 'BUTTON';
      if (value === '[data-testid="guid-input"]') return node.testId === 'guid-input';
      if (value === '[data-assistant-backend]') return Boolean(node.assistantBackend);
      const clsMatch = /^\[class\*="([^"]+)"\]$/.exec(value);
      if (clsMatch) return [...node.classListNames()].some(name => name.includes(clsMatch[1]));
      return false;
    });
    const visit = node => { for (const child of node.children) { if (matches(child)) result.push(child); visit(child); } };
    visit(this); return result;
  }
}

function makePage(model) {
  const body = new Element('body'), home = new Element('div', '', ['_guidContainer']);
  const modelRow = new Element('div'), modelLabel = new Element('span', model); modelRow.append(modelLabel);
  const input = new Element('textarea'); input.testId = 'guid-input';
  const footer = new Element('div'), feedback = new Element('button', '反馈问题'), remote = new Element('button', '远程连接');
  footer.append(feedback, remote); home.append(modelRow, input, footer); body.append(home);
  const document = { body, querySelector: () => null, querySelectorAll: selector => body.querySelectorAll(selector) };
  const window = {};
  const context = vm.createContext({ document, window, simplifyMenus() {}, workspacePanel() {} });
  vm.runInContext(source.slice(start, end) + `function runApply() {\n${source.slice(applyStart, applyEnd)}\n}\nwindow.overlayTest = { leaves, rowOf, hide, commonAncestor, runApply };`, context);
  return { api: window.overlayTest, home, modelRow, input, footer };
}

for (const model of ['claude/claude-opus-5-5', 'codex/gpt-6-astra']) test(`home model ${model} cannot hide the composer`, () => {
  const page = makePage(model), { api } = page;
  api.runApply();
  assert.equal(page.home.classList.contains('wp-hide'), false);
  assert.equal(page.input.classList.contains('wp-hide'), false);
  assert.equal(page.modelRow.classList.contains('wp-hide'), true);
  assert.equal(page.footer.classList.contains('wp-hide'), true);
});

test('home backend bar is hidden without hiding guid layout or composer', () => {
  const body = new Element('body'), container = new Element('div', '', ['_guidContainer_1']);
  const layout = new Element('div', '', ['_guidLayout_1']);
  const hero = new Element('div', '', ['_heroHeader_1']);
  const barOuter = new Element('div', '', ['mt-18px', 'mb-16px', 'w-full']);
  const barInner = new Element('div', '', ['flex']);
  const codexBtn = new Element('button', 'ChatGPT'); codexBtn.assistantBackend = 'codex';
  const claudeBtn = new Element('button', 'Claude'); claudeBtn.assistantBackend = 'claude';
  barInner.append(codexBtn, claudeBtn); barOuter.append(barInner);
  const card = new Element('div', '', ['_guidInputCardWrap_1']);
  const input = new Element('textarea'); input.testId = 'guid-input';
  card.append(input); layout.append(hero, barOuter, card); container.append(layout); body.append(container);
  const document = { body, querySelector: () => null, querySelectorAll: selector => body.querySelectorAll(selector) };
  const window = {};
  const context = vm.createContext({ document, window, simplifyMenus() {}, workspacePanel() {} });
  vm.runInContext(source.slice(start, end) + `function runApply() {\n${source.slice(applyStart, applyEnd)}\n}\nwindow.runApply = runApply;`, context);
  window.runApply();
  assert.equal(barOuter.classList.contains('wp-hide'), true);
  assert.equal(layout.classList.contains('wp-hide'), false);
  assert.equal(container.classList.contains('wp-hide'), false);
  assert.equal(hero.classList.contains('wp-hide'), false);
  assert.equal(card.classList.contains('wp-hide'), false);
  assert.equal(input.classList.contains('wp-hide'), false);
});

test('flat layout with backend button next to composer only hides the backend button', () => {
  const body = new Element('body'), shared = new Element('div', '', ['_guidContainer_1']);
  const codexBtn = new Element('button', 'ChatGPT'); codexBtn.assistantBackend = 'codex';
  const input = new Element('textarea'); input.testId = 'guid-input';
  shared.append(codexBtn, input); body.append(shared);
  const document = { body, querySelector: () => null, querySelectorAll: selector => body.querySelectorAll(selector) };
  const window = {};
  const context = vm.createContext({ document, window, simplifyMenus() {}, workspacePanel() {} });
  vm.runInContext(source.slice(start, end) + `function runApply() {\n${source.slice(applyStart, applyEnd)}\n}\nwindow.runApply = runApply;`, context);
  window.runApply();
  assert.equal(codexBtn.classList.contains('wp-hide'), true);
  assert.equal(shared.classList.contains('wp-hide'), false);
  assert.equal(input.classList.contains('wp-hide'), false);
});

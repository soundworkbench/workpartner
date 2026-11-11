#!/usr/bin/env node
// Browser check for “Try it” on a live workspace: the new-conversation composer holds the card's skill, then its text.
// Usage: node image/tests/verify-try-skill.mjs --cdp http://127.0.0.1:9222 --url https://workspace.example.com/ \
//          [--skill data-tools] [--locale zh-CN|en-US] [--screenshot /local/evidence/try-skill.png]
// The browser must already be signed in. Nothing is sent; the draft is cleared afterwards.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  cdp: { type: 'string', default: 'http://127.0.0.1:9222' }, url: { type: 'string' },
  skill: { type: 'string', default: 'data-tools' }, locale: { type: 'string', default: 'zh-CN' }, screenshot: { type: 'string' },
} });
if (!options.url) { console.error('--url is required'); process.exit(2); }
const included = { 'zh-CN': '已包含', 'en-US': 'Included' }[options.locale];
if (!included) { console.error('--locale must be zh-CN or en-US'); process.exit(2); }

const target = await (await fetch(`${options.cdp}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
let sequence = 0; const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};
async function until(label, expression, timeout = 20000) {
  for (const started = Date.now(); Date.now() - started < timeout;) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let failure = null;
try {
  await send('Page.enable');
  await send('Page.navigate', { url: new URL('#/market', options.url).href });
  await until('the market page', `!!document.querySelector('[data-wp-market-host] #wp-market-tools')`);
  await evaluate(`document.querySelector('#wp-market-tools').click()`);
  // Data cards show a price; hub cards show the included label instead.
  const tool = await until('a priced tool card', `(() => {
    const card = [...document.querySelectorAll('.wp-data-card')].find(node => node.querySelector('.wp-data-price')?.textContent !== ${JSON.stringify(included)});
    if (!card) return '';
    card.querySelector('.wp-skill-action').click(); return card.dataset.tool;
  })()`);
  const draft = await until('the drafted composer', `location.hash === '#/guid' && document.querySelector('[data-testid="guid-input"]')?.value || ''`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const state = await evaluate(`({ hash: location.hash, draft: document.querySelector('[data-testid="guid-input"]')?.value,
    menu: !!document.querySelector('[data-wp-slash-menu]') })`);
  if (options.screenshot) writeFileSync(options.screenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const prefix = `/${options.skill} `;
  const checks = {
    'skill comes first': draft.startsWith(prefix),
    'example text follows the skill': draft.slice(prefix.length).trim().length > 0,
    'draft is not sent': state.hash === '#/guid' && state.draft === draft,
    'skill menu stays closed': !state.menu,
  };
  console.log(JSON.stringify({ tool, draft, checks }, null, 2));
  if (!Object.values(checks).every(Boolean)) failure = new Error('Try it did not draft with the skill selected');
  // Leave the composer empty so the check never leaves a pending draft behind.
  await evaluate(`(() => { const input = document.querySelector('[data-testid="guid-input"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
} catch (error) {
  failure = error;
} finally {
  socket.close();
  await fetch(`${options.cdp}/json/close/${target.id}`);
}
if (failure) { console.error(failure.message); process.exit(1); }

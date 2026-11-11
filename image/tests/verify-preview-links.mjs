#!/usr/bin/env node
// Browser check for workspace previews: loopback links and window.open calls leave the page through the preview host.
// Usage: node image/tests/verify-preview-links.mjs --cdp http://127.0.0.1:9222 --url https://workspace.example.com/ \
//          [--port 5173]
// The browser must already be signed in and the deployment must enable preview. Nothing is sent to the workspace;
// the probe link is removed and any tab opened by the check is closed.
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  cdp: { type: 'string', default: 'http://127.0.0.1:9222' }, url: { type: 'string' }, port: { type: 'string', default: '5173' },
} });
if (!options.url) { console.error('--url is required'); process.exit(2); }
const local = `http://127.0.0.1:${options.port}/preview-check?from=link#top`;

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
const evaluate = async (expression, userGesture = false) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
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
const tabs = async () => (await (await fetch(`${options.cdp}/json/list`)).json()).filter(item => item.type === 'page');

let failure = null;
const opened = [];
try {
  await send('Page.enable');
  await send('Page.navigate', { url: options.url });
  await until('the workspace page', `document.readyState === 'complete' && !!document.querySelector('#root, #app, body > div')`);
  const loaded = await evaluate(`[...document.scripts].some(script => new URL(script.src || location.href).pathname === '/_wp/preview/client.js')`);
  // A loopback anchor is rewritten during the click; the bubbling listener keeps this tab in place.
  const link = await evaluate(`(() => {
    const a = document.createElement('a'); a.href = ${JSON.stringify(local)}; a.textContent = 'preview check';
    document.body.append(a);
    const stop = event => event.preventDefault();
    document.addEventListener('click', stop);
    a.click(); document.removeEventListener('click', stop);
    const result = { href: a.href, target: a.target, rel: a.rel }; a.remove(); return result;
  })()`);
  const before = new Set((await tabs()).map(item => item.id));
  await evaluate(`void window.open(${JSON.stringify(local.replace('from=link', 'from=open'))}, '_blank', 'noopener')`, true);
  const popup = await (async () => {
    for (const started = Date.now(); Date.now() - started < 10000;) {
      const fresh = (await tabs()).filter(item => !before.has(item.id) && item.id !== target.id);
      opened.push(...fresh.filter(item => !opened.some(seen => seen.id === item.id)));
      const ready = fresh.find(item => item.url && item.url !== 'about:blank');
      if (ready) return ready.url;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return '';
  })();
  const external = value => { try { return !['127.0.0.1', 'localhost'].includes(new URL(value).hostname); } catch { return false; } };
  const linkUrl = external(link.href) ? new URL(link.href) : null;
  const checks = {
    'client script is loaded': loaded,
    'link targets the preview start page': linkUrl?.pathname === '/_wp_preview/start'
      && linkUrl.searchParams.get('port') === options.port && linkUrl.searchParams.get('path') === '/preview-check?from=link#top',
    'link opens in a new tab': link.target === '_blank' && link.rel.includes('noopener'),
    'window.open leaves loopback': external(popup),
  };
  console.log(JSON.stringify({ link, popup, checks }, null, 2));
  if (!Object.values(checks).every(Boolean)) failure = new Error('Loopback preview links are not routed through the preview host');
} catch (error) {
  failure = error;
} finally {
  socket.close();
  for (const item of opened) await fetch(`${options.cdp}/json/close/${item.id}`);
  await fetch(`${options.cdp}/json/close/${target.id}`);
}
if (failure) { console.error(failure.message); process.exit(1); }

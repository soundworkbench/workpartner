import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatTitles, titleModels, titleTimeoutMs } from '../gateway/title.mjs';

const route = {
  backend: 'aionui',
  cookie: 'fixture-cookie',
  user: { slug: 'fixture-user' },
  up: { address: { host: 'workspace', port: 25808 } },
};

function fixture({ available, current = 'gpt-6.1-sol', ...options }) {
  let chat = { id: 'chat', name: 'Initial', extra: { backend: 'codex', current_model_id: current } };
  const requests = [];
  const fetcher = async (url, init = {}) => {
    const request = { url: String(url), init };
    requests.push(request);
    if (request.url.includes('/api/conversations/')) {
      if (init.method === 'PATCH') chat = { ...chat, ...JSON.parse(init.body) };
      return { ok: true, json: async () => ({ data: chat }) };
    }
    if (request.url.endsWith('/models')) return { ok: true, json: async () => ({ data: available.map(id => ({ id })) }) };
    if (request.url.endsWith('/chat/completions')) {
      request.body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '自动标题' } }] }) };
    }
    throw new Error(`Unexpected fixture request: ${request.url}`);
  };
  const titles = createChatTitles({ baseUrl: 'http://models.example/v1', keyFor: async () => 'fixture-key', fetcher, ...options });
  titles.created(route, JSON.stringify({ data: { id: 'chat', name: 'Initial', extra: { backend: 'codex' } } }));
  titles.before({ url: '/api/conversations/chat/messages', method: 'POST' }, route, JSON.stringify({ content: '整理这次会议' }));
  return { titles, requests, run: () => titles.generate(route, 'chat') };
}

test('title timeout defaults to 30 seconds, rejects malformed values, and clamps valid values', () => {
  assert.equal(titleTimeoutMs(undefined), 30000);
  assert.equal(titleTimeoutMs(''), 30000);
  assert.equal(titleTimeoutMs('not-a-number'), 30000);
  assert.equal(titleTimeoutMs('4999'), 5000);
  assert.equal(titleTimeoutMs('120001'), 120000);
  assert.equal(titleTimeoutMs('45000'), 45000);
});

test('title model configuration parses a comma-separated priority list', () => {
  assert.deepEqual(titleModels(' first , ,second '), ['first', 'second']);
  assert.deepEqual(titleModels(undefined), []);
});

test('title generation picks the first configured model advertised by the upstream', async () => {
  const f = fixture({ available: ['mp/slow', 'mp/fast', 'mp/gpt-6-luna'], models: 'fast,slow' });
  assert.equal(await f.run(), true);
  assert.equal(f.requests.find(request => request.url.endsWith('/chat/completions')).body.model, 'mp/fast');
});

test('an unavailable configured list falls back to the previous luna-first selection', async () => {
  const f = fixture({ available: ['mp/gpt-6-luna', 'mp/gpt-6.1-sol'], current: 'mp/gpt-6.1-sol', models: 'missing-a,missing-b' });
  assert.equal(await f.run(), true);
  assert.equal(f.requests.find(request => request.url.endsWith('/chat/completions')).body.model, 'mp/gpt-6-luna');
});

test('without title model configuration, selection remains luna-first then current-session fallback', async () => {
  const luna = fixture({ available: ['mp/gpt-6-luna', 'mp/gpt-6.1-sol'], current: 'mp/gpt-6.1-sol' });
  assert.equal(await luna.run(), true);
  assert.equal(luna.requests.find(request => request.url.endsWith('/chat/completions')).body.model, 'mp/gpt-6-luna');

  const current = fixture({ available: ['mp/gpt-6.1-sol'], current: 'mp/gpt-6.1-sol' });
  assert.equal(await current.run(), true);
  assert.equal(current.requests.find(request => request.url.endsWith('/chat/completions')).body.model, 'mp/gpt-6.1-sol');
});

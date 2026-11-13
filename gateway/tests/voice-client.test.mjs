import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { voiceClient, resample, encodeWav } from '../voice-client.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function client({ media, resume, worklet } = {}) {
  const requests = [], hints = [], tracks = [{ readyState: 'live', stop() { this.readyState = 'ended'; } }];
  const contexts = [], intervals = new Set(), urls = new Set();
  class Area {
    constructor() { this._value = ''; this.isConnected = true; this.selectionStart = 0; this.selectionEnd = 0; this.events = []; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    dispatchEvent(event) { this.events.push(event); }
  }
  const document = { activeElement: null }, area = new Area();
  const connection = () => ({ connect() {}, disconnect() { this.disconnected = true; } });
  class AudioContext {
    constructor() { this.sampleRate = 48000; this.destination = {}; contexts.push(this); if (worklet) this.audioWorklet = { addModule: worklet }; }
    resume() { this.resumed = true; return resume ? resume() : Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createScriptProcessor() { this.processor = { ...connection() }; return this.processor; }
    createMediaStreamSource() { return connection(); }
    createGain() { return { ...connection(), gain: { value: 1 } }; }
  }
  class AudioWorkletNode {
    constructor() { this.port = { close() {} }; }
    connect() {}
    disconnect() {}
  }
  const context = vm.createContext({ current: null, press: null, document, area, HTMLTextAreaElement: Area,
    window: { AudioContext, ...(worklet ? { AudioWorkletNode } : {}) }, AudioWorkletNode,
    navigator: { mediaDevices: { getUserMedia: media || (() => Promise.resolve({ getTracks: () => tracks })) } },
    URL: { createObjectURL() { urls.add('blob:fixture'); return 'blob:fixture'; }, revokeObjectURL(value) { urls.delete(value); } }, Blob,
    resample, encodeWav, Date, Float32Array, Event,
    render() {}, hint(value) { hints.push(value); },
    setInterval(callback) { intervals.add(callback); return callback; }, clearInterval(callback) { intervals.delete(callback); },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ text: '  你好  ' }) }; },
  });
  const script = voiceClient();
  vm.runInContext(script.slice(script.indexOf('  function release('), script.indexOf('  function mount(')), context);
  return { context, area, hints, tracks, contexts, requests, urls, intervals,
    async start() { await context.start(area); },
    capture(seconds) { contexts.at(-1).processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(Math.round(seconds * 48000)).fill(0.5) } }); } };
}

test('gesture creates and resumes context immediately; fallback posts WAV, inserts by native setter and stops tracks', async () => {
  const c = client(), pending = c.start();
  assert.equal(c.contexts.length, 1); assert.equal(c.contexts[0].resumed, true);
  await pending; c.capture(0.75); await c.context.finish();
  assert.equal(c.tracks[0].readyState, 'ended'); assert.equal(c.contexts[0].closed, true); assert.equal(c.intervals.size, 0);
  assert.equal(c.requests.length, 1); assert.equal(c.requests[0].url, '/_wp/api/voice/recognize');
  assert.equal(c.requests[0].options.method, 'POST'); assert.equal(c.requests[0].options.headers['content-type'], 'audio/wav');
  const wav = Buffer.from(c.requests[0].options.body); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt32LE(40), 24000);
  assert.equal(c.area.value, '你好'); assert.equal(c.area.events.length, 1); assert.equal(c.area.events[0].type, 'input'); assert.equal(c.area.events[0].bubbles, true);
  assert.equal(c.area.selectionStart, 2); assert.equal(c.context.current, null);
});

test('cancel during permission prompt stops late tracks, closes context and never recognizes', async () => {
  let grant;
  const c = client({ media: () => new Promise(resolve => { grant = resolve; }) });
  const pending = c.start(); c.context.cancel();
  grant({ getTracks: () => c.tracks }); await pending;
  assert.equal(c.tracks[0].readyState, 'ended'); assert.equal(c.contexts[0].closed, true);
  assert.equal(c.context.current, null); assert.equal(c.requests.length, 0); assert.equal(c.intervals.size, 0);
});

test('release before permission finishes rejects short recording and releases microphone', async () => {
  let grant;
  const c = client({ media: () => new Promise(resolve => { grant = resolve; }) });
  const pending = c.start(); await c.context.finish(); grant({ getTracks: () => c.tracks }); await pending;
  assert.deepEqual(c.hints, ['说话时间太短']); assert.equal(c.requests.length, 0); assert.equal(c.tracks[0].readyState, 'ended');
});

test('permission denial is caught without a recording or leaked context', async () => {
  const c = client({ media: () => Promise.reject(Object.assign(new Error('private'), { name: 'NotAllowedError' })) });
  await c.start(); assert.deepEqual(c.hints, ['没有麦克风权限，请在浏览器设置里允许']);
  assert.equal(c.requests.length, 0); assert.equal(c.contexts[0].closed, true); assert.equal(c.context.current, null);
});

test('worklet is preferred, cancelled loading cleans Blob URL, and load failure falls back to PCM', async () => {
  const preferred = client({ worklet: async () => {} }); await preferred.start();
  assert.ok(preferred.context.current.processor.port); assert.equal(preferred.contexts[0].processor, undefined);
  preferred.context.current.processor.port.onmessage({ data: new Float32Array(48000).fill(0.5) });
  await preferred.context.finish(); assert.equal(preferred.requests.length, 1); assert.equal(preferred.urls.size, 0);
  let loaded;
  const cancelled = client({ worklet: () => new Promise(resolve => { loaded = resolve; }) });
  const pending = cancelled.start(); await tick(); cancelled.context.cancel(); loaded(); await pending;
  assert.equal(cancelled.tracks[0].readyState, 'ended'); assert.equal(cancelled.urls.size, 0); assert.equal(cancelled.requests.length, 0);
  const fallback = client({ worklet: async () => { throw new Error('fixture'); } });
  await fallback.start(); fallback.capture(1); await fallback.context.finish();
  assert.equal(fallback.requests.length, 1); assert.equal(fallback.urls.size, 0);
});

test('recording cancellation and short audio skip fetch; 60-second PCM cap bounds the upload', async () => {
  const c = client(); await c.start(); c.capture(1); c.context.cancel();
  assert.equal(c.requests.length, 0); assert.equal(c.tracks[0].readyState, 'ended'); assert.equal(c.intervals.size, 0);
  const short = client(); await short.start(); short.capture(0.49); await short.context.finish();
  assert.deepEqual(short.hints, ['说话时间太短']); assert.equal(short.requests.length, 0);
  const capped = client(); await capped.start(); capped.capture(61); await capped.context.finish();
  assert.equal(Buffer.from(capped.requests[0].options.body).length, 1920044);
});

test('focused selection is replaced; unfocused text gets exactly one separating space', () => {
  const c = client(); c.area.value = '前替换后'; c.area.focus(); c.area.setSelectionRange(1, 3);
  c.context.insert({ area: c.area }, '新'); assert.equal(c.area.value, '前新后'); assert.equal(c.area.selectionStart, 2);
  c.context.document.activeElement = null; c.context.insert({ area: c.area }, '追加'); assert.equal(c.area.value, '前新后 追加');
  c.area.value = '尾部 '; c.context.document.activeElement = null; c.context.insert({ area: c.area }, '继续'); assert.equal(c.area.value, '尾部 继续');
});

test('busy, unavailable, empty and failed fetch show bounded messages without upstream text', async () => {
  for (const [ok, data, hint] of [[false, { error: 'busy', detail: 'private' }, '识别忙，请稍后再试'],
    [false, { error: 'private' }, '语音识别暂时不可用'], [true, { text: ' ' }, '没听清，请再说一次'], [null, null, '语音识别暂时不可用']]) {
    const c = client(); c.context.fetch = async () => { if (ok === null) throw new Error('private'); return { ok, json: async () => data }; };
    await c.start(); c.capture(1); await c.context.finish();
    assert.deepEqual(c.hints, [hint]); assert.equal(c.area.value, ''); assert.equal(c.context.current, null); assert.equal(c.tracks[0].readyState, 'ended');
  }
});

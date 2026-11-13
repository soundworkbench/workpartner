import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG } from './lib/suite.mjs';
import { ORIGIN } from './lib/harness.mjs';

const BUTTON = 'button[aria-label="语音输入"]', AREA = '#voice-composer textarea';
const SEND = '[data-testid="sendbox-send-btn"], [data-testid="guid-send-btn"], .sendbox-stop-button';
const TEXT = '语音夹具文字';
const suite = createSuite('voice', async s => {
  s.main = await s.harness.startGateway('voice', { feedback: false, voice: { allow: ['member'] }, asrUrl: s.harness.voice.baseUrl });
  s.off = await s.harness.startGateway('voice-off', { feedback: false });
  s.noPreview = await s.harness.startGateway('voice-no-preview', { preview: false, feedback: false, voice: { allow: ['member'] }, asrUrl: s.harness.voice.baseUrl });
});
async function session(label, options, body) {
  suite.harness.use(suite.main); suite.harness.voice.setMode('ok');
  return suite.session(label, { permissions: ['microphone'], ...options }, async value => {
    await body(value);
    assert.deepEqual(suite.harness.voice.failures, []);
    assert.deepEqual(value.log.pageErrors, []); assert.deepEqual(value.log.alerts, []);
    assert.equal(await value.page.evaluate(() => window.__sent), 0, 'recognition never submits');
  });
}
const recorded = async page => { await page.waitForSelector(BUTTON + '[data-state="recording"]'); await page.waitForTimeout(850); };
async function toggle(page) {
  await page.click(BUTTON); await recorded(page); await page.click(BUTTON);
  await page.waitForSelector(BUTTON + '[data-state="idle"]');
}
async function placement(page, singleLine = false) {
  await page.waitForFunction(selector => {
    const wrap = document.querySelector('.wp-voice'), send = document.querySelector(selector);
    return wrap && send && wrap.parentElement === send.parentElement && wrap.nextElementSibling === send;
  }, SEND);
  assert.equal(await page.locator('.wp-voice').count(), 1);
  assert.equal(await page.locator(BUTTON).count(), 1);
  assert.deepEqual(await page.evaluate(() => {
    const wrap = document.querySelector('.wp-voice'), a = wrap.getBoundingClientRect(), b = wrap.nextElementSibling.getBoundingClientRect();
    const model = wrap.parentElement.querySelector('.wp-pick-btn');
    return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      overlap: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
      inside: a.width > 0 && a.left >= 0 && a.right <= innerWidth && b.width > 0 && b.left >= 0 && b.right <= innerWidth,
      modelBefore: !model || Boolean(model.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING),
      zeroMargin: getComputedStyle(wrap).margin === '0px' };
  }), { overflow: false, overlap: false, inside: true, modelBefore: true, zeroMargin: true });
  const boxes = await page.evaluate(() => {
    const wrap = document.querySelector('.wp-voice');
    const rect = el => { const { left, right, top, bottom, width } = el.getBoundingClientRect(); return { left, right, top, bottom, width }; };
    const model = document.querySelector('#voice-composer .wp-pick-btn');
    return { mic: rect(wrap), send: rect(wrap.nextElementSibling), area: rect(document.querySelector('#voice-composer textarea')),
      model: rect(model), sameModelParent: model.parentElement === wrap.parentElement,
      modelFirst: model === model.parentElement.firstElementChild, modelRow: Boolean(model.closest('.wp-pick-row')) };
  });
  const { mic, send, area, model } = boxes;
  assert.ok(mic.left < mic.right && mic.right <= send.left, 'microphone is left of send/stop');
  assert.ok(mic.top < send.bottom && send.top < mic.bottom, 'microphone and send/stop share a row');
  assert.equal(boxes.modelFirst, true, 'model remains the first child');
  if (singleLine) {
    assert.ok(area.right <= mic.left && area.top < mic.bottom && mic.top < area.bottom, 'single-line microphone is right of input');
    assert.equal(boxes.sameModelParent, false);
    assert.equal(boxes.modelRow, true);
    assert.ok(model.top >= mic.bottom, 'single-line model stays on the following row');
  } else {
    assert.equal(boxes.sameModelParent, true);
    assert.ok(model.width > 0 && model.right <= mic.left, 'model right ≤ microphone left < microphone right ≤ send left');
  }
}

test('tap toggle inserts recognized WAV text through input event and never sends', LONG, async () => {
  await session('toggle', {}, async ({ page }) => {
    const hits = suite.harness.voice.hits.length;
    await toggle(page); assert.equal(await page.inputValue(AREA), TEXT);
    assert.equal(suite.harness.voice.hits.length, hits + 1);
    assert.deepEqual(await page.evaluate(() => window.__voiceInputs), [TEXT]);
    assert.deepEqual(await page.locator(AREA).evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, TEXT.length, TEXT.length]);
  });
});

test('focused insertion uses caret, unfocused insertion appends one space, selection replacement works', LONG, async () => {
  await session('caret', {}, async ({ page }) => {
    await page.fill(AREA, '前后'); await page.locator(AREA).evaluate(el => el.setSelectionRange(1, 1));
    await toggle(page); assert.equal(await page.inputValue(AREA), '前' + TEXT + '后');
    assert.equal(await page.locator(AREA).evaluate(el => el.selectionStart), 1 + TEXT.length);
    await page.fill(AREA, '已有文字'); await page.locator(AREA).evaluate(el => el.blur());
    await toggle(page); assert.equal(await page.inputValue(AREA), '已有文字 ' + TEXT);
    await page.fill(AREA, '前替换后'); await page.locator(AREA).evaluate(el => el.setSelectionRange(1, 3));
    await toggle(page); assert.equal(await page.inputValue(AREA), '前' + TEXT + '后');
    await page.fill(AREA, '已有文字 '); await page.locator(AREA).evaluate(el => el.blur());
    await toggle(page); assert.equal(await page.inputValue(AREA), '已有文字 ' + TEXT);
  });
});

test('hold and release recognizes; Esc, moving outside and pointer cancel never call ASR', LONG, async () => {
  await session('gestures', {}, async ({ page }) => {
    const box = await page.locator(BUTTON).boundingBox();
    const down = async () => { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await recorded(page); };
    await down(); await page.mouse.up(); await page.waitForFunction(text => document.querySelector('#voice-composer textarea').value === text, TEXT);
    const hits = suite.harness.voice.hits.length;
    await down(); await page.keyboard.press('Escape'); await page.mouse.up();
    await down(); await page.mouse.move(box.x - 40, box.y - 40); await page.mouse.up();
    await down(); await page.locator(BUTTON).dispatchEvent('pointercancel'); await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal(suite.harness.voice.hits.length, hits); assert.equal(await page.inputValue(AREA), TEXT);
    assert.equal(await page.getAttribute(BUTTON, 'data-state'), 'idle');
  });
});

test('lost capture cancels recording; replacing a held button permits a new gesture', LONG, async () => {
  await session('lost-capture', { init: [[() => {
    window.__voiceTracks = [];
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await get(options); window.__voiceTracks.push(...stream.getTracks()); return stream;
    };
    document.addEventListener('pointerdown', event => { window.__voicePointer = event.pointerId; }, true);
  }]] }, async ({ page }) => {
    const hits = suite.harness.voice.hits.length, box = await page.locator(BUTTON).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await recorded(page);
    await page.locator(BUTTON).evaluate(button => button.releasePointerCapture(window.__voicePointer));
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await page.waitForSelector(BUTTON + '[data-state="idle"]'); await page.mouse.up();
    assert.equal(suite.harness.voice.hits.length, hits);
    assert.deepEqual(await page.evaluate(() => window.__voiceTracks.map(track => track.readyState)), ['ended']);
    // Simulate a detached target whose lostpointercapture event never reaches its old listener.
    await page.locator(BUTTON).evaluate(button => {
      button.setPointerCapture = () => {};
      button.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 99, button: 0, bubbles: true }));
    });
    await recorded(page);
    await page.evaluate(() => document.querySelector('.wp-voice').remove());
    await page.waitForSelector(BUTTON);
    assert.equal(suite.harness.voice.hits.length, hits);
    await toggle(page);
    assert.equal(await page.inputValue(AREA), TEXT); assert.equal(suite.harness.voice.hits.length, hits + 1);
    assert.ok(await page.evaluate(() => window.__voiceTracks.every(track => track.readyState === 'ended')));
  });
});

test('recognition inserts into the visible replacement with the same selector, or explains a missing input', LONG, async () => {
  for (const mode of ['replacement', 'missing']) {
    await session('recognizing-' + mode, {}, async ({ page }) => {
      let unblock;
      const held = new Promise(resolve => { unblock = resolve; });
      await page.route('**/_wp/api/voice/recognize', async route => { await held; await route.continue(); });
      try {
        await page.click(BUTTON); await recorded(page); await page.click(BUTTON);
        await page.waitForSelector(BUTTON + '[data-state="recognizing"]');
        await page.evaluate(mode => {
          const old = document.querySelector('#voice-composer textarea');
          const hidden = old.cloneNode(true); hidden.hidden = true; document.body.prepend(hidden);
          const clone = document.createElement('div'); clone.className = 'wp-transition-composer';
          clone.append(old.cloneNode(true)); document.body.prepend(clone);
          const other = document.createElement('textarea'); other.dataset.testid = 'guid-input'; document.body.prepend(other);
          if (mode === 'missing') { old.remove(); return; }
          window.__renderComposer();
          const area = document.querySelector('#voice-composer textarea');
          area.value = '前后'; area.focus(); area.setSelectionRange(1, 1);
        }, mode);
      } finally { unblock(); }
      if (mode === 'replacement') {
        await page.waitForFunction(text => document.querySelector('#voice-composer textarea').value === '前' + text + '后', TEXT);
        assert.deepEqual(await page.evaluate(() => window.__voiceInputs), ['前' + TEXT + '后']);
        assert.equal(await page.locator(AREA).evaluate(el => el.selectionStart), 1 + TEXT.length);
      } else {
        await page.waitForSelector('.wp-voice-toast');
        assert.equal(await page.textContent('.wp-voice-toast'), '找不到输入框，请返回对话页面后重试');
      }
      assert.equal(await page.inputValue('body > textarea[data-testid="guid-input"]'), '');
      assert.equal(await page.inputValue('body > textarea[data-testid="sendbox-input"]'), '');
      assert.equal(await page.inputValue('.wp-transition-composer textarea'), '');
    });
  }
});

test('mutation bursts mount once per frame and recover after a DOM read fails', LONG, async () => {
  await session('mount-scheduling', {}, async ({ page }) => {
    const result = await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const original = document.querySelectorAll.bind(document), pending = [];
      const raf = window.requestAnimationFrame;
      let scans = 0, fail = false, frameId = 0;
      document.querySelectorAll = selector => {
        if (selector === '[data-testid="sendbox-input"], [data-testid="guid-input"]') {
          scans++; if (fail) throw new Error('fixture DOM read failure');
        }
        return original(selector);
      };
      window.requestAnimationFrame = callback => { pending.push(callback); return ++frameId; };
      const frame = () => pending.splice(0).forEach(callback => callback(performance.now()));
      const mutate = async () => {
        const el = document.createElement('span'); document.body.append(el);
        await new Promise(resolve => setTimeout(resolve, 0)); el.remove();
        await new Promise(resolve => setTimeout(resolve, 0));
      };
      try {
        await mutate(); await mutate();
        const beforeFrame = scans;
        frame(); const afterFrame = scans;
        fail = true; await mutate(); frame();
        fail = false; await mutate(); frame();
        return { beforeFrame, afterFrame, recovered: scans === 3 };
      } finally { document.querySelectorAll = original; window.requestAnimationFrame = raf; }
    });
    assert.deepEqual(result, { beforeFrame: 0, afterFrame: 1, recovered: true });
    await toggle(page); assert.equal(await page.inputValue(AREA), TEXT);
  });
});

test('busy, unavailable, empty and short audio have transient inline messages', LONG, async () => {
  await session('messages', {}, async ({ page }) => {
    for (const [mode, message] of [['busy', '识别忙，请稍后再试'], ['unavailable', '语音识别暂时不可用'], ['empty', '没听清，请再说一次']]) {
      suite.harness.voice.setMode(mode); await toggle(page);
      assert.equal(await page.textContent('.wp-voice-toast'), message); assert.equal(await page.inputValue(AREA), '');
    }
    const hits = suite.harness.voice.hits.length;
    await page.click(BUTTON); await page.waitForSelector(BUTTON + '[data-state="recording"]'); await page.click(BUTTON);
    assert.equal(await page.textContent('.wp-voice-toast'), '说话时间太短'); assert.equal(suite.harness.voice.hits.length, hits);
    await page.waitForSelector('.wp-voice-toast', { state: 'hidden', timeout: 5000 });
  });
});

test('fallback PCM recording also produces WAV and ends all tracks', LONG, async () => {
  await session('fallback', { init: [[() => {
    Object.defineProperty(window, 'AudioWorkletNode', { value: undefined });
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await get(options); window.__tracks = stream.getTracks(); return stream; };
  }]] }, async ({ page }) => {
    await toggle(page); assert.equal(await page.inputValue(AREA), TEXT);
    assert.deepEqual(await page.evaluate(() => window.__tracks.map(track => track.readyState)), ['ended']);
  });
});

test('microphone denial and unsupported browsers show the prescribed messages', LONG, async () => {
  await session('permission', { init: [[() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('fixture', 'NotAllowedError'); }; }]] }, async ({ page }) => {
    await page.click(BUTTON); await page.waitForSelector('.wp-voice-toast');
    assert.equal(await page.textContent('.wp-voice-toast'), '没有麦克风权限，请在浏览器设置里允许');
  });
  await session('unsupported', { init: [[() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); }]] }, async ({ page }) => {
    assert.equal(await page.getAttribute(BUTTON, 'aria-disabled'), 'true');
    assert.equal(await page.getAttribute(BUTTON, 'title'), '当前浏览器不支持语音输入');
    await page.click(BUTTON, { force: true }); assert.equal(await page.textContent('.wp-voice-toast'), '当前浏览器不支持语音输入');
  });
});

test('pending permission cancellation stops late tracks; early stop skips recognition', LONG, async () => {
  for (const action of ['cancel', 'finish']) {
    await session('pending-permission-' + action, { init: [[() => {
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = options => new Promise(resolve => {
        window.__grantVoice = async () => {
          const stream = await get(options); window.__voiceTracks = stream.getTracks(); resolve(stream);
        };
      });
      const resume = AudioContext.prototype.resume;
      AudioContext.prototype.resume = function () { window.__voiceContext = this; return resume.call(this); };
    }]] }, async ({ page }) => {
      const hits = suite.harness.voice.hits.length;
      await page.click(BUTTON); await page.waitForSelector(BUTTON + '[data-state="starting"]');
      assert.equal(await page.evaluate(() => Boolean(window.__voiceContext)), true, 'context created in the gesture');
      if (action === 'cancel') await page.keyboard.press('Escape'); else await page.click(BUTTON);
      await page.evaluate(() => window.__grantVoice());
      await page.waitForFunction(() => window.__voiceTracks?.every(track => track.readyState === 'ended') && window.__voiceContext.state === 'closed');
      await page.waitForSelector(BUTTON + '[data-state="idle"]');
      assert.equal(suite.harness.voice.hits.length, hits);
      if (action === 'finish') assert.equal(await page.textContent('.wp-voice-toast'), '说话时间太短');
    });
  }
});

test('worklet load failure falls back to PCM; cancellation while loading releases tracks and Blob URLs', LONG, async () => {
  for (const mode of ['failure', 'cancel']) {
    await session('worklet-' + mode, { init: [[mode => {
      const Base = AudioContext, revoke = URL.revokeObjectURL;
      window.__voiceRevoked = [];
      URL.revokeObjectURL = url => { window.__voiceRevoked.push(url); revoke.call(URL, url); };
      window.AudioContext = class extends Base {
        constructor() {
          super(); window.__voiceContext = this;
          this.audioWorklet.addModule = url => {
            window.__voiceBlob = url;
            if (mode === 'failure') return Promise.reject(new Error('fixture worklet failure'));
            return new Promise(resolve => { window.__loadVoice = resolve; });
          };
        }
      };
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async options => {
        const stream = await get(options); window.__voiceTracks = stream.getTracks(); return stream;
      };
    }, mode]] }, async ({ page }) => {
      const hits = suite.harness.voice.hits.length;
      if (mode === 'failure') {
        await toggle(page); assert.equal(await page.inputValue(AREA), TEXT);
        assert.equal(suite.harness.voice.hits.length, hits + 1);
      } else {
        await page.click(BUTTON); await page.waitForFunction(() => Boolean(window.__loadVoice));
        await page.keyboard.press('Escape'); await page.evaluate(() => window.__loadVoice());
        await page.waitForSelector(BUTTON + '[data-state="idle"]');
        assert.equal(suite.harness.voice.hits.length, hits);
      }
      await page.waitForFunction(() => window.__voiceContext.state === 'closed');
      assert.ok(await page.evaluate(() => window.__voiceTracks.every(track => track.readyState === 'ended')));
      assert.ok(await page.evaluate(() => window.__voiceRevoked.includes(window.__voiceBlob)));
    });
  }
});

test('recognition disables button and shows spinner; 50s warning and 60s automatic stop', LONG, async () => {
  await session('timer', {}, async ({ page }) => {
    await page.clock.install();
    await page.click(BUTTON); await recorded(page);
    await page.clock.fastForward(50000);
    assert.match(await page.textContent('.wp-voice-time'), /即将结束/);
    let unblock;
    const held = new Promise(resolve => { unblock = resolve; });
    await page.route('**/_wp/api/voice/recognize', async route => { await held; await route.continue(); });
    try {
      await page.clock.fastForward(10000);
      await page.waitForSelector(BUTTON + '[data-state="recognizing"]');
      assert.equal(await page.locator(BUTTON).isDisabled(), true);
      assert.equal(await page.locator(BUTTON).evaluate(el => getComputedStyle(el, '::after').animationName), 'wp-voice-spin');
    } finally { unblock(); }
    await page.waitForFunction(text => document.querySelector('#voice-composer textarea').value === text, TEXT);
  });
});

test('admission hides button and disabled feature leaves client unchanged; preview-off still installs', LONG, async () => {
  await session('outsider', { who: 'outsider' }, async ({ page }) => {
    assert.equal(await page.locator(BUTTON).count(), 0);
    assert.equal(await page.evaluate(() => window.__wpVoice), undefined);
  });
  for (const [gateway, count] of [[suite.off, 0], [suite.noPreview, 1]]) {
    suite.harness.use(gateway);
    await suite.session(gateway.name, {}, async ({ page }) => { assert.equal(await page.locator(BUTTON).count(), count); });
  }
});

test('missing send button prevents mounting and unrelated mutations leave a correctly placed microphone alone', LONG, async () => {
  await session('mount-guard', {}, async ({ page }) => {
    for (const route of ['#/conversation/fixture', '#/guid']) {
      await page.goto(ORIGIN + '/' + route); await page.waitForSelector(BUTTON);
      await placement(page);
      const moves = await page.evaluate(async () => {
        const wrap = document.querySelector('.wp-voice');
        let moves = 0;
        const observer = new MutationObserver(records => {
          for (const record of records) if ([...record.addedNodes, ...record.removedNodes].includes(wrap)) moves++;
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const unrelated = document.createElement('div'); document.body.append(unrelated);
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
        observer.disconnect(); unrelated.remove(); return moves;
      });
      assert.equal(moves, 0, 'observer does not repeatedly move an already adjacent microphone');
      await page.evaluate(async selector => {
        document.querySelector(selector).remove(); document.querySelector('.wp-voice').remove();
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
      }, SEND);
      assert.equal(await page.locator(BUTTON).count(), 0, 'no fallback to tools or submit container');
      await page.evaluate(() => window.__renderComposer());
      await placement(page);
    }
  });
});

for (const width of [1280, 390, 360]) {
  test(`home and chat at ${width}px: model/mic/send order, replacement, token insertion and transition clone`, LONG, async () => {
    await session('layout-' + width, { viewport: { width, height: 844 }, avatar: width >= 768 }, async ({ page }) => {
      for (const route of ['#/conversation/fixture', '#/guid']) {
        const home = route.includes('guid'), singleLine = !home && width < 768;
        await page.goto(ORIGIN + '/' + route); await page.waitForSelector(BUTTON);
        await placement(page, singleLine);
        await suite.shot(page, `${width}-${home ? 'home' : singleLine ? 'chat-single' : 'chat-multi'}`);
        const modes = singleLine ? [false, true, false] : [false];
        for (const multiline of modes) {
          if (singleLine) {
            await page.evaluate(value => {
              window.__previousSendParent = document.querySelector('[data-testid="sendbox-send-btn"]').parentElement;
              window.__previousArea = document.querySelector('#voice-composer textarea');
              window.__setComposerMultiline(value);
            }, multiline);
            assert.equal(await page.evaluate(() => !window.__previousSendParent.isConnected
              && window.__previousArea === document.querySelector('#voice-composer textarea')), true);
            assert.equal(await page.locator('.wp-pick-row').count(), multiline ? 0 : 1);
          }
          const compact = singleLine && !multiline;
          await placement(page, compact);
          if (singleLine && multiline) await suite.shot(page, `${width}-chat-multi`);
          for (const stopping of [true, false]) {
            await page.evaluate(value => window.__setComposerStopping(value), stopping);
            assert.equal(await page.locator('.sendbox-stop-button').count(), stopping ? 1 : 0);
            await placement(page, compact);
          }
          await page.evaluate(() => window.__insertComposerToken());
          await placement(page, compact);
          assert.equal(await page.locator('.wp-voice').evaluate(wrap => wrap.previousElementSibling.className), 'fixture-token');
          await page.evaluate(() => window.__setComposerStopping(true));
          await placement(page, compact);
          await page.evaluate(() => window.__setComposerStopping(false));
          await placement(page, compact);
        }
        await page.evaluate(() => { const area = document.querySelector('#voice-composer textarea'); area.replaceWith(area.cloneNode(true)); });
        await page.waitForFunction(() => document.querySelector('.wp-voice')?._area === document.querySelector('#voice-composer textarea'));
        await placement(page, singleLine);
        await page.evaluate(() => window.__renderComposer()); await page.waitForSelector(BUTTON);
        await placement(page, singleLine);
        await page.evaluate(() => {
          const source = document.querySelector('#voice-composer'), rect = source.getBoundingClientRect();
          const clone = source.cloneNode(true);
          clone.id = ''; clone.classList.add('wp-transition-composer');
          clone.setAttribute('aria-hidden', 'true'); clone.inert = true;
          // Match wp-overlay.js ghostShow(): preserve layout at the source rectangle outside normal flow.
          Object.assign(clone.style, { position: 'fixed', zIndex: '41', margin: '0', pointerEvents: 'none', transition: 'none',
            left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
          document.body.append(clone);
        });
        await page.waitForFunction(() => !document.querySelector('.wp-transition-composer .wp-voice'));
        await placement(page, singleLine);
        await page.evaluate(() => document.querySelector('.wp-transition-composer').remove());
        await toggle(page); assert.equal(await page.inputValue(AREA), TEXT);
      }
    });
  });
}

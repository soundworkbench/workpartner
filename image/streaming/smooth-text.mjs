/** Presentation-only pacing. The target remains the original, persisted Markdown. */
export class SmoothText {
  constructor(text = '', streaming = true, now = 0) {
    this.text = text;
    this.points = Array.from(text);
    this.streaming = streaming;
    this.started = !streaming;
    this.firstAt = text ? now : null;
    this.lastAt = now;
    this.progress = streaming ? 0 : this.points.length;
    this.shown = streaming ? 0 : this.points.length;
    this.ranges = protectedLines(text);
  }

  update(text, streaming, now) {
    // Settle the previous target and rate before new arrivals or a finish event.
    this.advance(now);
    if (!text.startsWith(this.text)) {
      // Corrections and replaced attempts are authoritative; do not splice unrelated prefixes.
      this.progress = Array.from(text).length;
      this.shown = this.progress;
    }
    if (text !== this.text) {
      this.text = text;
      this.points = Array.from(text);
      this.ranges = protectedLines(text);
    }
    if (this.firstAt === null && text) this.firstAt = now;
    this.streaming = streaming;
  }

  advance(now, immediate = false) {
    // Slow frames retain their elapsed time; idle credit never carries into new text.
    const elapsed = Math.max(0, now - this.lastAt);
    this.lastAt = now;
    if (immediate) this.progress = this.shown = this.points.length;
    else {
      if (!this.started && (this.points.length >= 20 || (this.firstAt !== null && now - this.firstAt >= 250) || !this.streaming)) {
        this.started = true;
      }
      if (this.started) {
        const backlog = this.points.length - this.progress;
        const cps = this.streaming ? Math.min(150, Math.max(40, backlog)) : 300;
        this.progress = Math.min(this.points.length, this.progress + cps * elapsed / 1000);
        let cut = Math.min(this.points.length, Math.max(1, Math.floor(this.progress + 1e-9)));
        for (const [start, end, complete] of this.ranges) {
          if (cut < start) break;
          if (cut < end || (!complete && this.streaming && cut === end)) { cut = start; break; }
        }
        this.shown = Math.max(this.shown, cut);
      }
    }
  }

  tick(now, immediate = false) {
    this.advance(now, immediate);
    const pending = this.shown < this.points.length;
    return { text: this.points.slice(0, this.shown).join(''), streaming: this.streaming || pending };
  }
}

/** Code and table lines become visible atomically; a table header waits for its separator. */
export function protectedLines(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const result = [];
  let fence = null, offset = 0, tableActive = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], length = Array.from(line).length;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)/u);
    const inFence = fence !== null;
    if (marker) {
      if (fence === null && !(marker[1][0] === '`' && marker[2].includes('`'))) fence = marker[1];
      else if (fence !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
    const table = !inFence && !marker && /(?<!\\)\|/u.test(line);
    if (!table) tableActive = false;
    if (inFence || marker || table || /^ {0,3}[`~]{1,2}$/u.test(line)) {
      const next = lines[i + 1];
      const separator = table && !tableActive && next !== undefined && /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/u.test(next);
      const awaitingSeparator = table && !tableActive && !separator && (next === undefined || !next.endsWith('\n'));
      result.push([offset, awaitingSeparator ? Array.from(text).length : offset + length + (separator ? Array.from(next).length : 0),
        !awaitingSeparator && line.endsWith('\n') && (!separator || next.endsWith('\n'))]);
      if (separator) tableActive = true;
    }
    offset += length;
  }
  return result;
}

/** Close only display syntax; incomplete link destinations never become image/network requests. */
export function repairStreamingMarkdown(text) {
  let fence = null, fencedEnd = 0, offset = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      if (fence === null && !(marker[1][0] === '`' && marker[2].includes('`'))) fence = marker[1];
      else if (fence !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
        fencedEnd = Math.min(text.length, offset + line.length + 1);
      }
    }
    offset += line.length + 1;
  }
  if (fence !== null) return text + (text.endsWith('\n') ? '' : '\n') + fence;
  // Only the growing last paragraph is repaired; earlier Markdown stays byte-for-byte intact.
  const paragraph = text.lastIndexOf('\n\n');
  const boundary = Math.max(fencedEnd, paragraph < 0 ? 0 : paragraph + 2);
  const head = text.slice(0, boundary);
  let tail = text.slice(boundary);
  tail = tail.replace(/(?<!\\)!?\[([^\]\n]*)(?:\](?:\([^\n)]*)?)?$/u, '$1');
  const stack = [];
  const tokens = /\\.|(`+)([\s\S]*?)(?:\1|$)|(\*{1,3})/gu;
  for (const match of tail.matchAll(tokens)) {
    const run = match[3];
    if (!run) continue;
    const at = match.index, before = tail[at - 1] ?? '', after = tail[at + run.length] ?? '';
    if (run === '*' && (at === 0 || before === '\n') && /\s/u.test(after)) continue;
    const opens = after !== '' && !/\s/u.test(after);
    const closes = before !== '' && !/\s/u.test(before);
    if (closes && stack.at(-1) === run) stack.pop();
    else if (opens) stack.push(run);
  }
  return head + tail + stack.reverse().join('');
}

/** Create a component once per module, sharing the existing React and Markdown renderer identities. */
export function createSmoothMarkdown(React, jsx, MarkdownText) {
  const PacedMarkdown = React.memo(function SmoothMarkdown(props) {
    const engine = React.useRef(null);
    if (engine.current === null) engine.current = new SmoothText(props.text, props.streaming === true, performance.now());
    const [view, setView] = React.useState(() => engine.current.tick(performance.now(),
      document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches));
    React.useLayoutEffect(() => {
      const state = engine.current;
      state.update(props.text, props.streaming === true, performance.now());
      const reduced = matchMedia('(prefers-reduced-motion: reduce)');
      let frame = 0, alive = true;
      const paint = () => {
        if (!alive) return;
        const next = state.tick(performance.now(), document.hidden || reduced.matches);
        setView(previous => previous.text === next.text && previous.streaming === next.streaming ? previous : next);
        if (next.streaming && state.points.length > 0 && (state.shown < state.points.length || !state.started) && !document.hidden && !reduced.matches) frame = requestAnimationFrame(paint);
      };
      const refresh = () => { cancelAnimationFrame(frame); paint(); };
      document.addEventListener('visibilitychange', refresh);
      reduced.addEventListener('change', refresh);
      paint();
      return () => {
        alive = false;
        cancelAnimationFrame(frame);
        document.removeEventListener('visibilitychange', refresh);
        reduced.removeEventListener('change', refresh);
      };
    }, [props.text, props.streaming]);
    // Settled history and authoritative replacements never wait for a pacing effect.
    const final = !props.streaming && view.text === props.text;
    return jsx(MarkdownText, { ...props,
      text: final ? props.text : view.text,
      streaming: final ? false : view.streaming,
      textInteractionSource: final && props.textInteractionSource,
    });
  });
  // Compact reasoning and explicit third-party reasoning seats retain their existing cadence.
  // Keeping the bypass outside PacedMarkdown also keeps history synchronous on first render.
  return React.memo(function MarkdownTextWithPacing(props) {
    return jsx(props.variant === 'compact' || props.workpartnerSmooth === false ? MarkdownText : PacedMarkdown, props);
  });
}

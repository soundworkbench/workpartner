import { requireValue as check } from './adopt-state.mjs';

export function readinessTimeout(value = 180) {
  const seconds = Number(value);
  check(String(value).trim() !== '' && Number.isFinite(seconds) && seconds > 0 && seconds <= 86400,
    '--ready-timeout requires seconds greater than 0 and at most 86400');
  return seconds * 1000;
}

// Bound both polling and an in-flight attempt. Only our own check messages are
// safe to log; runtime/API errors can contain command output or Secret values.
export async function waitForReady(name, action, { timeoutMs, log, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - now();
    check(ms > 0, 'Check did not complete before the readiness deadline');
    return ms;
  };
  let attempts = 0, reason = 'Check did not complete before the readiness deadline';
  while (now() < deadline) {
    attempts++;
    log(`WAIT ${name}: attempt ${attempts}`);
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => action(remaining)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), Math.max(1, deadline - now())); }),
      ]);
      remaining();
      log(`READY ${name}: attempt ${attempts}`);
      return;
    } catch (error) {
      reason = error.code === 'AdoptCheckFailed' ? error.message : 'Check unavailable or timed out';
    } finally { clearTimeout(timer); }
    const timeLeft = deadline - now();
    if (timeLeft <= 0) break;
    log(`WAIT ${name}: attempt ${attempts} failed: ${reason}`);
    await sleep(Math.min(5000, timeLeft));
  }
  check(false, `Timed out after ${attempts} attempts (${timeoutMs / 1000}s): ${reason}`);
}

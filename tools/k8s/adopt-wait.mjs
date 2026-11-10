import { requireValue as check } from './adopt-state.mjs';

export function readinessTimeout(value = 180) {
  const seconds = Number(value);
  check(String(value).trim() !== '' && Number.isFinite(seconds) && seconds > 0 && seconds <= 86400,
    '--ready-timeout requires seconds greater than 0 and at most 86400');
  return seconds * 1000;
}

// Never copy messages, response bodies, command output, or environment values.
// Accept only bounded numbers and conventional symbolic error codes.
export function safeErrorFields(error) {
  const fields = [];
  const status = [error?.status, error?.statusCode].find(value => Number.isInteger(value) && value >= 100 && value <= 599);
  if (status !== undefined) fields.push(`HTTP ${status}`);
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) fields.push(`code ${error.code}`);
  const exitCode = [error?.exitCode, error?.code].find(value => Number.isInteger(value) && value >= 0 && value <= 255);
  if (exitCode !== undefined) fields.push(`exit code ${exitCode}`);
  return fields.length ? ` (${fields.join(', ')})` : '';
}

// Bound both polling and an in-flight attempt. Only our own check messages and
// validated status/code fields are safe to log.
export async function waitForReady(name, action, { timeoutMs, log, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - now();
    check(ms > 0, 'Check did not complete before the readiness deadline (code ETIMEDOUT)');
    return ms;
  };
  let attempts = 0, reason = 'Check did not complete before the readiness deadline (code ETIMEDOUT)';
  while (now() < deadline) {
    attempts++;
    log(`WAIT ${name}: attempt ${attempts}`);
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => action(remaining)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' })), Math.max(1, deadline - now())); }),
      ]);
      remaining();
      log(`READY ${name}: attempt ${attempts}`);
      return;
    } catch (error) {
      const checked = error?.code === 'AdoptCheckFailed';
      reason = checked ? error.message : `Check unavailable or timed out${safeErrorFields(error)}`;
      if (checked && error.retry === false) {
        log(`WAIT ${name}: attempt ${attempts} failed: ${reason}`);
        check(false, `Failed after ${attempts} attempts: ${reason}`, { retry: false });
      }
    } finally { clearTimeout(timer); }
    const timeLeft = deadline - now();
    if (timeLeft <= 0) break;
    log(`WAIT ${name}: attempt ${attempts} failed: ${reason}`);
    await sleep(Math.min(5000, timeLeft));
  }
  check(false, `Timed out after ${attempts} attempts (${timeoutMs / 1000}s): ${reason}`);
}

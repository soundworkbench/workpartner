import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { context } from './context.mjs';
import { scenarios } from './scenarios.mjs';

export async function run(config, id, phase) {
  const scenario = scenarios.find(item => item.id === id);
  if (!scenario) throw new Error('Unknown scenario');
  const started = Date.now();
  let c;
  try {
    c = await context(config);
    const evidence = await scenario.run(c, phase);
    return { id, title: scenario.title, phase, status: evidence?.status === 'SKIP' ? 'SKIP' : 'PASS', durationMs: Date.now() - started, evidence };
  } catch (error) {
    // Never serialize runtime exceptions, stdout, Secret values or password logs.
    return { id, title: scenario.title, phase, status: 'FAIL', durationMs: Date.now() - started,
      error: { name: error.name, code: error.code, reason: error.reason }, evidence: c?.evidence,
      location: error.stack?.split('\n').find(line => line.includes('/scenarios.mjs:'))?.trim() };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(fs.readFileSync(0, 'utf8'));
  const result = await run(config, process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result));
  if (result.status === 'FAIL') process.exitCode = 1;
}

// Strict CI gate, including partial SKIPs nested inside otherwise PASS results.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function incompleteEvidence(value) {
  if (typeof value === 'string') return /^(FAIL|SKIP)(?:$|[:\s])/.test(value);
  return value !== null && typeof value === 'object' && Object.values(value).some(incompleteEvidence);
}

export function review(results, cleanup) {
  const records = Array.isArray(results?.results) ? results.results : [];
  const rows = [];
  for (let index = 1; index <= 13; index++) {
    const id = `S${index}`;
    const phases = id === 'S9' ? ['prepare', 'missing', 'restored'] : id === 'S13' ? ['prepare', 'restored'] : [undefined];
    for (const phase of phases) {
      const matches = records.filter(r => r?.id === id && r.phase === phase);
      const record = matches[0];
      const status = matches.length !== 1 ? 'MISSING/INVALID' : record.status !== 'PASS'
        ? (['FAIL', 'SKIP'].includes(record.status) ? record.status : 'INVALID')
        : incompleteEvidence(record.evidence) ? 'FAIL/SKIP in evidence' : 'PASS';
      rows.push({ scenario: id + (phase ? `/${phase}` : ''), status });
    }
  }
  const clean = cleanup?.status === 'PASS' && Array.isArray(cleanup.residual) && cleanup.residual.length === 0
    && ['warnings', 'discoveryWarnings', 'allPrefixesResidual', 'errors'].every(key => Array.isArray(cleanup[key]) && cleanup[key].length === 0);
  return { rows, clean, pass: results?.complete === true && records.length === rows.length
    && rows.every(row => row.status === 'PASS') && clean };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = process.argv.length < 3;
  const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  let summary = '## K8 k3d results\n\n';
  for (const [index, directory] of process.argv.slice(2).entries()) {
    const results = read(path.join(directory, 'results.json'));
    const result = review(results, read(path.join(directory, 'cleanup.json')));
    summary += `### Pass ${index + 1}\n\n| Scenario / phase | Result |\n| --- | --- |\n`;
    for (const row of result.rows) summary += `| ${row.scenario} | ${row.status} |\n`;
    summary += `\nComplete: ${results?.complete === true}; cleanup: ${result.clean ? 'PASS' : 'FAIL/MISSING (including warnings/residuals)'}\n\n`;
    failed ||= !result.pass;
  }
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (failed) process.exitCode = 1;
}

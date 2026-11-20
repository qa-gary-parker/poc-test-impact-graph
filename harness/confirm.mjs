// Re-runs each killed mutant's failing test files on their own with the mutant applied.
// A file that passes on its own failed through load or timing (flaky), not through the fault.
// Records per mutant how the kept files failed: failed tests, or a file-level error (parse or collection) with no failed test.
import { join } from 'node:path';
import { RESULTS, readJson, readJsonl, runSuite, sh, withMutant, writeJson } from './lib.mjs';

const OUT = join(RESULTS, 'confirm.json');
const confirmed = readJson(OUT, {});
const byId = Object.fromEntries(readJson(join(RESULTS, 'mutants.json')).mutants.map((m) => [m.id, m]));
if (sh(['git', 'status', '--porcelain', '--untracked-files=no']).stdout.trim()) throw new Error('work/hono has local changes');

for (const r of readJsonl(join(RESULTS, 'mutant-runs.jsonl'))) {
  if (r.timedOut || !r.failing.length || confirmed[r.id]) continue;
  const rerun = withMutant(byId[r.id], () => runSuite(r.failing));
  if (rerun.timedOut) throw new Error(`#${r.id}: confirm run timed out`);
  const kept = rerun.files.filter((f) => f.status !== 'passed' && r.failing.includes(f.file));
  const files = kept.map((f) => f.file);
  confirmed[r.id] = {
    files,
    failedTests: kept.reduce((a, f) => a + f.failedTests, 0),
    fileErrors: Object.fromEntries(kept.filter((f) => !f.failedTests).map((f) => [f.file, f.error])),
  };
  writeJson(OUT, confirmed);
  const dropped = r.failing.filter((f) => !files.includes(f));
  console.log(`#${r.id} ${files.length}/${r.failing.length} confirmed, ${confirmed[r.id].failedTests} failed tests${dropped.length ? ` (dropped ${dropped.join(', ')})` : ''}`);
}

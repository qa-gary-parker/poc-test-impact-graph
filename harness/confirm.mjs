// Re-runs each killed mutant's failing test files on their own with the mutant applied.
// A file that passes on its own failed through load or timing (flaky), not through the fault.
import { join } from 'node:path';
import { RESULTS, readJson, readJsonl, runSuite, sh, withMutant, writeJson } from './lib.mjs';

const OUT = join(RESULTS, 'confirm.json');
const confirmed = readJson(OUT, {});
const byId = Object.fromEntries(readJson(join(RESULTS, 'mutants.json')).mutants.map((m) => [m.id, m]));
if (sh(['git', 'status', '--porcelain', '--untracked-files=no']).stdout.trim()) throw new Error('work/hono has local changes');

for (const r of readJsonl(join(RESULTS, 'mutant-runs.jsonl'))) {
  if (r.timedOut || !r.failing.length || confirmed[r.id]) continue;
  const rerun = withMutant(byId[r.id], () => runSuite(r.failing));
  const again = rerun.timedOut ? r.failing : rerun.files.filter((f) => f.status !== 'passed').map((f) => f.file);
  confirmed[r.id] = r.failing.filter((f) => again.includes(f));
  writeJson(OUT, confirmed);
  const dropped = r.failing.length - confirmed[r.id].length;
  console.log(`#${r.id} ${confirmed[r.id].length}/${r.failing.length} confirmed${dropped ? ` (dropped ${r.failing.filter((f) => !again.includes(f)).join(', ')})` : ''}`);
}

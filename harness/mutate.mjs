// For each mutant: apply it, run the whole suite (ground truth), ask the graph which tests cover the
// changed function, then restore the file. Resumable: finished mutants in results/mutant-runs.jsonl are skipped.
import { join } from 'node:path';
import { RESULTS, crgJson, isSuiteFile, readJson, readJsonl, appendJsonl, rel, runSuite, sh, withMutant } from './lib.mjs';

const OUT = join(RESULTS, 'mutant-runs.jsonl');
const { mutants } = readJson(join(RESULTS, 'mutants.json'));
const done = new Set(readJsonl(OUT).map((r) => r.id));
const limit = Number(process.env.LIMIT ?? Infinity);

if (sh(['git', 'status', '--porcelain', '--untracked-files=no']).stdout.trim()) throw new Error('work/hono has local changes');

let ran = 0;
for (const m of mutants) {
  if (done.has(m.id) || ran >= limit) continue;
  withMutant(m, () => {
    const suite = runSuite(['src/']);
    const dc = crgJson(['detect-changes', '--base', 'HEAD']);
    const changed = (dc.changed_functions ?? []).filter((n) => n.kind !== 'File').map((n) => n.qualified_name);
    const testsFor = new Set();
    for (const q of changed) {
      const r = crgJson(['query', 'tests_for', q]);
      for (const n of r.results ?? []) if (n.file_path) testsFor.add(rel(n.file_path));
    }
    appendJsonl(OUT, {
      id: m.id,
      timedOut: suite.timedOut,
      wallMs: suite.ms,
      failedTests: suite.numFailedTests ?? null,
      failing: suite.timedOut ? null : suite.files.filter((f) => isSuiteFile(f.file) && f.status !== 'passed').map((f) => f.file),
      changedFunctions: changed.map((q) => q.split('::').pop()),
      testsFor: [...testsFor].sort(),
    });
    ran++;
    console.log(`#${m.id} ${m.file}:${m.line} ${m.from.trim()}->${m.to.trim()} ${suite.timedOut ? 'TIMEOUT' : `${suite.numFailedTests} failed`} (${ran} this run, ${done.size + ran}/${mutants.length})`);
  });
}

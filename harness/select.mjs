// File-level selections, computed once per changed file on the clean tree:
// code-review-graph `impact` at depth 1, 2 (default) and 3, `vitest related`, and the same-name test file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HONO, RESULTS, crgJson, isSuiteFile, readJson, rel, runSuite, writeJson } from './lib.mjs';

const OUT = join(RESULTS, 'selections.json');
const cache = readJson(OUT, {});
const suite = new Set(Object.keys(readJson(join(RESULTS, 'baseline.json')).files));

export function selectFor(file) {
  if (cache[file]) return cache[file];
  const entry = {};
  for (const depth of [1, 2, 3]) {
    const r = crgJson(['impact', '--files', file, '--depth', String(depth), '--detail-level', 'compact', '--max-files', '200']);
    entry[`impact_d${depth}`] = {
      tests: r.impacted_files.filter((f) => suite.has(f)).sort(),
      impactedFiles: r.impacted_file_count,
      impactedNodes: r.total_impacted,
      truncated: r.truncated,
      unmatched: r.unmatched_files_total,
    };
  }
  const related = runSuite([file, '--run'], { cmd: 'related' });
  entry.vitest_related = { tests: related.timedOut ? null : related.files.map((f) => f.file).filter(isSuiteFile).sort() };
  const base = file.replace(/\.ts$/, '');
  entry.same_name = { tests: [`${base}.test.ts`, `${base}.test.tsx`].filter((f) => suite.has(f) && existsSync(join(HONO, f))) };
  cache[file] = entry;
  writeJson(OUT, cache);
  return entry;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { mutants } = readJson(join(RESULTS, 'mutants.json'));
  const files = [...new Set(mutants.map((m) => m.file))];
  files.forEach((f, i) => {
    const e = selectFor(rel(f));
    console.log(`${i + 1}/${files.length} ${f}: d1 ${e.impact_d1.tests.length}, d2 ${e.impact_d2.tests.length}, d3 ${e.impact_d3.tests.length}, related ${e.vitest_related.tests?.length}, same-name ${e.same_name.tests.length}`);
  });
}

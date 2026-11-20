// File-level selections, computed once per changed file on the clean tree:
// code-review-graph `impact` with default settings at depth 1, 2 (default) and 3, `vitest related`, and the same-name test file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HONO, RESULTS, crgJson, isSuiteFile, readJson, rel, runSuite, writeJson } from './lib.mjs';

const OUT = join(RESULTS, 'selections.json');
const cache = readJson(OUT, {});
const suite = new Set(Object.keys(readJson(join(RESULTS, 'baseline.json')).files));
// The tool's default node limit, recorded from the installed package by harness/env.mjs.
const NODE_LIMIT = readJson(join(RESULTS, 'env.json')).impactDefaults['--max-results'];

export function selectFor(file) {
  if (cache[file]) return cache[file];
  const entry = {};
  for (const depth of [1, 2, 3]) {
    // Only --depth is passed; every other setting is the tool's default (results/env.json).
    const r = crgJson(['impact', '--files', file, '--depth', String(depth)]);
    if (r.impacted_files_omitted) throw new Error(`impact ${file} d${depth}: ${r.impacted_files_omitted} impacted files omitted`);
    entry[`impact_d${depth}`] = {
      tests: r.impacted_files.map(rel).filter((f) => suite.has(f)).sort(),
      impactedFiles: r.impacted_files.length,
      impactedNodes: r.total_impacted,
      nodeLimitHit: r.total_impacted > NODE_LIMIT,
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

// Three clean runs of the suite: per-file durations and any file that fails without a fault.
import { join } from 'node:path';
import { RESULTS, HONO_SHA, isSuiteFile, runSuite, sh, writeJson } from './lib.mjs';

const RUNS = 3;
if (sh(['git', 'rev-parse', 'HEAD']).stdout.trim() !== HONO_SHA) throw new Error('work/hono is not at the measured commit');
if (sh(['git', 'status', '--porcelain', '--untracked-files=no']).stdout.trim()) throw new Error('work/hono has local changes');

const runs = [];
for (let i = 0; i < RUNS; i++) {
  const r = runSuite(['src/']);
  if (r.timedOut) throw new Error('clean run timed out');
  runs.push(r);
  console.log(`run ${i + 1}: ${r.files.length} files, ${r.numTotalTests} tests, ${r.numFailedTests} failed, ${r.ms} ms`);
}

const files = {};
for (const r of runs) {
  for (const f of r.files.filter((x) => isSuiteFile(x.file))) {
    (files[f.file] ??= { ms: [], failed: 0 }).ms.push(f.ms);
    if (f.status !== 'passed') files[f.file].failed++;
  }
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const perFile = Object.fromEntries(Object.entries(files).sort().map(([f, v]) => [f, { ms: median(v.ms), failedRuns: v.failed }]));

writeJson(join(RESULTS, 'baseline.json'), {
  honoSha: HONO_SHA,
  node: process.version,
  runs: runs.map((r) => ({ wallMs: r.ms, files: r.files.length, tests: r.numTotalTests, failedTests: r.numFailedTests })),
  flakyFiles: Object.keys(perFile).filter((f) => perFile[f].failedRuns > 0),
  files: perFile,
});

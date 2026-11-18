// Aggregates every result file into results/summary.json and prints the tables.
import { join } from 'node:path';
import { RESULTS, readJson, readJsonl, writeJson } from './lib.mjs';

const ARMS = ['impact_d1', 'impact_d2', 'impact_d3', 'tests_for', 'vitest_related', 'same_name', 'full'];
const baseline = readJson(join(RESULTS, 'baseline.json'));
const { mutants, sites, filesScanned } = readJson(join(RESULTS, 'mutants.json'));
const rawRuns = readJsonl(join(RESULTS, 'mutant-runs.jsonl'));
const selections = readJson(join(RESULTS, 'selections.json'));
const commits = readJson(join(RESULTS, 'commits.json'), []);
const confirmed = readJson(join(RESULTS, 'confirm.json'));
const runs = rawRuns.map((r) => (r.timedOut || !r.failing.length ? r : { ...r, unconfirmed: r.failing.filter((f) => !confirmed[r.id].includes(f)), failing: confirmed[r.id] }));

const suiteFiles = Object.keys(baseline.files);
const totalMs = suiteFiles.reduce((a, f) => a + baseline.files[f].ms, 0);
const msOf = (tests) => tests.reduce((a, f) => a + (baseline.files[f]?.ms ?? 0), 0);
const byId = Object.fromEntries(mutants.map((m) => [m.id, m]));
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function selection(arm, run) {
  if (arm === 'full') return suiteFiles;
  if (arm === 'tests_for') return run.testsFor;
  return selections[byId[run.id].file]?.[arm]?.tests ?? null;
}

const killed = runs.filter((r) => !r.timedOut && r.failing.length > 0);
const flaky = new Set(baseline.flakyFiles);
const droppedAsFlaky = runs.filter((r) => r.unconfirmed?.length).map((r) => ({ id: r.id, files: r.unconfirmed, stillKilled: r.failing.length > 0 }));
const mutantArms = {};
for (const arm of ARMS) {
  const rows = killed.map((r) => {
    const sel = new Set(selection(arm, r) ?? []);
    const failing = r.failing.filter((f) => !flaky.has(f));
    return {
      id: r.id,
      caught: failing.some((f) => sel.has(f)),
      complete: failing.every((f) => sel.has(f)),
      files: sel.size,
      timeShare: msOf([...sel]) / totalMs,
    };
  });
  mutantArms[arm] = {
    caught: rows.filter((x) => x.caught).length,
    caughtPct: pct(rows.filter((x) => x.caught).length, rows.length),
    complete: rows.filter((x) => x.complete).length,
    completePct: pct(rows.filter((x) => x.complete).length, rows.length),
    emptySelections: rows.filter((x) => x.files === 0).length,
    medianFiles: median(rows.map((x) => x.files)),
    meanTimeSharePct: pct(mean(rows.map((x) => x.timeShare)), 1),
    missedIds: rows.filter((x) => !x.caught).map((x) => x.id),
  };
}

const commitArms = {};
const withTests = commits.filter((c) => c.authorTests.length);
for (const arm of ARMS) {
  const sel = (c) => (arm === 'full' ? suiteFiles : arm === 'tests_for' ? null : c.arms[arm]);
  if (arm === 'tests_for') continue;
  commitArms[arm] = {
    medianFiles: median(commits.map((c) => sel(c).length)),
    meanTimeSharePct: pct(mean(commits.map((c) => msOf(sel(c)) / totalMs)), 1),
    emptySelections: commits.filter((c) => sel(c).length === 0).length,
    authorTestsAllSelected: withTests.filter((c) => c.authorTests.every((t) => sel(c).includes(t))).length,
  };
}

const summary = {
  target: { repo: 'honojs/hono', sha: baseline.honoSha, suiteFiles: suiteFiles.length, suiteTests: baseline.runs[0].tests, suiteWallMs: median(baseline.runs.map((r) => r.wallMs)), suiteFileMsTotal: totalMs },
  tools: { 'code-review-graph': '2.4.0', vitest: '5.0.1', node: baseline.node },
  mutants: {
    filesScanned,
    sites,
    sampled: mutants.length,
    ran: runs.length,
    killed: killed.length,
    survived: runs.filter((r) => !r.timedOut && r.failing.length === 0).length,
    timedOut: runs.filter((r) => r.timedOut).length,
    filesWithKilled: new Set(killed.map((r) => byId[r.id].file)).size,
    medianFailingFiles: median(killed.map((r) => r.failing.length)),
    droppedAsFlaky,
  },
  mutantArms,
  commits: { replayed: commits.length, withAuthorTests: withTests.length, arms: commitArms },
};
writeJson(join(RESULTS, 'summary.json'), summary);

console.log(`Killed mutants: ${killed.length} of ${runs.length} (survived ${summary.mutants.survived}, timed out ${summary.mutants.timedOut})\n`);
console.log('| arm | caught | all failing files selected | median test files | mean share of suite time |');
console.log('|---|---|---|---|---|');
for (const arm of ARMS) {
  const a = mutantArms[arm];
  console.log(`| ${arm} | ${a.caught} (${a.caughtPct}%) | ${a.complete} (${a.completePct}%) | ${a.medianFiles} | ${a.meanTimeSharePct}% |`);
}
if (commits.length) {
  console.log(`\nCommits replayed: ${commits.length}; with author test changes: ${withTests.length}\n`);
  console.log('| arm | median test files | mean share of suite time | empty | author tests all selected |');
  console.log('|---|---|---|---|---|');
  for (const [arm, a] of Object.entries(commitArms)) console.log(`| ${arm} | ${a.medianFiles} | ${a.meanTimeSharePct}% | ${a.emptySelections} | ${a.authorTestsAllSelected} of ${withTests.length} |`);
}

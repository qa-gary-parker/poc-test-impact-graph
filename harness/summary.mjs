// Aggregates every result file into results/summary.json and prints the tables.
import { join } from 'node:path';
import { RESULTS, readJson, readJsonl, writeJson } from './lib.mjs';

const ARMS = ['impact_d1', 'impact_d2', 'impact_d3', 'tests_for', 'vitest_related', 'same_name', 'full'];
const baseline = readJson(join(RESULTS, 'baseline.json'));
const env = readJson(join(RESULTS, 'env.json'));
const { mutants, sites, filesScanned } = readJson(join(RESULTS, 'mutants.json'));
const rawRuns = readJsonl(join(RESULTS, 'mutant-runs.jsonl'));
const selections = readJson(join(RESULTS, 'selections.json'));
const commits = readJson(join(RESULTS, 'commits.json'), []);
const confirmed = readJson(join(RESULTS, 'confirm.json'));
// Every result file records the Node it ran on; the summary refuses a mix.
const nodes = new Set([
  env.node,
  baseline.node,
  readJson(join(RESULTS, 'mutants.json')).node,
  ...rawRuns.map((r) => r.node),
  ...Object.values(confirmed).map((c) => c.node),
  ...Object.values(selections).map((s) => s.node),
  ...commits.map((c) => c.node),
]);
if (nodes.size !== 1) throw new Error(`results were produced on more than one Node: ${[...nodes].join(', ')}`);
const [node] = nodes;
const confirmedRuns = rawRuns.map((r) => {
  if (r.timedOut || !r.failing.length) return r;
  const c = confirmed[r.id];
  return { ...r, unconfirmed: r.failing.filter((f) => !c.files.includes(f)), failing: c.files, failedTests: c.failedTests, fileErrors: c.fileErrors };
});
// A mutant whose failing files only report a parse error did not compile: not a fault, excluded like a timeout.
const isParseError = (r) => r.failing?.length > 0 && r.failedTests === 0 && Object.values(r.fileErrors).every((e) => /PARSE_ERROR|Transform failed/.test(e ?? ''));
const invalid = confirmedRuns.filter(isParseError).map((r) => ({ id: r.id, error: Object.values(r.fileErrors)[0] }));
const runs = confirmedRuns.filter((r) => !isParseError(r));

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

// Changed files of the caught faults where `impact` hit the tool's default node limit (results/env.json).
const killedFiles = [...new Set(killed.map((r) => byId[r.id].file))].sort();
const nodeLimitHit = Object.fromEntries([1, 2, 3].map((d) => [`impact_d${d}`, killedFiles.filter((f) => selections[f][`impact_d${d}`].nodeLimitHit)]));

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
  tools: { 'code-review-graph': env['code-review-graph'], vitest: env.vitest, node, macOS: env.macOS },
  mutants: {
    filesScanned,
    sites,
    sampled: mutants.length,
    ran: confirmedRuns.length,
    killed: killed.length,
    killedByFailedTest: killed.filter((r) => r.failedTests > 0).length,
    killedByFileErrorOnly: killed.filter((r) => r.failedTests === 0).map((r) => ({ id: r.id, files: r.failing, errors: r.fileErrors })),
    invalid,
    survived: runs.filter((r) => !r.timedOut && r.failing.length === 0).length,
    timedOut: runs.filter((r) => r.timedOut).length,
    filesWithKilled: killedFiles.length,
    medianFailingFiles: median(killed.map((r) => r.failing.length)),
    droppedAsFlaky,
  },
  impact: { defaults: env.impactDefaults, nodeLimitHit },
  mutantArms,
  commits: { replayed: commits.length, withAuthorTests: withTests.length, arms: commitArms },
};
writeJson(join(RESULTS, 'summary.json'), summary);

const m = summary.mutants;
console.log(`Killed mutants: ${killed.length} of ${m.ran} (${m.killedByFailedTest} by a failed test, ${m.killedByFileErrorOnly.length} by a file-level error only; survived ${m.survived}, timed out ${m.timedOut}, did not parse ${invalid.length})\n`);
console.log('| arm | caught | all failing files selected | median test files | mean share of suite time |');
console.log('|---|---|---|---|---|');
for (const arm of ARMS) {
  const a = mutantArms[arm];
  console.log(`| ${arm} | ${a.caught} (${a.caughtPct}%) | ${a.complete} (${a.completePct}%) | ${a.medianFiles} | ${a.meanTimeSharePct}% |`);
}
console.log(`\nimpact node limit (default --max-results ${env.impactDefaults['--max-results']}) hit for the changed files of caught faults: ${Object.entries(nodeLimitHit).map(([arm, f]) => `${arm} ${f.length} of ${killedFiles.length}${f.length ? ` (${f.join(', ')})` : ''}`).join('; ')}`);
if (commits.length) {
  console.log(`\nCommits replayed: ${commits.length}; with author test changes: ${withTests.length}\n`);
  console.log('| arm | median test files | mean share of suite time | empty | author tests all selected |');
  console.log('|---|---|---|---|---|');
  for (const [arm, a] of Object.entries(commitArms)) console.log(`| ${arm} | ${a.medianFiles} | ${a.meanTimeSharePct}% | ${a.emptySelections} | ${a.authorTestsAllSelected} of ${withTests.length} |`);
}

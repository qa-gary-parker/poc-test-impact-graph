// Records the walkthrough from results/ on stage.html, timed to the narration.
import { test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(here, 'out');
const SPEED = process.env.SPEED ?? '1.15';
const VOICE = process.env.VOICE ?? '';
// Narration clips: NARRATE renders one line (`NARRATE [-v VOICE] -s SPEED -o out.wav "line"`), NARRATE_CHECK checks them all.
// The hash of NARRATE_KEY_FILE joins the clip cache key, so a change to that file renders every line again.
const NARRATE = process.env.NARRATE ?? '';
const NARRATE_CHECK = process.env.NARRATE_CHECK ?? '';
const keyFile = process.env.NARRATE_KEY_FILE ?? '';
const VOICE_KEY = VOICE && keyFile && fs.existsSync(keyFile) ? `${VOICE}:${crypto.createHash('sha1').update(fs.readFileSync(keyFile)).digest('hex').slice(0, 8)}` : VOICE;
// HQ=1: 2x-DPR CDP screencast instead of recordVideo, voice chain, -14 LUFS, variable pauses, room tone
const HQ = !!process.env.HQ;
const GAP = 550;
const GAP_IN = 380; // HQ: pause within a chapter
const GAP_OUT = 1000; // HQ: pause before a new chapter
// FAST=1: no narration, one screenshot per step in out/frames, no video
const FAST = !!process.env.FAST;
// PLAN=1: render the narration, write the predicted out/narration.tsv and out/chapters.txt, no recording
const PLAN = !!process.env.PLAN;

type Run = { id: number; timedOut: boolean; failing: string[]; failedTests: number; changedFunctions: string[]; testsFor: string[] };
type Mutant = { id: number; file: string; line: number; col: number; from: string; to: string };
type Fault = Run & { m: Mutant; fileErrors: Record<string, string | null> };
type Arm = 'impact_d1' | 'impact_d2' | 'impact_d3' | 'tests_for' | 'vitest_related' | 'same_name' | 'full';
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const json = (f: string) => JSON.parse(read(f));
const HONO = path.join(root, 'work/hono');
if (!fs.existsSync(HONO)) throw new Error('work/hono is missing: run npm run setup');
const hono = (f: string) => fs.readFileSync(path.join(HONO, f), 'utf8');

const sum = json('results/summary.json');
const env = json('results/env.json');
const baseline: { files: Record<string, { ms: number }>; runs: { wallMs: number; tests: number }[]; flakyFiles: string[] } = json('results/baseline.json');
const MUT: { sites: number; filesScanned: number; mutants: Mutant[] } = json('results/mutants.json');
const confirm: Record<string, { files: string[]; failedTests: number; fileErrors: Record<string, string | null> }> = json('results/confirm.json');
const selections: Record<string, Record<string, { tests: string[]; impactedFiles?: number; nodeLimitHit?: boolean }>> = json('results/selections.json');
const commits: { sha: string; subject: string; code: string[]; authorTests: string[]; arms: Record<string, string[]> }[] = json('results/commits.json');
const rawRuns: Run[] = read('results/mutant-runs.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SELECT = read('harness/select.mjs');
const MUTATE = read('harness/mutate.mjs');
const LIB = read('harness/lib.mjs');
const README = read('README.md');

// The scoring of harness/summary.mjs, done again from the raw files
const SUITE = Object.keys(baseline.files);
const GRID = [...SUITE].sort();
const totalMs = SUITE.reduce((a, f) => a + baseline.files[f].ms, 0);
const share = (tests: string[]) => (100 * tests.reduce((a, f) => a + (baseline.files[f]?.ms ?? 0), 0)) / totalMs;
const byId = Object.fromEntries(MUT.mutants.map((m) => [m.id, m]));
const isParseError = (r: Fault) => r.failedTests === 0 && Object.values(r.fileErrors).every((e) => /PARSE_ERROR|Transform failed/.test(e ?? ''));
const broke = rawRuns.filter((r) => !r.timedOut && r.failing.length)
  .map((r): Fault => ({ ...r, m: byId[r.id], failing: confirm[r.id].files, failedTests: confirm[r.id].failedTests, fileErrors: confirm[r.id].fileErrors }));
const FAULTS = broke.filter((r) => !isParseError(r));
const fault = (id: number) => FAULTS.find((r) => r.id === id)!;
const pick = (arm: Arm, r: Fault) => (arm === 'full' ? SUITE : arm === 'tests_for' ? r.testsFor : selections[r.m.file][arm].tests);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const score = (arm: Arm, rs = FAULTS) => {
  const rows = rs.map((r) => {
    const sel = new Set(pick(arm, r));
    return { id: r.id, caught: r.failing.some((f) => sel.has(f)), complete: r.failing.every((f) => sel.has(f)), files: sel.size, share: share([...sel]) };
  });
  return {
    rows,
    caught: rows.filter((x) => x.caught).length,
    complete: rows.filter((x) => x.complete).length,
    empty: rows.filter((x) => x.files === 0).length,
    medianFiles: median(rows.map((x) => x.files)),
    meanShare: mean(rows.map((x) => x.share)),
    medianShare: median(rows.map((x) => x.share)),
  };
};
const ARMS: Arm[] = ['impact_d1', 'impact_d2', 'impact_d3', 'tests_for', 'vitest_related', 'same_name', 'full'];
const A = Object.fromEntries(ARMS.map((a) => [a, score(a)])) as Record<Arm, ReturnType<typeof score>>;
const NAME: Record<Arm, string> = { impact_d1: 'impact, depth 1', impact_d2: 'impact, depth 2', impact_d3: 'impact, depth 3', tests_for: 'tests_for', vitest_related: 'vitest related', same_name: 'same name', full: 'full suite' };
const COLOR: Record<Arm, string> = { impact_d1: 'blue', impact_d2: 'pass', impact_d3: 'blue', tests_for: 'fail', vitest_related: 'warn', same_name: 'muted', full: 'muted' };
const p1 = (x: number) => x.toFixed(1);
const pct = (n: number) => p1((100 * n) / FAULTS.length);
const R = (x: number) => Number(p1(x));

// The faults where vitest related picked more than half of the suite's test time
const HEAVY = A.vitest_related.rows.filter((x) => x.share > 50).map((x) => x.id);
const heavyFaults = FAULTS.filter((r) => HEAVY.includes(r.id));
const heavyD2 = score('impact_d2', heavyFaults);
const heavyPoints = A.vitest_related.rows.filter((x) => HEAVY.includes(x.id)).reduce((a, x) => a + x.share, 0) / FAULTS.length;
const heavyFiles = Object.entries(heavyFaults.reduce<Record<string, number>>((a, r) => ({ ...a, [r.m.file]: (a[r.m.file] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const partialD2 = A.impact_d2.rows.filter((x) => x.caught && !x.complete).map((x) => x.id);
const vrBuckets = [A.vitest_related.rows.filter((x) => x.share < 10).length, A.vitest_related.rows.filter((x) => x.share >= 10 && x.share <= 50).length, HEAVY.length];

// The example faults
const F31 = fault(31), F32 = fault(32), F218 = fault(218), F295 = fault(295), F3 = fault(3);
const ROUTER = 'src/router/reg-exp-router/router.ts';
const URL_TS = 'src/utils/url.ts';
const WS = 'src/adapter/cloudflare-workers/websocket.ts';
const WS_TEST = 'src/adapter/cloudflare-workers/websocket.test.ts';
const CTX = 'src/context.ts';
const both = (a: string[], b: string[]) => a.filter((f) => b.includes(f));
const cells = (files: string[]) => files.map((f) => { const i = GRID.indexOf(f); if (i < 0) throw new Error('not a suite file: ' + f); return i; });
const lines = (file: string, a: number, b: number) => hono(file).split('\n').slice(a - 1, b).join('\n');
// The line on screen must hold the mutated operator at the recorded column
const at = (m: Mutant) => { const l = hono(m.file).split('\n')[m.line - 1]; if (!l.slice(m.col).startsWith(m.from)) throw new Error(`#${m.id}: ${m.from} not at ${m.file}:${m.line}:${m.col}`); return l.trim(); };
const squash = (s: string) => s.replace(/\s+/g, '');
// Code on screen is reflowed to fit: every block must still be in the source file
const from = (source: string, shown: string) => {
  for (const block of shown.split('\n\n')) {
    const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    if (!squash(source).includes(squash(code))) throw new Error('not in the source: ' + block);
  }
  return shown;
};
const SELECT_SHOWN = SELECT.slice(SELECT.indexOf('  for (const depth'), SELECT.indexOf('      impactedFiles')).trimEnd() + '\n      ...';
const MUTATE_SHOWN = MUTATE.slice(MUTATE.indexOf('    const dc = crgJson'), MUTATE.indexOf('    appendJsonl')).trimEnd();
const CRG = from(LIB, "export const CRG = ['uvx', '--python', '3.12', 'code-review-graph@2.4.0'];");
const RUN_SHOWN = README.slice(README.indexOf('npm run setup      #'), README.indexOf('```', README.indexOf('npm run setup      #'))).trimEnd();
const MUTANT_LIST = MUT.mutants.slice(0, 12).map((m) => `#${String(m.id).padEnd(4)}${`${m.file}:${m.line}`.padEnd(48)}${m.from.trim()} → ${m.to.trim()}`).join('\n');
const D2_SHOWN = JSON.stringify({ impact_d2: sum.mutantArms.impact_d2 }, null, 2).split('\n').filter((l) => !l.includes('missedIds') && !/^\s+\d+$|^\s+\]/.test(l)).join('\n');
const TEST_FILE_PICK = (arm: Arm, f: Fault) => both(pick(arm, f), f.failing).length;
const commit859 = commits.find((c) => c.sha.startsWith('859e2c2'))!;
const withTests = commits.filter((c) => c.authorTests.length);
const authorPicked = (arm: string) => withTests.filter((c) => c.authorTests.every((t) => c.arms[arm].includes(t))).length;
const commitShare = (arm: string) => mean(commits.map((c) => share(c.arms[arm])));
const commitEmpty = (arm: string) => commits.filter((c) => !c.arms[arm].length).length;
const limitHit = (d: number) => [...new Set(FAULTS.map((r) => r.m.file))].filter((f) => selections[f][`impact_d${d}`].nodeLimitHit).sort();
const ROWS = ARMS.map((a) => [NAME[a] + (a === 'impact_d2' ? ' (default)' : ''), `${A[a].caught} (${pct(A[a].caught)}%)`, `${A[a].complete} (${pct(A[a].complete)}%)`, String(A[a].medianFiles), `${p1(A[a].meanShare)}%`]);
const table = (head: string[], rows: string[][], ids: string[] = []) => `<table class="tbl"><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r, i) => `<tr${ids[i] ? ` id="${ids[i]}"` : ''}>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

// Every number the narration says, checked against the data before recording
const SPOKEN: [string, unknown, unknown][] = [
  ['summary arms match the raw files', ARMS.every((a) => { const s = sum.mutantArms[a]; return s.caught === A[a].caught && s.complete === A[a].complete && s.emptySelections === A[a].empty && s.medianFiles === A[a].medianFiles && s.meanTimeSharePct === R(A[a].meanShare); }), true],
  ['faults drawn', MUT.mutants.length, 300],
  ['faults run', rawRuns.length, 300],
  ['operator sites', MUT.sites, 1373],
  ['source files scanned', MUT.filesScanned, 155],
  ['at most per file', Math.max(...Object.values(MUT.mutants.reduce<Record<string, number>>((a, m) => ({ ...a, [m.file]: (a[m.file] ?? 0) + 1 }), {}))), 6],
  ['faults that broke a test file', FAULTS.length, 237],
  ['summary killed', sum.mutants.killed, 237],
  ['broke none', rawRuns.filter((r) => !r.timedOut && !r.failing.length).length, 61],
  ['timed out', rawRuns.filter((r) => r.timedOut).length, 1],
  ['did not parse', broke.filter(isParseError).length, 1],
  ['killed by a failed test', FAULTS.filter((r) => r.failedTests > 0).length, 236],
  ['source files with a fault that broke a test', new Set(FAULTS.map((r) => r.m.file)).size, 73],
  ['median failing files', median(FAULTS.map((r) => r.failing.length)), 1],
  ['files dropped by the confirm pass', FAULTS.filter((r) => rawRuns.find((x) => x.id === r.id)!.failing.some((f) => !r.failing.includes(f))).length, 0],
  ['flaky files', baseline.flakyFiles.length, 0],
  ['test files', SUITE.length, 123],
  ['tests', baseline.runs[0].tests, 5110],
  ['clean runs', baseline.runs.length, 3],
  ['suite seconds, about', Math.round(sum.target.suiteWallMs / 1000), 5],
  ['suite seconds, one decimal', p1(sum.target.suiteWallMs / 1000), '5.2'],
  ['hono sha', sum.target.sha.slice(0, 8), 'a8ae5b1d'],
  ['code-review-graph', env['code-review-graph'], '2.4.0'],
  ['vitest', env.vitest, '5.0.1'],
  ['node', env.node, 'v24.21.0'],
  ['default depth', env.impactDefaults['--depth'], 2],
  ['node limit', env.impactDefaults['--max-results'], 500],
  ['selectors, not counting the full suite', ARMS.length - 1, 6],
  // The result
  ['impact d2 caught', A.impact_d2.caught, 236],
  ['impact d2 caught %', pct(A.impact_d2.caught), '99.6'],
  ['impact d2 share', p1(A.impact_d2.meanShare), '3.4'],
  ['vitest related caught', A.vitest_related.caught, 237],
  ['vitest related share', p1(A.vitest_related.meanShare), '16.1'],
  ['impact d2 / vitest related, in fifths', Math.round((5 * A.impact_d2.meanShare) / A.vitest_related.meanShare), 1],
  ['impact d2 missed', FAULTS.length - A.impact_d2.caught, 1],
  ['tests_for caught', A.tests_for.caught, 146],
  ['tests_for caught %', pct(A.tests_for.caught), '61.6'],
  // Fault #31
  ['#31 file and swap', [F31.m.file, F31.m.line, F31.m.from, F31.m.to], ['src/utils/jwt/jws.ts', 90, 'true', 'false']],
  ['#31 failed tests', F31.failedTests, 12],
  ['#31 failing files', F31.failing, ['src/utils/jwt/jwt.test.ts']],
  ['#31 impact d2 picks', pick('impact_d2', F31).length, 3],
  ['#31 impact d2 picks the failing file', TEST_FILE_PICK('impact_d2', F31), 1],
  ['#31 share of the 3 files', p1(share(pick('impact_d2', F31))), '9.7'],
  ['#31 vitest related picks the same 3', pick('vitest_related', F31), pick('impact_d2', F31)],
  ['#31 changed function', F31.changedFunctions, ['importPublicKey']],
  ['#31 tests_for', F31.testsFor, []],
  // Results
  ['impact d3 caught', A.impact_d3.caught, 236],
  ['impact d1 caught', A.impact_d1.caught, 219],
  ['same name caught', A.same_name.caught, 190],
  ['impact d2 picked all', A.impact_d2.complete, 198],
  ['vitest related picked all', A.vitest_related.complete, 237],
  ['impact d2 partial picks', partialD2.length, 38],
  ['full suite files', A.full.medianFiles, 123],
  // Where the time goes
  ['vitest related median share', p1(A.vitest_related.medianShare), '1.8'],
  ['impact d2 median share', p1(A.impact_d2.medianShare), '0.6'],
  ['faults where vitest related picked more than half', HEAVY.length, 59],
  ['test files picked for those', [Math.min(...heavyFaults.map((r) => pick('vitest_related', r).length)), Math.max(...heavyFaults.map((r) => pick('vitest_related', r).length))], [58, 92]],
  ['their points of the mean, nearly 14 of 16', [Math.ceil(heavyPoints), heavyPoints > 13.5, Math.floor(A.vitest_related.meanShare)], [14, true, 16]],
  ['their points, one decimal', p1(heavyPoints), '13.9'],
  ['core files among them', ['src/router/reg-exp-router/router.ts', 'src/router/trie-router/node.ts', CTX, URL_TS, 'src/compose.ts'].every((f) => heavyFiles.some(([h]) => h === f)), true],
  ['url.ts vitest related picks', selections[URL_TS].vitest_related.tests.length, 82],
  ['url.ts impact d2 picks', selections[URL_TS].impact_d2.tests.length, 14],
  ['#32 file and swap', [F32.m.file, F32.m.line, F32.m.from, F32.m.to], [ROUTER, 31, '===', '!==']],
  ['#32 changed function', F32.changedFunctions, ['covers']],
  ['#32 failing files', F32.failing.length, 13],
  ['#32 impact d2 picks', pick('impact_d2', F32).length, 2],
  ['#32 impact d2 picks that fail', TEST_FILE_PICK('impact_d2', F32), 2],
  ['#32 impact d2 share', p1(share(pick('impact_d2', F32))), '0.4'],
  ['#32 vitest related picks', pick('vitest_related', F32).length, 59],
  ['#32 vitest related picks all failing', TEST_FILE_PICK('vitest_related', F32), 13],
  ['#32 vitest related share', p1(share(pick('vitest_related', F32))), '53.7'],
  ['impact d2 on the heavy faults: caught, picked all', [heavyD2.caught, heavyD2.complete], [59, 29]],
  ['impact d2 share on the heavy faults', p1(heavyD2.meanShare), '6.3'],
  ['impact d2 partial picks among the heavy faults', partialD2.filter((id) => HEAVY.includes(id)).length, 30],
  // Depth
  ['impact d1 empty', A.impact_d1.empty, 18],
  ['impact d1: every miss is an empty pick', A.impact_d1.rows.filter((x) => !x.caught).every((x) => x.files === 0), true],
  ['impact d3 picked all, more than d2', A.impact_d3.complete - A.impact_d2.complete, 5],
  ['impact d3 share', p1(A.impact_d3.meanShare), '5.0'],
  ['impact d2 and d3 missed the same fault', [A.impact_d2.rows.filter((x) => !x.caught).map((x) => x.id), A.impact_d3.rows.filter((x) => !x.caught).map((x) => x.id)], [[218], [218]]],
  // The one miss
  ['#218 file and swap', [F218.m.file, F218.m.line, F218.m.from, F218.m.to], [WS, 15, '!==', '===']],
  ['#218 failed tests', F218.failedTests, 6],
  ['#218 failing files', F218.failing, [WS_TEST]],
  ['#218 impacted files at depth 1, 2, 3', [1, 2, 3].map((d) => selections[WS][`impact_d${d}`].impactedFiles), [0, 0, 0]],
  ['#218 vitest related and same name pick the test', [pick('vitest_related', F218).includes(WS_TEST), pick('same_name', F218).includes(WS_TEST)], [true, true]],
  ['#295 file and swap', [F295.m.file, F295.m.line, F295.m.from.trim(), F295.m.to.trim()], ['src/middleware/jwk/jwk.ts', 70, '||', '&&']],
  ['#295 failed tests', F295.failedTests, 0],
  ['#295 error', Object.values(F295.fileErrors)[0]?.includes('requires options'), true],
  ['#295 is the one caught by a file error only', FAULTS.filter((r) => r.failedTests === 0).map((r) => r.id), [295]],
  // Function level
  ['tests_for empty', A.tests_for.empty, 58],
  ['tests_for empty with no changed function', FAULTS.filter((r) => !r.testsFor.length && !r.changedFunctions.length).length, 4],
  ['#3 file and changed function', [F3.m.file, F3.changedFunctions], [URL_TS, ['_getQueryParam']]],
  ['#3 failing files, failed tests', [F3.failing.length, F3.failedTests], [4, 23]],
  ['#3 tests_for', F3.testsFor, []],
  ['#3 impact d2 picks all 4', TEST_FILE_PICK('impact_d2', F3), 4],
  // Commits
  ['commits replayed', commits.length, 100],
  ['commits with author tests', withTests.length, 88],
  ['author tests picked: d1, d2, d3, related, same name', ['impact_d1', 'impact_d2', 'impact_d3', 'vitest_related', 'same_name'].map(authorPicked), [73, 83, 83, 84, 60]],
  ['commit share: d2, related', [p1(commitShare('impact_d2')), p1(commitShare('vitest_related'))], ['11.1', '19.1']],
  ['commit shares match the summary', ['impact_d1', 'impact_d2', 'impact_d3', 'vitest_related', 'same_name'].every((a) => sum.commits.arms[a].meanTimeSharePct === R(commitShare(a)) && sum.commits.arms[a].authorTestsAllSelected === authorPicked(a)), true],
  ['commit d2 / related, in fifths', Math.round((5 * commitShare('impact_d2')) / commitShare('vitest_related')), 3],
  ['commit empty: d1, same name', [commitEmpty('impact_d1'), commitEmpty('same_name')], [3, 13]],
  ['859e2c2 code files, test files', [commit859.code.length, commit859.authorTests.length], [4, 45]],
  // Node limit
  ['over the limit at depth 1, 2', [limitHit(1), limitHit(2)], [[CTX], [CTX]]],
  ['over the limit at depth 3', limitHit(3), [CTX, 'src/request.ts', 'src/utils/mime.ts', URL_TS]],
  ['context.ts picks at depth 1, 2, 3', [1, 2, 3].map((d) => selections[CTX][`impact_d${d}`].tests.length), [13, 13, 13]],
  ['context.ts picks are the same', new Set([1, 2, 3].map((d) => selections[CTX][`impact_d${d}`].tests.join())).size, 1],
  // Run it
  ['README: Node, uv, git', README.includes('Needs Node 24.21.0 (`nvm use`), `uv`, and git.'), true],
  ['README: mutate takes about 45 min', README.includes('npm run mutate     # results/mutant-runs.jsonl (about 45 min)'), true],
];
for (const [what, got, said] of SPOKEN) if (JSON.stringify(got) !== JSON.stringify(said)) throw new Error(`narration says ${JSON.stringify(said)} for ${what}, data has ${JSON.stringify(got)}`);

function speech(text: string) {
  if (FAST) return { wav: '', seconds: 0.3 };
  const dir = path.join(outDir, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, crypto.createHash('sha1').update(VOICE_KEY + SPEED + text).digest('hex').slice(0, 12) + '.wav');
  if (!fs.existsSync(wav)) {
    if (!NARRATE) throw new Error(`no clip for "${text}" and no NARRATE command`);
    execFileSync(NARRATE, [...(VOICE ? ['-v', VOICE] : []), '-s', SPEED, '-o', wav, text]);
  }
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' }));
  return { wav, seconds };
}

type Stage = (fn: string, ...args: unknown[]) => Promise<void>;
type Step = { ch?: string; cap: string; say: string; act?: (S: Stage, page: Page) => Promise<unknown> };
const bars = async (S: Stage, arms: Arm[], value: (a: Arm) => number, max: number, note: string) => {
  await Promise.all(arms.map((a) => S('bar', NAME[a], value(a), max, COLOR[a], note)));
};
const faultGrid = async (S: Stage, title: string, sub: string, f: Fault, arm?: Arm) => {
  await S('clear');
  await S('chart', title, sub);
  await S('grid', GRID.length);
  await S('paint', cells(f.failing), 'F');
  if (arm) await S('paint', cells(pick(arm, f)), 'P');
};
const gridKey = (S: Stage, picked: string) => S('key', [['fails', 'fail'], [picked, 'blue']]);
const TIME_ARMS: Arm[] = ['impact_d1', 'impact_d2', 'impact_d3', 'tests_for', 'vitest_related', 'same_name'];

const steps: Step[] = [
  {
    ch: 'The result',
    cap: "300 seeded faults in hono: the graph's default pick caught 236 of 237",
    say: 'I asked a code graph which tests to run, for three hundred seeded faults in hono. Its default answer caught two hundred and thirty-six of the two hundred and thirty-seven faults that broke a test.',
    act: (S) => S('card', `<h1>code-review-graph impact</h1><h2>300 seeded faults in hono · ${FAULTS.length} broke a test</h2><h2><span class="g">caught ${A.impact_d2.caught} of ${FAULTS.length}</span></h2><h2 id="h2"></h2>`),
  },
  {
    cap: "99.6% of faults caught, at a mean 3.4% of the suite's test time",
    say: "That is ninety-nine point six percent. And it ran three point four percent of the suite's test time.",
    act: (S) => S('append', '#h2', `<span class="g">${pct(A.impact_d2.caught)}%</span> caught · <span class="g">${p1(A.impact_d2.meanShare)}%</span> of suite time`),
  },
  {
    cap: 'vitest related caught all 237, at a mean 16.1% of suite time',
    say: "Vitest's own related command caught all two hundred and thirty-seven, at sixteen point one percent. So the graph ran about a fifth of that time, and missed one fault.",
    act: async (S) => {
      await S('clear');
      await S('chart', 'Mean share of suite time per fault', `${FAULTS.length} faults that broke a test · lower is cheaper`);
      await S('bar', NAME.impact_d2, R(A.impact_d2.meanShare), 20, 'pass', '%');
      await S('bar', NAME.vitest_related, R(A.vitest_related.meanShare), 20, 'warn', '%');
    },
  },
  {
    cap: 'Asking for the tests of each changed function caught 146: 61.6%',
    say: 'The graph can also list the tests for each changed function. That caught only one hundred and forty-six. Sixty-one point six percent.',
    act: async (S) => { await S('bar', NAME.tests_for, R(A.tests_for.meanShare), 20, 'fail', '%'); await S('key', [[`caught: impact, depth 2 ${A.impact_d2.caught}`, 'pass'], [`vitest related ${A.vitest_related.caught}`, 'warn'], [`tests_for ${A.tests_for.caught}`, 'fail']]); },
  },
  {
    cap: 'In this video',
    say: 'In this video: the tool, how I measured, one fault scored from end to end, the results, where vitest related spends its time, the one miss, real commits, and what I would do.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>In this video</h1><ul><li><b>1</b>the tool and the setup</li><li><b>2</b>one fault, scored end to end</li><li><b>3</b>the results, and where the time goes</li><li><b>4</b>the one miss, and function-level selection</li><li><b>5</b>100 real commits</li><li><b>6</b>what I would do</li></ul>');
    },
  },

  {
    ch: 'The tool',
    cap: 'code-review-graph: a local map of files, functions, calls, imports, tests',
    say: 'First, the tool. Code review graph builds a local map of a codebase. Files, functions, calls, imports, and tests. AI tools ask it what a change touches.',
    act: async (S) => {
      await S('clear');
      await S('card', `<h1>code-review-graph ${env['code-review-graph']}</h1><h2>a local map of a codebase, built once</h2><div class="cols"><div class="col"><b>nodes</b><span>files, functions, classes, tests</span></div><div class="col"><b>edges</b><span>calls, imports, tests</span></div><div class="col"><b>asked by</b><span>AI tools: what does this change touch?</span></div></div>`);
    },
  },
  {
    cap: 'Test selection asks the same question: what does this change touch?',
    say: 'Test selection asks the same question. So I tested it as a test selector, against the import graph that Vitest already has.',
    act: (S) => S('append', '.card', '<p>test selection asks the same question · measured against the import graph Vitest already has</p>'),
  },
  {
    cap: 'impact --files <file> --depth N returns the impacted files',
    say: 'The first command is impact. Give it a changed file and a depth, and it returns the impacted files. The default depth is two.',
    act: async (S) => {
      await S('clear');
      await S('term', 'c', 'work/hono', 'blue', 'big');
      await S('code', 'c', `// harness/lib.mjs\n${CRG}`, 'o m');
      await S('type', 'c', `uvx --python 3.12 code-review-graph@${env['code-review-graph']} impact --files src/middleware/jwk/jwk.ts`);
      await S('code', 'c', `// defaults: --depth ${env.impactDefaults['--depth']} · --max-results ${env.impactDefaults['--max-results']}`, 'o m');
    },
  },
  {
    cap: 'impacted_files holds source and test files: keep the files in the suite',
    say: 'It prints JSON. The impacted files list holds source files and test files, so the harness keeps only the files that are in the suite.',
    act: async (S) => {
      await S('clear');
      await S('term', 'h', 'harness/select.mjs', 'blue', 'big');
      await S('code', 'h', SELECT_SHOWN);
      await S('mark', 'h', "crgJson(['impact'");
      await S('mark', 'h', 'r.impacted_files.map(rel)');
    },
  },
  {
    cap: 'tests_for: for each changed function, the tests the graph links to it',
    say: 'The second command works per function. Detect changes names the changed functions, and a tests for query returns the tests for each one.',
    act: async (S) => {
      await S('clear');
      await S('term', 'm', 'harness/mutate.mjs · after the full suite run', 'blue', 'big');
      await S('code', 'm', MUTATE_SHOWN);
      await S('mark', 'm', "'detect-changes'");
      await S('mark', 'm', "'tests_for'");
    },
  },
  {
    cap: 'vitest related <file>: the test files that reach it through imports',
    say: 'The baseline is vitest related. It follows the module imports, and runs every test file that reaches the changed file.',
    act: async (S) => {
      await S('clear');
      await S('term', 'v', 'work/hono', 'warn', 'big');
      await S('type', 'v', 'node node_modules/vitest/vitest.mjs related src/middleware/jwk/jwk.ts --run --project main');
    },
  },

  {
    ch: 'The setup',
    cap: 'honojs/hono at a8ae5b1d: 123 test files, 5,110 tests, about 5.2 s',
    say: 'The target is hono, the web framework. Its suite has one hundred and twenty-three test files, and five thousand one hundred and ten tests. It runs in about five seconds.',
    act: async (S) => {
      await S('clear');
      await S('card', `<h1>honojs/hono at ${sum.target.sha.slice(0, 8)}</h1><h2>the Vitest project main · test files under src/</h2><div class="cols"><div class="col"><b>${SUITE.length}</b><span>test files</span></div><div class="col"><b>${baseline.runs[0].tests.toLocaleString('en-US')}</b><span>tests</span></div><div class="col"><b>${p1(sum.target.suiteWallMs / 1000)} s</b><span>wall-clock, median of ${baseline.runs.length} runs</span></div></div>`);
    },
  },
  {
    cap: `code-review-graph ${env['code-review-graph']} · Vitest ${env.vitest} · Node ${env.node.slice(1)} · macOS, ${env.arch}`,
    say: 'Code review graph version two point four, with the graph built once at that commit. Vitest version five, on Node twenty-four, on a Mac.',
    act: async (S) => {
      await S('clear');
      await S('term', 'e', 'results/env.json', 'blue', 'big');
      await S('code', 'e', read('results/env.json').trim());
      await S('mark', 'e', '"code-review-graph"');
      await S('mark', 'e', '"vitest"');
    },
  },
  {
    cap: '1,373 operator sites in 155 files: 300 drawn, fixed seed, at most 6 a file',
    say: 'For the faults, a script found one thousand three hundred and seventy-three operator sites, in one hundred and fifty-five source files. It drew three hundred, with a fixed seed, and at most six from each file.',
    act: async (S) => {
      await S('clear');
      await S('card', `<h1>300 seeded faults</h1><div class="cols"><div class="col"><b>${MUT.sites.toLocaleString('en-US')}</b><span>operator sites</span></div><div class="col"><b>${MUT.filesScanned}</b><span>source files</span></div><div class="col"><b>${MUT.mutants.length}</b><span>drawn with a fixed seed, at most 6 per file</span></div></div>`);
    },
  },
  {
    cap: 'Each fault swaps one operator: === and !==, && and ||, true and false',
    say: 'Each fault swaps one operator. Equals for not equals, and for or, true for false, and a few more.',
    act: async (S) => {
      await S('clear');
      await S('term', 'm', 'results/mutants.json · the first 12 of 300', 'blue', 'big');
      await S('code', 'm', MUTANT_LIST);
    },
  },
  {
    cap: 'Ground truth: apply the fault, run the whole suite, record failing files',
    say: 'Ground truth comes from the suite itself. Apply the fault, run the whole suite, and record the test files that fail.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>Ground truth</h1><ul id="gt"><li><b>1</b>apply the fault</li><li><b>2</b>run the whole suite<span>record the test files that fail</span></li></ul>');
    },
  },
  {
    cap: 'Then run those files again on their own: no file dropped out',
    say: 'Then run those files again, on their own, with the fault still applied, and keep only the files that fail again. In this run, none dropped out.',
    act: (S) => S('append', '#gt', '<li><b>3</b>run those files again on their own<span>keep the files that fail again · none dropped out</span></li>'),
  },
  {
    cap: '237 faults broke a test file · 61 broke none · 1 timed out · 1 did not parse',
    say: 'Two hundred and thirty-seven faults broke at least one test file. Sixty-one broke none. One timed out, and one did not parse. Those last two are excluded.',
    act: async (S) => {
      await S('clear');
      await S('chart', '300 faults', 'the full suite with each fault applied');
      await S('bar', 'broke a test file', FAULTS.length, 300, 'fail', 'faults');
      await S('bar', 'broke none', sum.mutants.survived, 300, 'muted', 'faults');
      await S('bar', 'timed out', sum.mutants.timedOut, 300, 'warn', 'excluded');
      await S('bar', 'did not parse', sum.mutants.invalid.length, 300, 'warn', 'excluded');
    },
  },
  {
    cap: 'The 237 are in 73 source files · the median fault broke 1 test file',
    say: 'The two hundred and thirty-seven are spread over seventy-three source files. The median fault broke one test file.',
    act: (S) => S('key', [[`${FAULTS.length} faults in ${sum.mutants.filesWithKilled} source files · median ${sum.mutants.medianFailingFiles} failing test file`, 'fail']]),
  },
  {
    cap: 'Each selector gets the changed file and returns test files',
    say: 'Each selector gets the changed file, and returns a list of test files. There are six, and the full suite.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'The selectors', 'input: the changed file · output: test files');
      await S('append', '.chart', table(['selector', 'what it picks'], [
        ['impact, depth 1, 2, 3', 'test files in impact --files &lt;file&gt; --depth N'],
        ['tests_for', 'tests_for of each function detect-changes names'],
        ['vitest related', 'the test files vitest related &lt;file&gt; runs'],
        ['same name', '&lt;file&gt;.test.ts or .test.tsx, if it exists'],
        ['full suite', `all ${SUITE.length} test files`],
      ], ['s-impact', 's-tf', 's-vr', 's-sn', 's-full']));
    },
  },
  {
    cap: 'impact at depth 1, 2 and 3 · depth 2 is the default',
    say: 'Impact runs at depth one, two, and three. Depth two is the default.',
    act: (S) => S('on', '#s-impact'),
  },
  {
    cap: 'tests_for per changed function · vitest related · the same-name test file',
    say: 'Then the tests for query, vitest related, and the simplest one: the test file with the same name as the source file, if there is one.',
    act: async (S, page) => { await page.evaluate(() => document.querySelector('#s-impact')!.classList.remove('on')); await S('on', '#s-tf, #s-vr, #s-sn'); },
  },
  {
    cap: 'Caught: at least 1 failing file picked, so CI goes red',
    say: 'Scoring. A selector catches a fault when it picks at least one failing test file. Then CI goes red.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>Scoring, per fault</h1><ul id="sc"><li><b>1</b>caught: at least 1 failing test file picked<span>CI goes red</span></li></ul>');
    },
  },
  {
    cap: 'Picked all: every failing test file was in the selection',
    say: 'It picked all, when every failing test file was in the selection.',
    act: (S) => S('append', '#sc', '<li><b>2</b>picked all: every failing test file picked</li>'),
  },
  {
    cap: 'Share of suite time: picked files over all files, median of 3 clean runs',
    say: "And share of suite time. The time of the picked files, divided by the time of all files. Each file's time is its median over three clean runs.",
    act: (S) => S('append', '#sc', '<li><b>3</b>share of suite time: picked files\' time / all files\' time<span>each file: the median of 3 clean runs</span></li>'),
  },

  {
    ch: 'One fault, scored',
    cap: 'Fault #31: src/utils/jwt/jws.ts line 90, true becomes false',
    say: 'Here is one fault, scored from end to end. Fault thirty-one is in the JWT signing code. On line ninety, true becomes false.',
    act: async (S) => {
      at(F31.m);
      await S('clear');
      await S('term', 'j', `${F31.m.file} · fault #31`, 'fail', 'big');
      await S('code', 'j', lines(F31.m.file, 88, 93));
      await S('mark', 'j', "importKey('pkcs8'");
      await S('label', 'j', 'true → false', 'fail');
    },
  },
  {
    cap: 'The full suite: 12 tests fail, all in 1 file, src/utils/jwt/jwt.test.ts',
    say: 'With the fault in, the full suite fails twelve tests, all in one file: the JWT test file.',
    act: async (S) => { await faultGrid(S, 'Fault #31 · 123 test files', 'one cell per test file · red: fails with the fault', F31); },
  },
  {
    cap: 'impact, depth 2 picks 3 test files: the failing one is among them',
    say: 'Impact at depth two picks three test files. The failing file is one of them. So the fault is caught, and every failing file is picked.',
    act: async (S) => { await S('paint', cells(pick('impact_d2', F31)), 'P'); await gridKey(S, `picked by impact, depth 2: ${pick('impact_d2', F31).length} files`); },
  },
  {
    cap: "Those 3 files are 9.7% of the suite's test time",
    say: "Those three files take nine point seven percent of the suite's test time.",
    act: (S) => S('key', [[`caught · picked all · ${p1(share(pick('impact_d2', F31)))}% of suite time`, 'pass']]),
  },
  {
    cap: 'vitest related picks the same 3 files · tests_for picks none',
    say: 'Vitest related picks the same three files. The tests for query names the changed function, import public key, and finds no tests for it. That is a miss.',
    act: (S) => S('key', [['vitest related: the same 3 files', 'warn'], ['tests_for importPublicKey: 0 files · missed', 'fail']]),
  },
  {
    cap: 'Each of the 237 faults is scored this way, for every selector',
    say: 'Every one of the two hundred and thirty-seven faults is scored this way, for every selector. Then the scores are added up.',
  },

  {
    ch: 'The results',
    cap: 'Faults caught, of 237',
    say: 'Here are the results. First, the number of faults each one caught.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Faults caught', `of ${FAULTS.length} that broke a test file · at least 1 failing file picked`);
      await bars(S, TIME_ARMS, (a) => A[a].caught, FAULTS.length, 'faults');
    },
  },
  {
    cap: 'vitest related: 237 · impact, depth 2 and 3: 236 · tests_for: 146',
    say: 'Vitest related caught all of them. Impact at depth two and three caught all but one. Depth one caught two hundred and nineteen, and the same name file one hundred and ninety. Tests for caught one hundred and forty-six.',
  },
  {
    cap: 'Mean share of suite time per fault',
    say: 'Now the cost. The mean share of suite time, per fault.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Mean share of suite time per fault', 'the picked files\' time / all files\' time');
      await bars(S, TIME_ARMS, (a) => R(A[a].meanShare), 20, '%');
    },
  },
  {
    cap: 'impact, depth 2: 3.4% · vitest related: 16.1% · about a fifth',
    say: 'Impact at depth two ran three point four percent. Vitest related ran sixteen point one. That is about a fifth.',
    act: (S) => S('key', [[`impact, depth 2 / vitest related = ${p1(A.impact_d2.meanShare)} / ${p1(A.vitest_related.meanShare)}`, 'pass']]),
  },
  {
    cap: 'The cost: impact, depth 2 picked all failing files for 198 of 237',
    say: 'The cost is completeness. Impact at depth two picked every failing file for one hundred and ninety-eight faults. Vitest related did it for all two hundred and thirty-seven.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Picked all failing files', `of ${FAULTS.length} faults`);
      await bars(S, TIME_ARMS, (a) => A[a].complete, FAULTS.length, 'faults');
    },
  },
  {
    cap: '38 caught faults had at least 1 more failing file that was not picked',
    say: 'For thirty-eight caught faults, at least one other failing file was not picked. CI goes red, but the developer sees only part of the damage until the full suite runs.',
    act: (S) => S('key', [[`impact, depth 2: caught ${A.impact_d2.caught} · picked all ${A.impact_d2.complete} · partial ${partialD2.length}`, 'warn']]),
  },
  {
    cap: 'Every selector: caught, picked all, median files, mean share of suite time',
    say: 'Here is the whole table. The full suite is the last row: all one hundred and twenty-three files, every time.',
    act: async (S) => {
      await S('clear');
      await S('chart', `${FAULTS.length} faults that broke a test file`, 'results/summary.json');
      await S('append', '.chart', table(['selector', 'caught', 'picked all', 'median files', 'mean time'], ROWS, ARMS.map((a) => 't-' + a)));
      await S('on', '#t-impact_d2, #t-vitest_related');
    },
  },

  {
    ch: 'Where the time goes',
    cap: 'vitest related: a median of 1.8% of suite time per fault, a mean of 16.1%',
    say: 'Why does vitest related cost so much more? For the median fault, it ran only one point eight percent of the suite. The mean is sixteen point one. A few faults pull it up.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Share of suite time per fault', `${FAULTS.length} faults · median and mean`);
      await S('group', 'median');
      await S('bar', NAME.impact_d2, R(A.impact_d2.medianShare), 20, 'pass', '%');
      await S('bar', NAME.vitest_related, R(A.vitest_related.medianShare), 20, 'warn', '%');
      await S('group', 'mean');
      await S('bar', NAME.impact_d2, R(A.impact_d2.meanShare), 20, 'pass', '%');
      await S('bar', NAME.vitest_related, R(A.vitest_related.meanShare), 20, 'warn', '%');
    },
  },
  {
    cap: "For 59 faults, vitest related picked over half of the suite's test time",
    say: "For fifty-nine faults, it picked more than half of the suite's test time. Between fifty-eight and ninety-two test files each.",
    act: async (S) => {
      await S('clear');
      await S('chart', 'vitest related: share of suite time per fault', `${FAULTS.length} faults`);
      await S('bar', 'under 10%', vrBuckets[0], FAULTS.length, 'muted', 'faults');
      await S('bar', '10% to 50%', vrBuckets[1], FAULTS.length, 'muted', 'faults');
      await S('bar', 'over 50%', vrBuckets[2], FAULTS.length, 'warn', 'faults');
    },
  },
  {
    cap: 'Those 59 faults make up 13.9 of its 16.1 points',
    say: 'Those fifty-nine faults make up nearly fourteen of the sixteen points.',
    act: (S) => S('key', [[`the ${HEAVY.length} faults: ${p1(heavyPoints)} points · the other ${FAULTS.length - HEAVY.length}: ${p1(A.vitest_related.meanShare - heavyPoints)} points`, 'warn']]),
  },
  {
    cap: 'They are in core files: the routers, context.ts, utils/url.ts, compose.ts',
    say: 'They are in the core files that most tests reach. The routers, the context, the URL helpers, and compose.',
    act: async (S) => {
      await S('clear');
      await S('term', 'h', `the ${HEAVY.length} faults where vitest related picked over half the suite time`, 'warn', 'big');
      await S('code', 'h', heavyFiles.slice(0, 10).map(([f, n]) => `${f.padEnd(48)}${n} ${n === 1 ? 'fault' : 'faults'}`).join('\n') + `\n... ${heavyFiles.length - 10} more files`);
    },
  },
  {
    cap: 'src/utils/url.ts: vitest related picks 82 test files · impact picks 14',
    say: 'Take the URL helpers. For a change there, vitest related picks eighty-two test files. Impact at depth two picks fourteen.',
    act: async (S) => {
      await S('mark', 'h', URL_TS);
      await S('label', 'h', `${URL_TS}: vitest related ${selections[URL_TS].vitest_related.tests.length} files · impact ${selections[URL_TS].impact_d2.tests.length}`, 'warn');
    },
  },
  {
    cap: 'Fault #32: covers() in reg-exp-router/router.ts, === becomes !==',
    say: 'Or fault thirty-two, in the regular expression router. One equals check becomes not equals.',
    act: async (S) => {
      at(F32.m);
      await S('clear');
      await S('term', 'r', `${ROUTER} · fault #32`, 'fail', 'big');
      await S('code', 'r', lines(ROUTER, 22, 33));
      await S('mark', 'r', 'wildcard[last] === ONLY_WILDCARD_REG_EXP_STR');
      await S('label', 'r', '=== → !==', 'fail');
    },
  },
  {
    cap: '13 test files fail · impact picks 2, both failing: 0.4% of suite time',
    say: "Thirteen test files fail. Impact picks two of them. That catches it, at zero point four percent of the suite's test time.",
    act: async (S) => { await faultGrid(S, 'Fault #32 · impact, depth 2', `${F32.failing.length} failing files · ${pick('impact_d2', F32).length} picked · ${p1(share(pick('impact_d2', F32)))}% of suite time`, F32, 'impact_d2'); await gridKey(S, 'picked'); },
  },
  {
    cap: 'vitest related picks 59 files, all 13 failing ones: 53.7% of suite time',
    say: 'Vitest related picks fifty-nine files, including all thirteen failing ones. That costs fifty-three point seven percent.',
    act: async (S) => { await faultGrid(S, 'Fault #32 · vitest related', `${F32.failing.length} failing files · ${pick('vitest_related', F32).length} picked · ${p1(share(pick('vitest_related', F32)))}% of suite time`, F32, 'vitest_related'); await gridKey(S, 'picked'); },
  },
  {
    cap: 'On those 59 faults, impact caught 59, picked all for 29, at 6.3%',
    say: 'On those fifty-nine faults, impact at depth two caught every one. It picked all the failing files for twenty-nine of them, at six point three percent of suite time.',
    act: async (S) => {
      await S('clear');
      await S('chart', `The ${HEAVY.length} faults where vitest related picked over half`, 'impact, depth 2 against vitest related');
      await S('stack', NAME.impact_d2, [[heavyD2.complete, 'pass'], [heavyD2.caught - heavyD2.complete, 'warn']], HEAVY.length, `· ${p1(heavyD2.meanShare)}%`);
      await S('stack', NAME.vitest_related, [[HEAVY.length, 'pass']], HEAVY.length, `· ${p1(mean(A.vitest_related.rows.filter((x) => HEAVY.includes(x.id)).map((x) => x.share)))}%`);
      await S('key', [['picked all', 'pass'], ['caught, partial', 'warn']]);
    },
  },
  {
    cap: '30 of its 38 partial picks are among those 59 faults',
    say: "And thirty of its thirty-eight partial picks are among them. The cost of vitest related, and the gaps of impact, are in the same core files.",
    act: (S) => S('key', [[`partial picks among the ${HEAVY.length}: ${partialD2.filter((id) => HEAVY.includes(id)).length} of ${partialD2.length}`, 'warn']]),
  },

  {
    ch: 'Depth',
    cap: 'Depth 1 caught 219: for 18 faults it picked no test file at all',
    say: 'Depth matters. With depth set to one, impact caught two hundred and nineteen. Every fault it missed got no test file at all. Eighteen of them.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'impact by depth', `${FAULTS.length} faults`);
      await Promise.all(([1, 2, 3] as const).map((d) => {
        const a = A[`impact_d${d}`];
        return S('stack', `depth ${d}${d === 2 ? ' (default)' : ''}`, [[a.complete, 'pass'], [a.caught - a.complete, 'warn']], FAULTS.length, `· ${p1(a.meanShare)}%`);
      }));
      await S('key', [['picked all', 'pass'], ['caught, partial', 'warn']]);
    },
  },
  {
    cap: 'Depth 3: picked all for 5 more faults, at 5.0% of suite time against 3.4%',
    say: 'Depth three picked all the failing files for five more faults than depth two. That cost five percent of the suite time, against three point four.',
  },
  {
    cap: 'Depth 2 and depth 3 missed the same fault',
    say: 'And it missed the same fault as depth two.',
  },

  {
    ch: 'The one miss',
    cap: 'Fault #218: cloudflare-workers/websocket.ts line 15, !== becomes ===',
    say: 'Now the one fault impact missed, at every depth. It is fault two hundred and eighteen, in the Cloudflare Workers web socket adapter.',
    act: async (S) => {
      at(F218.m);
      await S('clear');
      await S('term', 'w', `${WS} · fault #218`, 'fail', 'big');
      await S('code', 'w', lines(WS, 8, 17));
      await S('mark', 'w', "upgradeHeader !== 'websocket'");
      await S('label', 'w', '!== → ===', 'fail');
    },
  },
  {
    cap: '6 tests fail in websocket.test.ts · impact returned 0 impacted files',
    say: 'Six tests fail, in its test file. For this source file, impact returned zero impacted files, at every depth.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Fault #218 · impact: impacted files', `${F218.failedTests} failed tests in ${WS_TEST}`);
      for (const d of [1, 2, 3]) await S('bar', `depth ${d}`, selections[WS][`impact_d${d}`].impactedFiles, 3, 'fail', 'files');
    },
  },
  {
    cap: "The test imports upgradeWebSocket through the folder's index.ts",
    say: "The test imports the helper through the folder's index file. A re-export.",
    act: async (S) => {
      await S('clear');
      await S('term', 't', WS_TEST, 'blue', 'big');
      await S('code', 't', lines(WS_TEST, 1, 3));
      await S('mark', 't', "from '.'");
      await S('term', 'i', 'src/adapter/cloudflare-workers/index.ts', 'blue', 'big');
      await S('code', 'i', from(hono('src/adapter/cloudflare-workers/index.ts'), "export { serveStatic } from './serve-static-module'\nexport { upgradeWebSocket } from './websocket'\nexport { getConnInfo } from './conninfo'"));
      await S('mark', 'i', "upgradeWebSocket } from './websocket'");
    },
  },
  {
    cap: 'The changed code is an arrow function passed to defineWebSocketHelper',
    say: 'And the changed code is an arrow function, passed to another helper. One case does not show which of the two broke the link.',
    act: async (S) => {
      await S('clear');
      await S('term', 'w', `${WS} · fault #218`, 'fail', 'big');
      await S('code', 'w', lines(WS, 8, 17));
      await S('mark', 'w', 'defineWebSocketHelper(async (c, events) => {');
      await S('label', 'w', `detect-changes: ${F218.changedFunctions.length} changed functions`, 'fail');
    },
  },
  {
    cap: 'vitest related and the same-name file both picked websocket.test.ts',
    say: 'Vitest related follows the module imports, so it picked the test. So did the same name file.',
    act: async (S) => { await faultGrid(S, 'Fault #218 · vitest related', `${pick('vitest_related', F218).length} picked · caught`, F218, 'vitest_related'); await gridKey(S, 'picked'); },
  },
  {
    cap: 'Fault #295: middleware/jwk/jwk.ts line 70, || becomes &&: 0 failed tests',
    say: 'One fault broke a test file without failing a test. Fault two hundred and ninety-five, in the JWK middleware.',
    act: async (S) => {
      at(F295.m);
      await S('clear');
      await S('term', 'k', `${F295.m.file} · fault #295`, 'fail', 'big');
      await S('code', 'k', lines(F295.m.file, 68, 72));
      await S('mark', 'k', 'options.keys || options.jwks_uri');
      await S('label', 'k', '|| → &&', 'fail');
    },
  },
  {
    cap: 'jwk() throws while Vitest collects the tests: the file fails, 0 tests run',
    say: 'The JWK function now throws its requires options error, while Vitest collects the tests. So the test file fails, with no failed test. CI goes red, so it counts.',
    act: async (S) => {
      await S('term', 'c', `results/confirm.json · #295 · failedTests: ${F295.failedTests}`, 'fail');
      await S('code', 'c', Object.entries(F295.fileErrors).map(([f, e]) => `${f}\n  ${e}`).join('\n'));
    },
  },

  {
    ch: 'Function-level selection',
    cap: 'tests_for: caught 146 of 237 faults (61.6%)',
    say: 'Function level selection would be the bigger saving, so I tried it. Detect changes names the changed functions, and tests for returns their tests. It caught one hundred and forty-six faults.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'tests_for', `${FAULTS.length} faults`);
      await S('bar', 'caught', A.tests_for.caught, FAULTS.length, 'fail', 'faults');
    },
  },
  {
    cap: '58 faults got no tests at all · for 4, no changed function was found',
    say: 'For fifty-eight faults it returned no tests at all. For four of those, the detect changes command named no function.',
    act: async (S) => {
      await S('bar', 'returned no tests', A.tests_for.empty, FAULTS.length, 'muted', 'faults');
      await S('bar', '… and no changed function', FAULTS.filter((r) => !r.testsFor.length && !r.changedFunctions.length).length, FAULTS.length, 'muted', 'faults');
    },
  },
  {
    cap: 'An empty selection lets CI pass',
    say: 'An empty selection is the dangerous case. A selector that returns nothing lets CI pass.',
    act: (S) => S('key', [['an empty selection runs no test: CI goes green', 'fail']]),
  },
  {
    cap: 'Fault #3: _getQueryParam in utils/url.ts · 4 files, 23 tests fail',
    say: 'Fault three is one of them. It is in the query parameter parser. Four test files fail, with twenty-three failed tests. The tests for query returned nothing.',
    act: async (S) => { await faultGrid(S, 'Fault #3 · tests_for _getQueryParam', `${F3.failing.length} failing files · ${F3.failedTests} failed tests · 0 picked`, F3); await gridKey(S, 'picked: none'); },
  },
  {
    cap: 'impact, depth 2 picked all 4 failing files for that fault',
    say: 'Impact at depth two picked all four failing files.',
    act: async (S) => { await faultGrid(S, 'Fault #3 · impact, depth 2', `${F3.failing.length} failing files · ${pick('impact_d2', F3).length} picked`, F3, 'impact_d2'); await gridKey(S, 'picked'); },
  },
  {
    cap: 'tests_for is not a selector on its own',
    say: 'Too many changed functions had no linked test. On its own, the tests for query is not a selector.',
  },

  {
    ch: 'Real commits',
    cap: 'The last 100 hono commits that changed src/: 88 changed test files too',
    say: 'Seeded faults are small. So I also replayed the last hundred hono commits that changed source code. Eighty-eight of them also changed test files.',
    act: async (S) => {
      await S('clear');
      await S('card', `<h1>${commits.length} real commits</h1><h2>the last ${commits.length} hono commits that changed source under src/</h2><h2 class="m">${withTests.length} of them also changed test files</h2>`);
    },
  },
  {
    cap: 'No fault to catch: did it pick the test files the author changed?',
    say: "There is no fault to catch here. The check is whether each selector picks the test files the author changed.",
    act: (S) => S('append', '.card', "<p>the check: did the selector pick every test file the author changed?</p>"),
  },
  {
    cap: 'impact, depth 2: 83 of 88 · vitest related: 84 of 88',
    say: 'Impact at depth two picked them in eighty-three of eighty-eight commits. Vitest related, in eighty-four.',
    act: async (S) => {
      await S('clear');
      await S('chart', "Picked all the author's test files", `of ${withTests.length} commits`);
      for (const a of ['impact_d1', 'impact_d2', 'impact_d3', 'vitest_related', 'same_name'] as Arm[]) await S('bar', NAME[a], authorPicked(a), withTests.length, COLOR[a], 'commits');
    },
  },
  {
    cap: 'At 11.1% of suite time against 19.1%: about three fifths',
    say: 'At eleven point one percent of suite time, against nineteen point one. On real commits, the gap narrows to about three fifths.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Mean share of suite time per commit', `${commits.length} commits`);
      for (const a of ['impact_d1', 'impact_d2', 'impact_d3', 'vitest_related', 'same_name'] as Arm[]) await S('bar', NAME[a], R(commitShare(a)), 25, COLOR[a], '%');
    },
  },
  {
    cap: 'Depth 1: 73 of 88, 3 empty · same name: 60 of 88, 13 empty',
    say: 'Depth one picked them in seventy-three, and returned nothing for three commits. The same name file managed sixty, with thirteen empty.',
    act: (S) => S('key', [[`empty selections: depth 1 ${commitEmpty('impact_d1')} · depth 2 ${commitEmpty('impact_d2')} · vitest related ${commitEmpty('vitest_related')} · same name ${commitEmpty('same_name')}`, 'muted']]),
  },
  {
    cap: 'A proxy: 859e2c2 only re-sorted imports: 4 code files, 45 test files',
    say: "The author's test files are only a proxy. One commit only moved import sorting to a new tool. It changed four source files, and forty-five test files.",
    act: async (S) => {
      await S('clear');
      await S('term', 'c', `results/commits.json · ${commit859.sha.slice(0, 7)}`, 'blue', 'big');
      await S('code', 'c', `${commit859.subject}\n\ncode files:  ${commit859.code.length}\ntest files:  ${commit859.authorTests.length}`);
      await S('mark', 'c', 'sort imports');
    },
  },

  {
    ch: 'The node limit',
    cap: 'impact has a default limit of 500 impacted nodes',
    say: 'Impact has a default limit of five hundred impacted nodes.',
    act: async (S) => {
      await S('clear');
      await S('term', 'e', 'results/env.json', 'blue', 'big');
      await S('code', 'e', read('results/env.json').trim());
      await S('mark', 'e', '"--max-results"');
    },
  },
  {
    cap: 'Over the limit: context.ts at every depth, 3 more files at depth 3',
    say: 'Among the seventy-three changed files, the count went over it for the context file at every depth. At depth three, also for three more: request, mime, and URL.',
    act: async (S) => {
      await S('clear');
      await S('term', 'n', 'results/summary.json · impact.nodeLimitHit', 'warn', 'big');
      await S('code', 'n', JSON.stringify(sum.impact.nodeLimitHit, null, 2));
      await S('mark', 'n', CTX);
    },
  },
  {
    cap: 'context.ts: depth 1, 2 and 3 all picked the same 13 test files',
    say: 'For the context file, depths one, two, and three all picked the same thirteen test files. I did not measure whether the limit cost any test files.',
    act: async (S) => {
      await S('clear');
      await S('chart', `${CTX}: test files picked`, 'over the node limit at every depth');
      for (const d of [1, 2, 3]) await S('bar', `impact, depth ${d}`, selections[CTX][`impact_d${d}`].tests.length, SUITE.length, 'warn', 'files');
    },
  },

  {
    ch: 'Limits',
    cap: 'One repository, one machine, seeded faults',
    say: 'The limits. One repository, one machine, and seeded faults. Operator swaps are smaller than most real changes.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>The limits</h1><ul id="lim"><li><b>1</b>One repository, one machine, seeded faults<span>operator swaps are smaller than most real changes</span></li></ul>');
    },
  },
  {
    cap: 'The graph was built once, at the measured commit',
    say: "The graph was built once, at the measured commit. The commit replay uses that graph, and today's import graph, not the state at each old commit.",
    act: (S) => S('append', '#lim', "<li><b>2</b>The graph was built once, at the measured commit<span>the commit replay uses that graph and today's import graph</span></li>"),
  },
  {
    cap: "hono's suite runs in about 5 s: the share of suite time carries over",
    say: "And hono's suite runs in about five seconds, so the time saved here is seconds. The share of suite time is the number that carries over to a larger suite.",
    act: (S) => S('append', '#lim', '<li><b>3</b>The suite runs in about 5 s<span>the time saved is seconds · the share of suite time carries over</span></li>'),
  },

  {
    ch: 'Run it',
    cap: 'Needs Node 24.21.0, uv and git',
    say: 'To run it yourself, you need Node twenty-four, uv, and git.',
    act: async (S) => {
      await S('clear');
      await S('term', 'r', 'README.md · run it', 'blue', 'big');
      await S('code', 'r', 'Needs Node 24.21.0 (`nvm use`), `uv`, and git.\n\n' + RUN_SHOWN);
    },
  },
  {
    cap: 'setup clones hono at a8ae5b1d, installs it, and builds the graph',
    say: 'Setup clones hono, checks out the measured commit, installs it, and builds the graph.',
    act: (S) => S('mark', 'r', 'npm run setup'),
  },
  {
    cap: 'mutate runs the whole suite once per fault: about 45 minutes',
    say: 'Mutate runs the whole suite once for each fault. That takes about forty-five minutes.',
    act: (S) => S('mark', 'r', 'npm run mutate'),
  },
  {
    cap: 'summary writes results/summary.json and prints the tables',
    say: 'Summary reads every result file, writes the summary, and prints the tables. Every raw result is in the repository.',
    act: async (S) => {
      await S('clear');
      await S('term', 's', 'results/summary.json · mutantArms', 'blue', 'big');
      await S('code', 's', D2_SHOWN);
      await S('mark', 's', '"caughtPct"');
      await S('mark', 's', '"meanTimeSharePct"');
    },
  },

  {
    ch: 'What to do',
    cap: '1. If your runner already has an import graph, start there',
    say: 'What would I do with this? First. If your test runner already has an import graph, start there. Vitest related picked every failing file, and needs no extra tool.',
    act: async (S) => {
      await S('clear');
      await S('card', `<h1>What I would do</h1><ul id="todo"><li><b>1</b>Start with your runner's import graph<span>vitest related: picked all ${A.vitest_related.complete} of ${FAULTS.length}</span></li></ul>`);
    },
  },
  {
    cap: '2. impact at its default depth when that runs too much, full suite on merge',
    say: 'Second. Use impact at its default depth when the import graph runs too much, and run the full suite on merge. That is where ninety-nine point six percent, at three point four, is worth the thirty-eight partial picks.',
    act: (S) => S('append', '#todo', `<li><b>2</b>impact at default depth, full suite on merge<span>${pct(A.impact_d2.caught)}% caught at ${p1(A.impact_d2.meanShare)}% · ${partialD2.length} partial picks</span></li>`),
  },
  {
    cap: '3. Empty selection, or over the node limit: run everything',
    say: 'Third. Treat an empty selection, or a node count over the limit, as run everything.',
    act: (S) => S('append', '#todo', `<li><b>3</b>Empty, or over the node limit: run everything<span>tests_for returned nothing for ${A.tests_for.empty} faults</span></li>`),
  },
  {
    cap: '4. Do not use the function-level query to select tests',
    say: 'Four. Do not use the function level query to select tests. It caught sixty-one point six percent.',
    act: (S) => S('append', '#todo', `<li><b>4</b>Do not select tests by function<span>tests_for caught ${pct(A.tests_for.caught)}%</span></li>`),
  },
  {
    cap: "The graph's file-level answer works as a selector, its function-level not",
    say: "The graph's file level answer is good enough to select tests. Its function level answer is not. Either way, run the full suite on merge.",
  },
];

for (const s of steps) if (s.cap.length > 76) throw new Error('caption wraps: ' + s.cap);

const END_SECONDS = 10;
const END_SAY = 'The harness, every result, and the write-up are linked in the description.';

test('record the walkthrough', async ({ browser }, testInfo) => {
  const says = [...steps.map((s) => s.say), END_SAY];
  let lines = says.map(speech);
  if (NARRATE_CHECK && !FAST) {
    const tsv = path.join(outDir, 'narration-pre.tsv');
    fs.writeFileSync(tsv, says.map((s) => `0\t${s}`).join('\n') + '\n');
    execFileSync(NARRATE_CHECK, [tsv, path.join(outDir, 'audio'), VOICE, SPEED, '4'], { stdio: 'inherit' });
    lines = says.map(speech);
  }
  if (PLAN) {
    // The same timing as an HQ recording whose actions fit inside the narration
    let t = 0.4;
    const tsv: string[] = [];
    const chapters: string[] = [];
    for (const [i, step] of steps.entries()) {
      if (step.ch) chapters.push(`${chapters.length ? `${Math.floor(t / 60)}:${String(Math.floor(t) % 60).padStart(2, '0')}` : '0:00'} ${step.ch}`);
      tsv.push(`${t.toFixed(2)}\t${step.say}`);
      t += lines[i].seconds + (steps[i + 1]?.ch || i === steps.length - 1 ? GAP_OUT : GAP_IN) / 1000;
    }
    tsv.push(`${t.toFixed(2)}\t${END_SAY}`);
    fs.writeFileSync(path.join(outDir, 'narration.tsv'), tsv.join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'chapters.txt'), chapters.join('\n') + '\n');
    console.log(`predicted ${(t + END_SECONDS).toFixed(1)} s\n${chapters.join('\n')}`);
    return;
  }
  const viewport = testInfo.project.use.viewport!;
  const context = await browser.newContext(HQ
    ? { viewport, deviceScaleFactor: 2 }
    : { viewport, recordVideo: { dir: testInfo.outputDir, size: viewport } });
  const page: Page = await context.newPage();
  const frames: { t: number; file: string }[] = [];
  const frameDir = path.join(outDir, 'hq-frames');
  let cdp: Awaited<ReturnType<typeof context.newCDPSession>> | undefined;
  if (HQ && !FAST) {
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
    cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = path.join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ t: metadata.timestamp! * 1000, file });
      cdp!.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
  }
  await page.goto('file://' + path.join(here, 'stage.html'));
  await page.evaluate(() => document.fonts.ready);
  const S: Stage = (fn, ...args) => page.evaluate(([f, a]) => (window as any).S[f as string](...(a as unknown[])), [fn, args] as const);

  if (cdp) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  const start = Date.now();
  const at = () => (Date.now() - start) / 1000;
  const cues: { at: number; wav: string; say: string }[] = [];
  const chapters: string[] = [];
  let chapter = 0;
  if (FAST) {
    fs.rmSync(path.join(outDir, 'frames'), { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
  }
  await page.waitForTimeout(400);
  for (const [i, step] of steps.entries()) {
    if (step.ch) {
      await S('chapter', ++chapter, step.ch);
      const t = Math.floor(at());
      chapters.push(`${chapter === 1 ? '0:00' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`} ${step.ch}`);
    }
    const began = Date.now();
    cues.push({ at: at(), wav: lines[i].wav, say: step.say });
    await S('caption', step.cap);
    await S('fresh');
    await step.act?.(S, page);
    const gap = HQ ? (steps[i + 1]?.ch || i === steps.length - 1 ? GAP_OUT : GAP_IN) : GAP;
    await page.waitForTimeout(Math.max(0, lines[i].seconds * 1000 + gap - (Date.now() - began)));
    if (FAST) {
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(outDir, 'frames', `${String(i + 1).padStart(2, '0')}.png`) });
    }
  }
  await S('end', [
    ['write-up', 'garyparker.dev/blog/\ncode-graph-test-impact-analysis'],
    ['source', 'github.com/qa-gary-parker/\npoc-test-impact-graph'],
  ], `impact, depth 2: ${pct(A.impact_d2.caught)}% caught at ${p1(A.impact_d2.meanShare)}% of suite time · vitest related: 100% at ${p1(A.vitest_related.meanShare)}%`);
  cues.push({ at: at(), wav: lines[steps.length].wav, say: END_SAY });
  if (FAST) {
    await page.screenshot({ path: path.join(outDir, 'frames', 'end.png') });
    await context.close();
    return;
  }
  await page.waitForTimeout(END_SECONDS * 1000);
  const length = at();

  const webm = path.join(outDir, 'walkthrough.webm');
  let videoIn: string[];
  if (HQ) {
    await cdp!.send('Page.stopScreencast');
    await context.close();
    // Frames arrive only when the page changes: hold each until the next one.
    const list = frames.map((f, i) => {
      const end = i + 1 < frames.length ? frames[i + 1].t : start + length * 1000;
      return `file '${f.file}'\nduration ${(Math.max(1, end - Math.max(f.t, start)) / 1000).toFixed(4)}`;
    });
    const concat = path.join(frameDir, 'list.txt');
    fs.writeFileSync(concat, list.join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`);
    const firstAt = Math.max(0, (frames[0].t - start) / 1000);
    videoIn = ['-f', 'concat', '-safe', '0', '-i', concat];
    if (firstAt > 0.01) videoIn = ['-itsoffset', firstAt.toFixed(3), ...videoIn];
  } else {
    const video = page.video()!;
    await context.close();
    await video.saveAs(webm);
    videoIn = ['-i', webm];
  }
  fs.writeFileSync(path.join(outDir, 'chapters.txt'), chapters.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'narration.tsv'), cues.map((c) => `${c.at.toFixed(2)}\t${c.say}`).join('\n') + '\n');

  const inputs = cues.flatMap((c) => ['-i', c.wav]);
  const delays = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`).join(';');
  const mix = cues.map((_, i) => `[a${i}]`).join('');
  // HQ voice chain: rumble cut, less boxiness, presence, de-ess, gentle compression, faint room tone, -14 LUFS (YouTube)
  const voice = HQ
    ? 'highpass=f=80,equalizer=f=300:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1.2:g=2.5,deesser=i=0.4,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2'
    : 'anull';
  const room = HQ ? `;anoisesrc=colour=brown:amplitude=0.0035:sample_rate=48000:duration=${length.toFixed(3)},lowpass=f=3000[room]` : '';
  const voiceMix = `${mix}amix=inputs=${cues.length}:normalize=0:duration=longest,apad,${voice}`;
  const audio = HQ
    ? `${delays}${room};${voiceMix}[v];[v][room]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1:LRA=11[aout]`
    : `${delays};${voiceMix},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
  const video = HQ ? ['-vf', 'fps=30', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-tune', 'stillimage'] : ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium'];
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...videoIn, ...inputs,
    '-filter_complex', audio,
    '-map', '0:v', '-map', '[aout]', ...video, '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', length.toFixed(3), '-movflags', '+faststart', path.join(outDir, 'walkthrough.mp4')]);
  if (HQ) {
    const LIMIT = 'alimiter=limit=0.5:attack=3:release=60:level=false';
    // Second loudness pass: measure the mix, then apply linear gain to exactly -14 LUFS / -1 dBTP.
    const mp4 = path.join(outDir, 'walkthrough.mp4');
    const tmp = path.join(outDir, 'walkthrough.pre-loudnorm.mp4');
    fs.renameSync(mp4, tmp);
    const err = spawnSync('ffmpeg', ['-hide_banner', '-i', tmp, '-af', `${LIMIT},loudnorm=I=-14:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const m = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp, '-c:v', 'copy', '-af',
      `${LIMIT},loudnorm=I=-14:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', mp4]);
    fs.rmSync(tmp);
  }
  console.log(`walkthrough.mp4 ${length.toFixed(1)} s, ${cues.length} lines, ${lines.reduce((a, l) => a + l.seconds, 0).toFixed(1)} s of speech`);
  console.log(chapters.join('\n'));
});

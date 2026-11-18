// Replays recent hono commits that changed source under src/: how many tests each selector picks,
// and whether it picks the test files the author changed in the same commit.
// Selections use the graph and import graph at the measured commit, not at each old commit.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HONO, RESULTS, readJson, sh, writeJson } from './lib.mjs';
import { selectFor } from './select.mjs';

const COMMITS = Number(process.env.COMMITS ?? 100);
const suite = new Set(Object.keys(readJson(join(RESULTS, 'baseline.json')).files));
const isCode = (f) => f.startsWith('src/') && /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith('.d.ts');

const shas = sh(['git', 'log', '--no-merges', '--format=%H', '-n', '400', 'HEAD', '--', 'src']).stdout.split('\n').filter(Boolean);
const out = [];
for (const sha of shas) {
  if (out.length === COMMITS) break;
  const changed = sh(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', sha]).stdout.split('\n').filter(Boolean);
  const code = changed.filter((f) => isCode(f) && existsSync(join(HONO, f)));
  if (!code.length) continue;
  const authorTests = changed.filter((f) => suite.has(f));
  const arms = {};
  for (const f of code) {
    const sel = selectFor(f);
    for (const [arm, v] of Object.entries(sel)) for (const t of v.tests ?? []) (arms[arm] ??= new Set()).add(t);
    for (const arm of Object.keys(sel)) arms[arm] ??= new Set();
  }
  const subject = sh(['git', 'log', '-1', '--format=%s', sha]).stdout.trim();
  out.push({ sha, subject, code, authorTests, arms: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, [...v].sort()])) });
  console.log(`${out.length}/${COMMITS} ${sha.slice(0, 8)} ${code.length} code files, ${authorTests.length} test files`);
}
writeJson(join(RESULTS, 'commits.json'), out);

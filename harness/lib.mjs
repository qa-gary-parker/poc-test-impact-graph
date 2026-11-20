import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HONO = join(ROOT, 'work/hono');
export const RESULTS = join(ROOT, 'results');
export const HONO_SHA = 'a8ae5b1d6e8502ce61cd9e7b853d8107e377fc7b';
export const CRG = ['uvx', '--python', '3.12', 'code-review-graph@2.4.0'];
mkdirSync(RESULTS, { recursive: true });

// Every step runs on the Node in .nvmrc and writes it into its results file.
export const NODE = process.version;
const PINNED = `v${readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()}`;
if (NODE !== PINNED) throw new Error(`run with Node ${PINNED} (.nvmrc), not ${NODE}`);

export function sh(argv, { cwd = HONO, timeout = 600_000, allowFail = true } = {}) {
  const t0 = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  const out = { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - t0, timedOut: r.error?.code === 'ETIMEDOUT' };
  if (!allowFail && out.code !== 0) throw new Error(`${argv.join(' ')} exited ${out.code}\n${out.stderr.slice(-2000)}`);
  return out;
}

export const rel = (p) => relative(HONO, resolve(HONO, p));
export const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
export const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
export const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const appendJsonl = (p, v) => appendFileSync(p, `${JSON.stringify(v)}\n`);

// The measured suite: vitest project "main", test files under src/ (build/ tests need a compiled package)
export function runSuite(extraArgs = [], { cmd = 'run', timeout = 180_000 } = {}) {
  const outFile = join(ROOT, 'work/vitest.json');
  rmSync(outFile, { force: true });
  const r = sh([process.execPath, join(HONO, 'node_modules/vitest/vitest.mjs'), cmd, '--project', 'main', '--coverage.enabled=false', '--reporter=json', `--outputFile=${outFile}`, '--passWithNoTests', ...extraArgs], { timeout });
  if (r.timedOut) {
    // The timeout kills only the vitest parent; its fork workers would keep running and load later runs.
    sh(['/usr/bin/pkill', '-f', `${HONO}/node_modules/.*vitest/dist/workers`]);
    return { timedOut: true, ms: r.ms };
  }
  const j = readJson(outFile);
  if (!j) throw new Error(`vitest wrote no report (exit ${r.code}): ${r.stderr.slice(-1500)}`);
  const files = j.testResults.map((f) => ({
    file: rel(f.name),
    status: f.status,
    ms: (f.endTime ?? 0) - (f.startTime ?? 0),
    failedTests: f.assertionResults.filter((a) => a.status === 'failed').length,
    error: f.message ? f.message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 200) : null,
  }));
  return { timedOut: false, ms: r.ms, numTotalTests: j.numTotalTests, numFailedTests: j.numFailedTests, files };
}

export const isSuiteFile = (f) => f.startsWith('src/');

export function crgJson(args) {
  const r = sh([...CRG, ...args]);
  if (r.code !== 0) throw new Error(`crg ${args.join(' ')} exited ${r.code}: ${r.stderr.slice(-1000)}`);
  return JSON.parse(r.stdout);
}

// Applies one mutant, runs fn, and always restores the file.
export function withMutant(m, fn) {
  const path = join(HONO, m.file);
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  const line = lines[m.line - 1];
  if (line.slice(m.col, m.col + m.from.length) !== m.from) throw new Error(`mutant ${m.id}: site moved`);
  lines[m.line - 1] = line.slice(0, m.col) + m.to + line.slice(m.col + m.from.length);
  writeFileSync(path, lines.join('\n'));
  try {
    return fn();
  } finally {
    writeFileSync(path, original);
  }
}

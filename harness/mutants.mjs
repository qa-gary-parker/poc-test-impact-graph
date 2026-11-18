// Lists every mutation site in hono's src/ and draws a seeded sample.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HONO, RESULTS, sh, writeJson } from './lib.mjs';

const SAMPLE = Number(process.env.SAMPLE ?? 300);
const PER_FILE_CAP = 6;
const SEED = 6;

const OPERATORS = [
  ['===', '!=='],
  ['!==', '==='],
  [' && ', ' || '],
  [' || ', ' && '],
  [' <= ', ' < '],
  [' >= ', ' > '],
  [' < ', ' <= '],
  [' > ', ' >= '],
  [' + 1', ' - 1'],
  [' - 1', ' + 1'],
  ['true', 'false'],
  ['false', 'true'],
];
const WORD = new Set(['true', 'false']);

const files = sh(['git', 'ls-files', 'src'])
  .stdout.split('\n')
  .filter((f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(f) && !f.endsWith('.d.ts'))
  .filter((f) => !f.endsWith('/types.ts') && !f.includes('/types/') && !f.startsWith('src/jsx/') && !f.startsWith('src/test-utils/'));

const sites = [];
for (const file of files) {
  let inBlock = false;
  readFileSync(join(HONO, file), 'utf8').split('\n').forEach((text, i) => {
    const t = text.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      return;
    }
    if (t.startsWith('/*')) {
      inBlock = !t.includes('*/');
      return;
    }
    if (!t || t.startsWith('//') || t.startsWith('*') || /^(import|export type|export interface|type|interface|declare)\b/.test(t)) return;
    const code = text.replace(/\/\/.*$/, '');
    for (const [from, to] of OPERATORS) {
      let at = code.indexOf(from);
      while (at !== -1) {
        const wordOk = !WORD.has(from) || (!/\w/.test(code[at - 1] ?? '') && !/\w/.test(code[at + from.length] ?? ''));
        const plusOk = !from.endsWith(' 1') || !/\d/.test(code[at + from.length] ?? '');
        if (wordOk && plusOk) sites.push({ file, line: i + 1, col: at, from, to });
        at = code.indexOf(from, at + 1);
      }
    }
  });
}

let s = SEED;
const rand = () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffled = [...sites];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const perFile = {};
const sample = [];
for (const site of shuffled) {
  if ((perFile[site.file] ?? 0) >= PER_FILE_CAP) continue;
  perFile[site.file] = (perFile[site.file] ?? 0) + 1;
  sample.push({ id: sample.length + 1, ...site });
  if (sample.length === SAMPLE) break;
}

writeJson(join(RESULTS, 'mutants.json'), { seed: SEED, perFileCap: PER_FILE_CAP, filesScanned: files.length, sites: sites.length, mutants: sample });
console.log(`${files.length} files, ${sites.length} sites, ${sample.length} sampled from ${Object.keys(perFile).length} files`);

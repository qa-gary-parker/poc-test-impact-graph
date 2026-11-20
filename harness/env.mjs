// Records the versions and tool defaults the runs use, read from the installed tools rather than typed in.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRG, HONO, RESULTS, sh, writeJson } from './lib.mjs';

const out = (argv) => sh(argv, { allowFail: false }).stdout.trim();

// `impact --help` does not print defaults, so read them from the installed argparse definitions.
const cliPy = out(['uvx', '--python', '3.12', '--from', CRG.at(-1), 'python', '-c', "import code_review_graph, pathlib; print(pathlib.Path(code_review_graph.__file__).parent / 'cli.py')"]);
const cli = readFileSync(cliPy, 'utf8');
const impactDefault = (flag) => {
  const m = cli.match(new RegExp(`impact_cmd\\.add_argument\\(\\s*"${flag}"[^)]*?default=("?)([\\w-]+)\\1`));
  if (!m) throw new Error(`no default for impact ${flag} in ${cliPy}`);
  return m[1] ? m[2] : Number(m[2]);
};

writeJson(join(RESULTS, 'env.json'), {
  capturedAt: new Date().toISOString(),
  node: process.version,
  vitest: JSON.parse(readFileSync(join(HONO, 'node_modules/vitest/package.json'), 'utf8')).version,
  'code-review-graph': out([...CRG, '--version']).split(' ').pop(),
  impactDefaults: Object.fromEntries(['--depth', '--max-results', '--detail-level', '--max-files'].map((f) => [f, impactDefault(f)])),
  macOS: `${out(['sw_vers', '-productVersion'])} (${out(['sw_vers', '-buildVersion'])})`,
  arch: process.arch,
});

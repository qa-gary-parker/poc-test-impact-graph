# poc-test-impact-graph

**The question:** can a code-intelligence graph (`code-review-graph`) tell you which tests to run for a diff, and how does it compare with the import graph Vitest already has?

**The answer:** mostly yes, but only the file-level blast radius works. On hono, 237 seeded faults made at least one test file fail: 236 failed at least one test, and 1 failed because its test file threw an error before any test ran. `code-review-graph impact` with default settings picked tests that caught 236 of the 237 (99.6%), and it ran a mean 3.6% of the suite's test time. It picked every failing test file for only 198 (83.5%). `vitest related` caught all 237 and picked every failing file each time, but ran 18.3% of the suite's test time. The graph's function-level answer (`tests_for` on the changed function) caught only 146 (61.6%). For 58 faults it returned no tests.

> Exploratory PoC, throwaway by default.

## Method

- Target: [honojs/hono](https://github.com/honojs/hono) at `a8ae5b1d`. The suite is Vitest project `main`, test files under `src/`: 123 files and 5,110 tests, about 4.8 s wall-clock. `build/` tests need a compiled package and are not part of it.
- Tools: `code-review-graph` 2.4.0 (graph built once at the measured commit), Vitest 5.0.1, Node 24.21.0, macOS 15.7.4.
- Faults: `harness/mutants.mjs` finds 1,373 operator sites in 155 source files under `src/` (not `src/jsx/`, not type files). It swaps one operator per fault: `===`/`!==`, `&&`/`||`, `<`/`<=`, `>`/`>=`, `+ 1`/`- 1`, `true`/`false`. It draws 300 with seed 6, at most 6 per file.
- Ground truth: `harness/mutate.mjs` applies each fault and runs the whole suite. The test files that fail are the files a selector must pick. `harness/confirm.mjs` runs those files again on their own with the fault applied, keeps only the files that fail again, and records how each one failed: failed tests, or an error at file level (parse or collection) with no failed test. A failing test file is a file with a failed test or a file-level error; both make CI red. A fault whose failing files show only a parse error did not compile. It is excluded, like a timeout.
- Selectors, given the changed file:

| arm | what it picks |
|---|---|
| impact_d1, impact_d2, impact_d3 | test files in `code-review-graph impact --files <file> --depth N` (2 is the default) |
| tests_for | test files from `code-review-graph query tests_for` for each function `detect-changes` reports as changed |
| vitest_related | test files `vitest related <file>` runs |
| same_name | `<file>.test.ts`, if it exists |
| full | every test file |

- "Caught": the selection contains at least one failing test file, so CI goes red. "All failing files selected": the selection contains every failing test file.
- Share of suite time: the sum of the selected files' durations (median of 3 clean runs, `results/baseline.json`) divided by the sum for all files.
- Commit replay: `harness/commits.mjs` takes the last 100 hono commits that changed source under `src/` and runs each selector on the changed files. 88 of them also changed test files. It checks whether each selector picks those test files.

## Results

Every run is in `results/`. `npm run summary` writes `results/summary.json` and prints the tables.

300 faults: 237 broke at least one test file, 61 broke none, 1 timed out and 1 did not parse (both excluded). 236 of the 237 failed at least one test. The 237 are in 73 source files. The median fault broke 1 test file.

| arm | caught | all failing files selected | median test files | mean share of suite time |
|---|---|---|---|---|
| impact_d1 | 219 (92.4%) | 162 (68.4%) | 1 | 1.1% |
| **impact_d2 (default)** | **236 (99.6%)** | 198 (83.5%) | 2 | **3.6%** |
| impact_d3 | 236 (99.6%) | 203 (85.7%) | 2 | 5.1% |
| tests_for | 146 (61.6%) | 104 (43.9%) | 1 | 1.1% |
| vitest_related | **237 (100%)** | **237 (100%)** | 3 | 18.3% |
| same_name | 190 (80.2%) | 117 (49.4%) | 1 | 0.6% |
| full | 237 (100%) | 237 (100%) | 123 | 100% |

Commit replay (100 commits; 88 changed test files too):

| arm | median test files | mean share of suite time | empty selections | picked all the author's test files |
|---|---|---|---|---|
| impact_d1 | 2 | 2.6% | 3 | 73 of 88 |
| impact_d2 | 4 | 9.9% | 0 | 83 of 88 |
| impact_d3 | 4 | 10.5% | 0 | 83 of 88 |
| vitest_related | 6 | 19.3% | 1 | 84 of 88 |
| same_name | 1 | 0.7% | 13 | 60 of 88 |

- The one fault impact missed at depth 2 and 3 (#218) is in `src/adapter/cloudflare-workers/websocket.ts`. Its test imports `upgradeWebSocket` through the folder's `index.ts`, and the code is an arrow function passed to `defineWebSocketHelper`. The graph returned 0 impacted files.
- Fault #295 (`src/middleware/jwk/jwk.ts`, `||` to `&&`) failed no test. `jwk()` now throws its "requires options" error when a test file calls it while Vitest collects the tests, so `src/middleware/jwk/index.test.ts` fails with 0 tests run. It counts as caught: CI goes red.
- Fault #74 (`src/context.ts:583`) swapped the `>` that closes a type parameter list, not an operator. The file no longer parses, and 74 test files failed to load with 0 failed tests. It is excluded.
- `tests_for` returned no tests for 58 of the 237 faults. For 4 of them `detect-changes` reported no changed function.
- At depth 3, `impact` hit its default node limit for 4 files (`src/context.ts` at every depth).

## Limits

- One repository, one machine, seeded faults. Operator swaps are smaller than most real changes.
- The graph was built once at the measured commit. The commit replay uses that graph and today's import graph, not the state at each old commit.
- In the commit replay, "the author's test files" is a proxy for the tests that matter. One commit only re-sorted imports across many files.
- `src/middleware/logger/index.test.ts` failed under full-suite load in 2 fault runs and passed on its own. The confirmation pass removed it from those 2 faults (one of them then broke no test).
- hono's suite runs in about 5 s, so the time saved here is seconds. The share of suite time is the number that carries over.

## Run it

Needs Node 24, `uv`, and git.

```bash
npm run setup      # clone hono at a8ae5b1d into work/, install, build the graph
npm run mutants    # results/mutants.json
npm run baseline   # results/baseline.json
npm run mutate     # results/mutant-runs.jsonl (about 45 min)
npm run confirm    # results/confirm.json
npm run select     # results/selections.json
npm run commits    # results/commits.json
npm run summary    # results/summary.json
```

## License

MIT

# Unit-suite performance tooling

Measurement for the unit suite, and the dashboard that tracks the isolation migration. Everything
here writes to `.test-perf/`; nothing is hand-maintained.

⚠️ `.test-perf/` is gitignored **by this change** — the entry is added in the same commit as these
scripts. Until it lands, run output sits untracked in `git status`, one broad `git add` away from
being committed by someone else. That has happened in this repo before, so if you are cherry-picking
these scripts rather than merging, take the `.gitignore` line with them.

## Rebuild the dashboard

```bash
node scripts/test-perf/graph.mjs        # static import graph + vi.mock inventory
node scripts/test-perf/dashboard.mjs    # -> .test-perf/dashboard.html
```

`graph.mjs` writes `inventory.json` and `closures.json`. **`graphModules` is what a worker really
loads**: lazy `import()` is not followed *except from a test file itself*, a `vi.mock` factory
without `importOriginal` truncates the subtree behind it (the mocked module is still counted — vitest
transforms it), and an `import type` / `import { type X }` statement is erased before the graph sees
it. `graphModulesRaw` keeps the naive count for the bundler question.

The two differ by **75x** on a page-render test, in the direction that puts the cheapest files at the
top of a ranking: four `src/tests/pages/apps/**` files counted 1,655–1,670 naively and load **13–26**,
while their *measured* worker time ranks 202–572 of 1,065. Do not rank test cost by the raw count.

⚠️ The test-file exception is load-bearing, not a detail. `dynamic(() => import(...))` in a page never
runs; `await import('~/pages/...')` in a test body is the point of the test. Treating them the same
makes those four files either the top of the ranking or 1 module each, and both readings are wrong.

Validated by diffing the model against a transform-hook trace as **sets**: 3 of 5 files exact with
empty diffs both ways, 16 modules of symmetric error across 691 traced (2.32%). Counts alone agreed
often enough to hide two of the four causes above — **a count agreeing is not the rule agreeing.**
Ground truth exists for 5 files of 1,065; that is a sample, not a proof.

Open `.test-perf/dashboard.html` in a browser. It shows where the run's time goes, how far the
migration has got, which modules sit in the most test closures, and every run recorded so far.

## Record a run

Any vitest invocation gains per-file timings by adding the reporter:

```bash
pnpm exec vitest run --project unit --reporter=default \
  --reporter=./scripts/test-perf/reporter.mjs
```

Output lands at `.test-perf/runs/<TESTPERF_LABEL>.perf.json`, with per-file `collect` (import),
`setup`, `duration` and pass/fail counts.

🔴 `TESTPERF_LABEL` does **not** reach a run started through the dev-server test queue — the daemon
spawns with its own environment, so a queued run always writes `run.perf.json`. Rename it afterwards,
or run vitest directly when the label matters.

## The yardstick

A full run costs minutes and has to be serialised against every other agent on the box, which makes
it useless as an edit→measure loop. Use the fixed 90-file subset instead:

```bash
node scripts/test-perf/bench.mjs --label before --workers 4
node scripts/test-perf/bench.mjs --label after  --workers 4
node scripts/test-perf/bench.mjs --label after-noiso --workers 4 --no-isolate
```

The subset is stratified across closure sizes (`--make-subset` regenerates it from the inventory), so
slimming one fat chain shows up rather than being averaged away.

🔴 **The subset's job is to be STABLE, not to make measurements comparable across time.** It fixes
*what* is measured; it does nothing about *when*. Two yardstick runs hours apart are not comparable —
see the noise floor below — so always pair a before and an after inside one window, and never quote a
yardstick number against one from an earlier session.

⚠️ And a null from the yardstick is not evidence of no effect: it is 90 of 1,065 files, so a change
concentrated outside the sample reads as flat. Two changes measured flat here were later shown by a
full paired run to be real.

⚠️ Wall clock on a busy box swings up to ~68%. Always pair a measurement with a control run taken in
the same window; never compare against a number from a different session. With several agents sharing
the box the noise floor was measured at **±30%** — the same configuration gave 53.3s and 76.6s in one
session. Below ~20%, prefer phase numbers (collect/setup/test worker-seconds) over wall clock, or do
not claim the win.

🔴 **The yardstick systematically understates `isolate: false`, and cannot be used to judge it.**
That flag amortises the registry build across the files a worker runs, so its win scales with
files-per-worker. 90 files at 16 workers is ~6 files each — a registry built once instead of six
times — and measured 1.65x. The full 1065-file suite at 8 workers is ~133 files each, and measured
**16x** on the same phase. Judge isolation on a full run or not at all.

🔴 **No `--no-isolate` number is quotable without a per-file collected count beside it.** Its damage
is not confined to failing assertions: files silently collect ZERO tests, and how many is
width-dependent — 9 of 90 at forks/4 workers, 14 of 90 at threads/4, 0 of 90 at threads/16, same
input. A summary line cannot show you this. `reporter.mjs` writes per-file passed/failed/skipped for
exactly this comparison.

## Config sweep

```bash
node scripts/test-perf/sweep.mjs --workers 4,16 --repeat 2
```

Runs the subset across pool × isolation × worker count, back to back, and keeps the faster of each
repeat — contention only ever makes a run slower. Results in `.test-perf/sweep.json`.

## Module tracer

The static graph cannot tell you what actually ran: a `vi.mock` factory stops the real module and its
whole subtree from executing. The tracer brackets every first-party module body, so it counts real
executions and separates a module's own cost from its imports'.

```bash
pnpm exec vitest run --project unit-trace --config scripts/test-perf/trace-config.mts \
  --max-workers=1 path/to/one.test.ts
node scripts/test-perf/trace-report.mjs
```

🔴 The project is `unit-trace`, not `unit`, and the name is load-bearing: Vitest keys the
dep-optimizer cache on `sha1(projectName)` while Vite's config hash includes the plugin names, so a
traced project called `unit` points at the normal suite's `deps_ssr` and makes Vite delete and
re-bundle it. Measured while building this: a 53-file selection containing a traced child run went
**16 files red** with `Cannot find module '…/deps_ssr/prom-client.js'`.

The price of that separation, so it is not a surprise: the traced project mints a **second full dep
bundle** — measured at **87 MB / 44 files** under `sha1('unit-trace')`, the same file count as the
normal suite's, built from one trivial fixture (cold 2.5s, warm 1.3s). It lands in the
`node_modules/.vite` cache the `main` branch saves. The alternative is corrupting concurrent runs,
so this is the right trade, but it is not free.

⚠️ `bench.mjs` cannot drive this config: it hardcodes `--project unit`. Invoke vitest directly, as
above.

⚠️ Under `isolate: true`, `globalThis` is reset between test files. That used to mean a multi-file
traced run kept only the last file's counters; it no longer does, because each worker now flushes
its own snapshot and `trace-report.mjs` sums them. The remaining reason to trace one file at a time
is attribution — the merged report cannot tell you which file loaded what.

The trace directory's snapshots are **cleared at the start of every traced run** (in
`trace-config.mts`), because the report sums every `*.json` it finds and stale snapshots from a
previous run would silently double the numbers. Only files matching this tool's own
`<pid>-<worker>.json` shape are removed, so pointing `TESTPERF_TRACE_DIR` at a directory holding
other JSON does not destroy it. Two traced runs must not overlap; give one its own
`TESTPERF_TRACE_DIR` if they must. Both the tracer and the report honour that variable.

⚠️ The clear happens once per process, at config load — so under `vitest --watch` only the first
re-run clears, and later ones accumulate. Tracing is a `vitest run` workflow; if you watch, expect
inflated totals.

🔴 The counters flush from `afterAll`, and that is not a detail: `forks` KILLS its workers instead
of letting them exit, so the `process.on('exit')` flush this started life with never ran. Under
Vitest 4.1.11 the workflow above wrote **nothing at all** — no `.test-perf/trace/`, and
`trace-report.mjs` answering *"run a traced suite first"*, which reads as operator error rather
than as a dead instrument. The 15s interval did not cover it either, because "trace one file at a
time" is a 5–10s run. `scripts/test-perf/__tests__/trace-flush.test.ts` spawns a real traced run
and fails if no snapshot lands, so it cannot go quiet again; `TESTPERF_TRACE_DIR` redirects the
snapshots so that test cannot clobber a trace you are reading.

**This is the tracer the graph model is validated against** (see "Rebuild the dashboard" above), so
while it was dead that validation was unreproducible — treat any trace-vs-graph claim older than
this note as unverified.

## Per-worker union

```bash
node scripts/test-perf/graph.mjs     # also writes .test-perf/closures.json
node scripts/test-perf/order.mjs
```

Under `isolate: false` a worker keeps one module registry for its whole lifetime, so its cost is the
**union** of what its files import, not the sum. `order.mjs` reports the mean per-worker union for
alphabetical order against a graph-affinity order, at several worker counts.

**Measured 2026-08-15: affinity ordering is not worth having.** At 31 workers the mean per-worker
union was 1084 modules alphabetically and 1139 by affinity — slightly *worse*. Alphabetical order
already groups by directory, and directory already correlates with the import graph. The sequencer
that applied the affinity order was deleted; `order.mjs` is kept because the union report is the
number that bounds what `isolate: false` can deliver.

🔴 **Both union figures above predate the honest counts and must be re-run before either is quoted
as a level.** The conclusion is a ratio between two orderings under one counting convention, so it
survives; 1084 and 1139 do not.

Two other things measured and found not to help, recorded so nobody spends the hour again:

- **`NODE_COMPILE_CACHE`** — three yardstick runs under `--no-isolate`: cold 26.8s, warm 51.4s, warm
  again 33.9s. No signal, and the cache directory did fill (5.3 MB), so it was active. vite-node does
  not evaluate through the loader that cache covers.
- **`vmThreads`** — looked 1.16x faster than `forks` with a clean 90-file run, twice. It is a race:
  on the five files that execute `sharp`, worker counts 2 and 3 crash or pass on identical input.
  CI's 4 vCPU resolves to ~3 workers, the width measured at 1-in-3 SIGSEGV.

## What the numbers meant on 2026-08-15

🔴 **There is no single "main baseline", and quoting one as a constant is a mistake.** The same tree at
`3863adcbb0` was measured three times on 2026-08-15 and the results are **36% apart on import**:

| run | wall | import | tests | files / tests / failed |
|---|---|---|---|---|
| clean box, no reporter attached | 206.6s | 4565.5s | 541.1s | 1065 / 16784 / 16 |
| `baseline-full-uncapped.perf.json` (shipped artifact) | 243.1s | 5476.3s | 563.7s | 1065 / 16784 / 16 |
| paired control for the integration run | 204.4s | 4491s | 541s | 1065 / 16784 / 16 |

Identical file, test and failure counts in all three — the tree did not change, the box did. That
spread is the same size as several of the effects measured against it, which is exactly why **every
main-relative figure must name the run it was measured against, by label**, and why a change is only
credible when its control was taken in the same window.

Derived shares move with the row you pick: import is **81%** of worker time on the first row and
**84.3%** on the second.

- **Import is not module evaluation**: traced at 1 worker, the module bodies of two of the heaviest
  files totalled ~0.4s against a 25.4s import phase. **Cost is linear in module count, not module
  weight.** ⚠️ The mechanism behind the remaining ~98% is *inferred, not instrumented*: an early
  reading blamed vite-node's per-module IPC, and the pool sweep refutes it — `threads` beat
  `vmThreads` while paying a cold fetch, which shipping module source cannot explain. The
  better-supported reading is compile-and-evaluate into a fresh registry, once per file. V8 compile
  time was never measured.
- The closure distribution is **bimodal**: p50 66 modules, p75 1088. 411 files carry 96% of all
  module executions.
- 16 failures across 6 files is the known-good Windows baseline (`path.relative()` backslashes
  against `/` literals); green on Linux CI.

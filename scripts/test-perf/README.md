# Unit-suite performance tooling

Measurement for the unit suite, and the dashboard that tracks the isolation migration. Everything
here writes to `.test-perf/` (gitignored); nothing is hand-maintained.

## Rebuild the dashboard

```bash
node scripts/test-perf/graph.mjs        # static import graph + vi.mock inventory
node scripts/test-perf/dashboard.mjs    # -> .test-perf/dashboard.html
```

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

⚠️ Wall clock on a busy box swings up to ~68%. Always pair a measurement with a control run taken in
the same window; never compare against a number from a different session.

🔴 **A null on the yardstick is not a null.** Two batches of the import-slimming work measured flat on
the subset and were real in the full run — the 90 files simply did not contain the files those batches
moved. Worse, a subset can remove the condition that produces the cost rather than merely diluting it:
the component project's ~21s startup charge scales with how many files the run _matches_, because
`@vitest/browser` seeds `optimizeDeps.entries` from every matched file, so a 13-file probe measured no
charge at all. The subset's job is to be stable, not to be representative of every change. Read a flat
result as "not visible here", and do not re-tune the subset to fit the change you are working on.

The stronger measurement, when you have a full-run pair, is a **within-run control**: split both runs'
per-file `collect` by whether a file was touched by the change, and report the control group's own
drift alongside the result.

🔴 **The control's membership must be computed from the CHANGE, never from the measurement.** "Files
whose static import closure this diff alters" is a control. "Files whose time did not move" is a
restatement of the result — and that second one licensed a headline in this repo for several hours
before a review caught it.

The corollary is the unintuitive part: **a control that moves AGAINST the result is stronger evidence
than a flat one.** −22.0% on 412 changed files against **+13.7%** on 653 unchanged is harder to explain
away than −22% against 0%, because a shared tailwind cannot be the explanation. Do not read a drifting
control as "the headline is mostly box load" — read which way it drifted.

This replaces "distrust anything under 20%" rather than sitting beside it. A threshold tells you when
to doubt a number; a control tells you whether it is real. And no variance rule catches the failure
above, where the subset measured flat because it was unrepresentative rather than noisy.

## Rank an import edge by what cutting it removes

```bash
node scripts/test-perf/cuts.mjs cuts <test-file> --top 20   # dominator tree, one test file
node scripts/test-perf/cuts.mjs union --top 30              # rooted at ALL 1065 unit tests
node scripts/test-perf/cuts.mjs union-real --top 30         # same, honouring vi.mock
node scripts/test-perf/cuts.mjs path all 'components/Modals/BuyBuzzModal'
```

A node's dominator-subtree size is exactly how many modules disappear when that node stops being
reachable, so `union` answers "what leaves the suite-wide module set if I cut this edge" in one pass.
A node with a single predecessor and a large subtree is one import holding up a wing of the graph.

**A raw static graph over-counts runtime cost by ~2.5x suite-wide (4.3x on the one file traced), for
three separate reasons:**

1. `import()` is lazy. `const X = dynamic(() => import('...'))` at module scope never runs. Following
   that edge is right for a bundler question — a lazily-fetched chunk is still a compiled chunk, which
   is why `no-server-infra-in-app-graph` follows them deliberately — and wrong for a registry
   question. `cuts.mjs` skips them; `COUNT_DYNAMIC=1` restores the bundler view.
2. A `vi.mock` factory without `importOriginal` stops the real module and its whole subtree.
3. Externals are invisible to any vite-side instrument, including the tracer — see below.

⚠️ **An in-body `await import()` in a test bills the graph to `duration`, not `collect`.** Anything
ranking by `collect` — this tool, the reporter, the dashboard — cannot see it. Hoisting such an import
does not make the file faster (measured: the cost moves from `duration` to `collect` and the total
does not change); it only makes it visible.

## What the node_modules side costs

```bash
node scripts/test-perf/externals.mjs --top 200 > .test-perf/externals.txt
node scripts/test-perf/externals.mjs --why '@tabler/icons-react'
node scripts/test-perf/ext-cost.mjs .test-perf/externals.txt
```

Vite never transforms an externalised dep, so nothing on the vite side can see one — and they are a
large share of the import phase. `externals.mjs` gives the fan-in (mock-aware, lazy-aware) with
`--why` for the shortest path from a test file to a package; `ext-cost.mjs` times each package the way
the suite pays it, with one `import()` in a brand-new node process, and ranks by count × cost.

Under `isolate: true` every test file really is a fresh process — four probe files at
`--max-workers=1` give four distinct pids — so a package is re-imported cold per file. Read
`ext-cost.mjs`'s header before quoting any of its numbers; the rows do not add up to a saving, and the
column collapses under `isolate: false`.

## Tests that reach a real infra client

```bash
node scripts/test-perf/unmocked-db.mjs --client db      # or redis, clickhouse
```

A test whose graph reaches `~/server/db/client` unmocked does not fail — it opens a real connection
and waits out the timeout, which reads as a slow test rather than a missing mock. On its own the list
is nearly useless (110 files reach it, because importing costs nothing until something queries); cross
it with per-file `duration` from a recorded run and it drops to three.

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
pnpm exec vitest run --project unit --config scripts/test-perf/trace-config.mts \
  --max-workers=1 path/to/one.test.ts
node scripts/test-perf/trace-report.mjs
```

⚠️ Under `isolate: true`, `globalThis` is reset between test files, so a multi-file traced run keeps
only the last file's counters. Trace one file at a time, or trace with `--no-isolate`.

## What the numbers meant on 2026-08-15

Full run, uncapped (31 workers), quiet 32-core box, at `3863adcbb0`:

```
wall 206.6s | transform 150.7s | setup 354.4s | import 4565.5s | tests 541.1s
1065 files, 16784 tests, 16 failed across 6 files
```

- **Import is 81% of worker time**, and it is not module evaluation: traced at 1 worker, the module
  bodies of two of the heaviest files totalled ~0.4s against a 25.4s import phase. **Cost is linear in
  module count, not module weight** — so rank by how many modules an edge removes, and do not spend
  time making an individual module cheaper to evaluate.

  The mechanism behind the rest was first attributed to vite-node's per-module IPC fetch under the
  `forks` pool. That is **retracted**: a pool sweep put `threads` (which pays a cold fetch per file,
  like forks) ahead of `vmThreads` (which keeps a warm fetch cache across files), and shipping module
  source cannot explain that ordering. The better-supported reading is re-compiling and re-evaluating
  each module into a fresh registry per test file, which forks, threads and vmThreads all share and
  only `isolate: false` avoids. Labelled INFERRED FROM POOL ORDERING; V8 compile time was never
  instrumented. The practical guidance is unchanged either way.

  This accounting is also first-party only. A large share of the import phase is external packages,
  which the tracer cannot see at all — see "What the node_modules side costs" above.

- The closure distribution is **bimodal**: p50 66 modules, p75 1088. 411 files carry 96% of all
  module executions.
- 16 failures across 6 files is the known-good Windows baseline (`path.relative()` backslashes
  against `/` literals); green on Linux CI.

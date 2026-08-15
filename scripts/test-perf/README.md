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
  bodies of two of the heaviest files totalled ~0.4s against a 25.4s import phase. The rest is
  vite-node's per-module fetch — a child-process IPC round trip per module per file under the `forks`
  pool, roughly 20ms each. **Cost is linear in module count, not module weight.**
- The closure distribution is **bimodal**: p50 66 modules, p75 1088. 411 files carry 96% of all
  module executions.
- 16 failures across 6 files is the known-good Windows baseline (`path.relative()` backslashes
  against `/` literals); green on Linux CI.

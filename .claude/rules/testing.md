---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/__tests__/**"
  - "vitest.config.mts"
  - "scripts/test-cache/**"
---

# Testing

Root CLAUDE.md → Tests has the core rules (suite selection, `--project 'unit*'`, covering suites, `vitest related`, `test:lint-rules`, `src/pages`). This file has the rest.

## Running and reading suites

- **CI coverage differs per suite.** See the job comments in `.github/workflows/lint.yml`. `main` has no required status checks, so no suite blocks a merge, and a `continue-on-error` job doesn't even render red.
- **Example covering run:** `pnpm exec vitest run --project 'unit*' src/server/services/__tests__/strike.service.test.ts`
- **Why the final full run matters, and why not between edits:** a change in a widely imported service (`src/server/services/`) can surface failures anywhere; but the suite is ~41,600 tests serialised through the dev-server queue, so running it between edits blocks everyone else's runs.
- **A green full run can still hide a failure you caused.** Read the failing-file list, not the count. If tests fail, re-run those same files on `main` (in a separate worktree; don't `git stash` here) to see whether they already failed.

## Worker count

Vitest sizes its own pool (`cpus - 1` in run mode, `floor(cpus / 2)` in watch, browser pool `min(12, cpus - 1)`). Uncapped is the default: through the dev-server queue it measured ~1.8x faster than a flat cap of 8 (#3900, #3947).

```bash
VITEST_MAX_WORKERS=8 pnpm exec vitest run --project 'unit*'   # direct run (BOTH unit projects)
pnpm run test:unit:run --max-workers=8                        # through the dev-server queue
```

- **Use `--max-workers` for queued runs; the env var does not reach them.** With `CIVITAI_TEST_QUEUE` set, `test:unit:run` hands the run to the dev-server daemon, which spawns it with its own environment, so `VITEST_MAX_WORKERS` is silently ignored.
- **Either knob sets the count for every project, browser included, and is not clamped to 12.** `--max-workers=16` launches 16 Chromium instances.
- **Only `test:unit:run` is queued.** `test:component`, `test:packages:run`, `test:apps:run` and `test:lint-rules` call `vitest` directly and can overlap a queued unit run; cap one by hand on a shared box.
- **Measure both ends before changing pool settings.** More workers is not monotonically better (`--no-isolate` was far slower at 31 workers than at 8).
- **Under a CPU quota (container), `os.availableParallelism()` reports host cores.** Set `VITEST_MAX_WORKERS` explicitly in any pipeline defined outside this repo.

## Result cache

When the dev-server queue has the cache on (`cli.mjs test config --cache on`), a queued `test:unit:run` skips test files whose inputs are unchanged since they last passed (source, imports, files read, lockfile/configs). Results are shared between worktrees. Output looks like:

```
[test-cache] 1880 test files: 41 ran, 1839 skipped as unchanged since they last passed. 92 unchanged file(s) re-run to verify; false skips: 0.
```

- A random ~5% of unchanged files run anyway. If one fails, the cache mispredicted (a false skip) and trips itself off (`TRIPPED.json` in the cache dir) until a human looks.
- Environment variables are not part of the cache key, and neither are `package.json` `scripts` or `version`: a change to how a script invokes vitest (its flags) does not invalidate anything. A test that reads a `package.json` is still keyed on the whole file.
- The key definition (`scripts/test-cache/core.mjs`) is the dev-server daemon's copy, not the tree's, so a fix to it reaches every tree once the daemon's checkout pulls it; a change to `test-queue.mjs` itself needs a daemon restart. A tree older than `load-core.mjs` keys with its own copy until it rebases, and a tree's own edit to `core.mjs` is not what its queued runs key with unless the daemon's copy lacks one of its exports (its unit tests still import it directly).
- Never on in CI; a run that filters files (filename, directory, substring) is never trimmed. Code: `scripts/test-cache/`.

## Where handler tests go

Keep handler tests in a `__tests__/` directory outside `src/pages` (e.g. `src/server/__tests__/`) and import the handler via the `~/pages/...` alias.

A test file under `src/pages` fails `next build` (`Type '...test' does not satisfy the constraint 'ApiRouteConfig'`), and only `next build` catches it; typecheck, vitest and CI tasks pass (PR #2653).

## Prefer `importOriginal` over hand-listed `vi.mock` exports

Spread the real module and override only what you need:

```ts
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
```

- Use a top-level `import type * as PromClient`; an inline `typeof import('...')` trips `consistent-type-imports`.
- Many existing tests hand-list exports (over 100 mock `~/server/services/image.service` that way). They predate this rule; don't copy that shape into a new test.
- Before widening a mock, check whether the import edge is needed at all. A failing suite may mean the code pulled in a dependency it doesn't want, and widening hides that.

Why: a hand-listed mock couples the test to the whole transitive import graph. Adding one import can drag in a module that builds `pLimit`/prom collectors at load (e.g. `~/server/search-index` -> `meilisearch/client`) and the suite fails to load far from the change, while typecheck and lint stay green and only CI catches it.

## Check how a test FAILS, not just that it passes

"The tests would catch a regression here" is a claim about the failure mode. Ask what a reverted fix would look like: an assertion message, a timeout, or nothing at all.

- **Any fake driving a bounded loop must terminate on its own, and the test must assert it stopped early.** Cap a cursor fake at 50 pages so a regression reads `expected 51 to be less than 5`. See the `n = 10_000` cap in `src/server/auth/__tests__/session-invalidation.test.ts`.
- **Don't prove a property by absence of termination.** A non-terminating fake over already-resolved promises is a pure microtask loop; it starves the macrotask queue, so vitest's `setTimeout`-based `testTimeout` never fires and CI hangs with nothing to read.
- The paging guard in `test:lint-rules` catches cursor-shaped fakes only; a loop driven by anything else is still yours to bound.

## Never `await` a browser-test state that deletes itself

Awaiting a state to arrive is safe; awaiting one that will leave (a spinner on a ceiling, a debounce window, anything torn down on a timer) is a race `expect.element` cannot win. It polls every 50 ms against the test's remaining budget (browser-mode `testTimeout` defaults to 15 s; the `component` project does not override it), and once the state is gone it never returns. Such tests are green on a quiet box and red on a busy one.

Fix it structurally, in this order:
1. **Make the state absorbing.** Drive the component so nothing can take the state away (e.g. `rerender` with a window so large the timer can never fire), then assert it. Add a negative control proving the prop change alone did not produce the state.
2. **Don't assert the transient at all.** Await the absorbing end-state and pin the intermediate step through a non-DOM observable (a mock call count).

- **Do not widen the matcher budget, add a `retry`, or enlarge the component's own timeout instead.** That turns a fast failure into a slow one and leaves the race unwinnable on exactly the slow machines CI runs on.
- **A ~15 s failure is a candidate filter, not a diagnosis.** It only means some `expect.element` was never satisfied, and healthy tests can legitimately take that long. To tell self-deleting from never-arrived, read the observable synchronously right after the action, or enlarge the component's own window as a diagnostic only.

Worked examples: the two retry tests in `src/components/Apps/AppsSubmitEditView.browser.test.tsx`. Measurements: `claudedocs/rca-appblocks-component-suite-flake-2026-08-05.md` (PR #3645).

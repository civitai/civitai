/**
 * Component test files held OUT of the blocking `component` run and run instead by the
 * `Quarantined component tests` step of the `component` job (`.github/workflows/lint.yml`), on
 * pushes to `main` and on dispatch only — not on pull requests.
 *
 * Read by `vitest.config.mts` (the `component` project excludes them, the `component-quarantine`
 * project includes exactly them) and by `assert-component-suite-ran.mjs` (its on-disk ledger does
 * not demand them from the blocking run).
 *
 * Why this file is here: a browser test that times out at random on CI runners turns unrelated
 * PRs red on tests they do not touch.
 *
 * Exit: remove an entry after 10 green quarantined runs in a row, or re-decide 14 days after it
 * was added. Add nothing here without an exit like that.
 */
export const QUARANTINED_COMPONENT_FILES = [
  // Added 2026-10-31: random "Test timed out in 15000ms" on main and PR runs (a different test each
  // time, e.g. main run 41230744040), all 62 tests pass locally. Re-decide by 2026-11-14.
  'src/components/Apps/ScopeRevoke.browser.test.tsx',
];

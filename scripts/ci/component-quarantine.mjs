/**
 * Component test files held OUT of the blocking `component` run and run instead by the
 * `Quarantined component tests` step of the `component` job (`.github/workflows/lint.yml`), on
 * pushes to `main` and on dispatch only — not on pull requests.
 *
 * Read by `vitest.config.mts` (the `component` project excludes them, the `component-quarantine`
 * project includes exactly them) and by `assert-component-suite-ran.mjs` (its on-disk ledger does
 * not demand them from the blocking run).
 *
 * Why this file is here: the Playwright click round trip stalls for ~5s at random on CI runners,
 * on any click, so unrelated PRs went red on tests they do not touch. Three diagnostic runs, no
 * local repro (civitai/civitai#7101). Fixing click by click did not converge.
 *
 * Exit: remove an entry after 10 green quarantined runs in a row, or re-decide by 2026-11-11
 * (14 days from 2026-10-28). Add nothing here without an exit like that.
 */
export const QUARANTINED_COMPONENT_FILES = [
  'src/components/Apps/AppAssistant/AppAssistantWorkspace.browser.test.tsx',
  // Added 2026-10-31: random "Test timed out in 15000ms" on main and PR runs (a different test each
  // time, e.g. main run 41230744040), all 62 tests pass locally. Same exit rule as above.
  'src/components/Apps/ScopeRevoke.browser.test.tsx',
];

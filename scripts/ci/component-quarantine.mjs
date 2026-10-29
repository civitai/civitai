/**
 * Component test files held OUT of the blocking `component` run and run by the non-blocking
 * `component-quarantine` job (`.github/workflows/lint.yml`) instead.
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
];

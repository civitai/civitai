/**
 * Whether `pnpm run typecheck` should also gate the `apps/*` typechecks.
 *
 * Its own module rather than a function inside scripts/typecheck.mjs, for the same reason as
 * scripts/typecheck-queue.mjs: that file runs tsc at import, so nothing could load it to test
 * this rule without starting a multi-minute typecheck.
 */

/**
 * The root tsconfig `include` has no `apps/*` entry, so the root tsc run says nothing about the
 * SvelteKit apps - it printed OK over a planted type error in one of them (#4832). The apps have
 * their own `typecheck` scripts (`svelte-check`), which `scripts/ci/typecheck-apps.mjs` runs, so
 * closing the gap is a matter of reaching that script from here rather than widening `include`:
 * tsc cannot parse `.svelte` at all.
 */
export function typecheckAppsGateDecision(env, args = []) {
  // CI gates them in its own step: the "Typecheck apps" step of .github/workflows/apps.yml runs
  // scripts/ci/typecheck-apps.mjs on any PR touching apps/** or packages/**. Running them here
  // as well would double that work on every CI typecheck.
  if (env.CI) {
    return { run: false, why: 'CI gates apps/* in its own step' };
  }
  // The tsc seam exists to drive the ROOT classifier with a stub that exits like a crashed,
  // clean or erroring tsc. Those cases say nothing about apps/*, and fanning out to a real
  // svelte-check per app would make each of them minutes long.
  if (env.TYPECHECK_TSC_PATH) {
    return { run: false, why: 'the tsc test seam drives the root classifier only' };
  }
  // Any argument narrows the run (`-p tsconfig.scripts.json`, `--listFilesOnly`), the same rule as
  // scripts/typecheck-queue.mjs. A caller asking tsc a narrow question is not asking about apps/*.
  if (args.length > 0) {
    return { run: false, why: 'arguments narrow the run to what they name' };
  }
  return { run: true };
}

import type { Prisma } from '@prisma/client';

/**
 * 🔴 THE ONE DEFINITION OF "a scope invocation that COUNTS as app activity".
 *
 * An `app-block` row carries `appBlockId`; a synthetic dev-tunnel row carries `syntheticAppId`;
 * an EXTERNAL-OAUTH row carries NEITHER and must be excluded — otherwise an external-OAuth-only
 * viewer is handed an Activity tab over a feed that reads "No activity yet".
 *
 * Read by exactly two call sites, which must never disagree:
 *   · `listMyScopeInvocations` (the FEED) — what the Activity page shows;
 *   · `blocks.getNavSummary`'s `hasActivity` probe — whether the Activity TAB is offered.
 * Probe wider than feed ⇒ a tab over an empty page. Probe narrower ⇒ the no-tab defect this
 * whole change exists to fix.
 *
 * ── WHY THIS IS ITS OWN LEAF MODULE ──────────────────────────────────────────────
 * 🔴 IT LIVED IN `user-app-surface.service.ts` FOR ONE ROUND AND THAT PUT A HEAVY SERVICE INTO
 * A HOT ROUTER'S STATIC GRAPH. `blocks.router.ts` deliberately keeps that service OUT of its
 * eager imports — it says so at its own `await import(…)` sites, and
 * `blocks.router.workflow.test.ts` calls the module "REAL, heavy" and mocks it so its first
 * real import does not serialise the module runner. Importing a shared constant from it made
 * all five of those lazy imports graph-inert, and silently re-armed the cost the pattern
 * exists to avoid: an import added to the service later — say `image.service` to resolve app
 * art — would land in the router's eager graph with nothing to flag it.
 *
 * It also broke four router suites' one-key `vi.mock` factories in waiting: they stub that
 * service with `recordScopeInvocation` alone, so the first nav-summary case added there would
 * have thrown `No "GLOBAL_SCOPE_ACTIVITY_OR" export is defined on the … mock`. A leaf module
 * with a TYPE-ONLY Prisma import costs nothing at runtime and removes both hazards.
 *
 * ── AND WHY IT IS TYPED AGAINST PRISMA ───────────────────────────────────────────
 * 🔴 A LOOSER ANNOTATION ERASED A REAL COMPILE-TIME CHECK, MEASURED. The first version was
 * `{ OR: Array<Record<string, { not: null }>> }`, chosen only to dodge a readonly-tuple error.
 * `Record<string, …>` does not constrain KEY NAMES: an audit typo'd `appBlockId` → `appBlokId`
 * inside the constant and `pnpm run typecheck` reported **0 errors**, where the same typo in
 * the pre-refactor inline literal reported `TS2561 … 'appBlokId' does not exist in type
 * 'BlockScopeInvocationWhereInput'`. Typing the array as Prisma's own input restores that and
 * compiles clean, so the loose form bought nothing.
 */
export const GLOBAL_SCOPE_ACTIVITY_OR: { OR: Prisma.BlockScopeInvocationWhereInput[] } = {
  OR: [{ appBlockId: { not: null } }, { syntheticAppId: { not: null } }],
};

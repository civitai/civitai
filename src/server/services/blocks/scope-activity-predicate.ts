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

/**
 * 🔴 THE ONE SPELLING of the `block_scope_invocations.source` value that marks a row as
 * produced under a PRIVATE-RUN token — an owner, an accepted listing collaborator, or a
 * moderator running a delisted/suspended app's already-deployed bundle.
 *
 * ── WHY A `source` VALUE AND NOT A NEW COLUMN ────────────────────────────────────
 * `source` is already the column that "discriminates the token population that made the
 * call", it is already documented as the one consumers filter on, and it is plain
 * `TEXT NOT NULL DEFAULT 'app-block'` with **no CHECK constraint** — verified against the
 * live schema, not inferred from the migration. So a third value needs NO DDL and
 * therefore no per-environment hand-apply (this repo's Database rule: migrations here are
 * applied BY HAND, per environment, by a human). A private-run token genuinely IS a third
 * token population: it is minted by its own branch with its own claim, so the value is
 * exact rather than an overload.
 *
 * ⚠️ The two existing values are `'app-block'` and `'external-oauth'`. A private-run row is
 * always a block-token row, and an external-OAuth access token can never carry the
 * private-run claim, so the three values stay mutually exclusive by construction.
 */
export const PRIVATE_RUN_INVOCATION_SOURCE = 'private-run';

/**
 * 🔴 THE ONE DEFINITION of "exclude private-run activity", for every OWNER-VISIBLE read of
 * `block_scope_invocations`. Spread into the `where` of each aggregate in
 * `app-analytics.service.ts`.
 *
 * ── THE PROPERTY IT BUYS ─────────────────────────────────────────────────────────
 * A moderator's private run of a delisted app must be invisible to that app's owner
 * INCLUDING IN ANALYTICS, because a visible review run tells a bad actor exactly when
 * review is happening. The invocation row carries the app's REAL id and the reviewer's
 * REAL user id by design (a synthetic id would break per-app storage namespacing and every
 * runtime metric label), so the row lands squarely in the owner's own `appBlockId IN
 * (ownedIds)` aggregates. Nothing else removes it.
 *
 * ── AND THE PROPERTY IT MUST NOT BREAK, WHICH IS THE QUIETER HAZARD ──────────────
 * 🔴 OVER-FILTERING SILENTLY DELETES THE OWNER'S REAL USAGE DATA, and nobody reports
 * numbers they never saw. This predicate is deliberately the NARROWEST thing that works:
 * it names one exact value and excludes nothing else. It is NOT `source: 'app-block'` —
 * that spelling would additionally drop every row written before the `source` migration
 * backfill was reasoned about, and would silently exclude any future fourth value.
 *
 * ── WHY IT IS NOT APPLIED TO THE VIEWER'S OWN SURFACES ───────────────────────────
 * The three `userId`-keyed reads — `listMyScopeInvocations` (the viewer's Activity feed),
 * `listAppBlocksThatActedOnUser` (the viewer's permissions tab) and
 * `blocks.getNavSummary`'s `hasActivity` probe — are a viewer looking at their OWN rows.
 * A moderator must keep seeing what they themselves did; suppressing it there would delete
 * the reviewer's own audit trail to solve an owner-visibility problem. The distinction that
 * decides it is which column the read is keyed on: `appBlockId` ⇒ owner-visible ⇒ filter;
 * `userId` ⇒ self-visible ⇒ do not.
 */
export const OWNER_VISIBLE_INVOCATION_FILTER = {
  source: { not: PRIVATE_RUN_INVOCATION_SOURCE },
} satisfies Prisma.BlockScopeInvocationWhereInput;

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
 * The COMPLETE value space of `block_scope_invocations.source`, in one place.
 *
 * 🔴 IT EXISTS SO NOTHING HAS TO WIDEN TO `string` TO EXPRESS THE THIRD VALUE. The writer's
 * DTO listed two values while the column had three, and the local that carried the new one
 * was annotated `string` — which drops the only compile-time check on this column, because
 * the row object handed to Prisma is bridge-cast and nothing reads `source` back through a
 * narrowed type. The sibling docblock above this file's other export records the measured
 * version of that lesson: a looser annotation let an `appBlokId` typo typecheck at zero
 * errors.
 *
 * ⚠️ There is no CHECK constraint behind this, so it is a TypeScript-side claim about what
 * this codebase writes, not a database invariant. A fourth value would need adding here and
 * in the `///` comment on the Prisma model, which is the single source for the generated
 * type docs every future reader of the column sees.
 */
export type BlockScopeInvocationSource =
  | 'app-block'
  | 'external-oauth'
  | typeof PRIVATE_RUN_INVOCATION_SOURCE;

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
 * it names one exact value and excludes nothing else. It is NOT `source: 'app-block'`,
 * which would silently exclude any future fourth value the moment it is introduced.
 * ⚠️ An earlier revision of this paragraph ALSO justified that with "it would drop every row
 * written before the `source` migration backfill" — which is false, and read as a measured
 * fact. There is no such population: the column was added `NOT NULL DEFAULT 'app-block'`,
 * so every pre-existing row already carries `'app-block'`. The conclusion survives on the
 * fourth-value reason alone.
 *
 * 🔴 IT IS EXACT ONLY BECAUSE `source` IS `NOT NULL`. The four Prisma reads spell this as
 * `{ not: X }` and the raw `count(DISTINCT user_id)` read spells it as `"source" <> $n`;
 * those agree on a non-nullable column and DIVERGE on a nullable one, where Prisma's `not`
 * and a bare SQL `<>` treat NULL differently. If a fourth token population ever leaves
 * `source` unset, `apiCalls` and `activeUsers` would disagree in the over-filtering
 * direction this very paragraph calls the worse failure. Keep the column NOT NULL, or
 * change both spellings together.
 *
 * ⚠️ AND IT APPLIES TO THE OWNER'S OWN PRIVATE RUN TOO, which the rest of this docblock
 * reasons about as if the actor were always a moderator. The feature admits the owner and
 * accepted collaborators, and their rows carry the same marker — so an owner diagnosing
 * their own takedown through the private-run route has that activity absent from their own
 * dashboard. That is intended (a private run is a diagnostic, not a use of the app) but it
 * was stated nowhere, and it is the same silent-deletion shape, for a different actor.
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

/**
 * 🔴 A DEPLOY NOTE, NOT AN IMPLEMENTATION DETAIL: the reads that spread the filter above are
 * the FIRST in this codebase to NAME the `source` column, and migrations here are applied BY
 * HAND, per environment.
 *
 * Until now only a WRITE depended on it — the external-OAuth audit, which is
 * fire-and-forget and swallows its errors — while the two sibling READERS of this table
 * deliberately filter on PRE-EXISTING columns and say so in-line, to stay safe against the
 * migration being outstanding. Spreading this filter takes that dependency on the read side,
 * where a missing column is Postgres 42703 / Prisma P2022 and rejects the whole
 * `Promise.all` in `getMyAppAnalytics` — so the owner's ENTIRE analytics panel errors, not
 * just the engagement half.
 *
 * MEASURED before shipping, at the two databases this code runs against: the column is
 * present in BOTH the production and the dev cluster. So the dependency is satisfied rather
 * than assumed — but the measurement's scope is those two, and a third environment is one
 * `SELECT` away from being checked rather than argued about.
 *
 * 🔴 AND IT IS DELIBERATELY NOT SWALLOWED, because both available swallows are worse than
 * the error. Returning the rows unfiltered fails OPEN — it re-opens the exact leak this
 * predicate closes, in the one situation nobody is watching. Returning zeros fails closed
 * but silently empties a dashboard, which is the over-filtering failure this file warns
 * about twice. An error is the honest third option: loud, environment-wide rather than
 * per-app, and therefore not itself a disclosure about any one app.
 */

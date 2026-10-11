import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import {
  OWNER_VISIBLE_INVOCATION_FILTER,
  PRIVATE_RUN_INVOCATION_SOURCE,
} from '~/server/services/blocks/scope-activity-predicate';
import { hasInstallSlot, type InstallSlotManifest } from '~/shared/constants/slot-registry';
import { type AppViews, emptyViews, getAppViews, unavailableViews } from './app-views.service';

/**
 * App Blocks — author-facing analytics (Phase 0).
 *
 * PURE DERIVATION: every metric here is computed from data App Blocks
 * ALREADY writes. No new events, tables, or instrumentation — that is a
 * deliberate later phase. Read-only (`dbRead`), no writes, no money
 * movement.
 *
 * SECURITY: an author must NEVER see another author's analytics. Every
 * query is scoped to app_block ids the caller OWNS. Ownership is the v1
 * source of truth `AppBlock.app.userId === ownerUserId` (the OauthClient
 * relation), mirrored exactly from getMyApps / getMyRevenue. We resolve
 * the caller's owned ids FIRST and intersect the requested `appBlockId`
 * against them; a non-owner (or an unknown id) gets an empty result, never
 * another owner's rows.
 *
 * BOUNDED SCANS: the date range is clamped (default last 30d, capped at
 * MAX_RANGE_DAYS) and every aggregate is filtered by both the owned
 * app_block id set AND the date range so a query can't degrade into an
 * unbounded table scan. The per-app id equality + attributed_at/invoked_at
 * range hits the existing dashboard indexes
 * (bsa_app_block_dashboard_idx / bba_app_block_dashboard_idx /
 * bsi_app_block_invoked_idx) and the new bus analytics index.
 */

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366; // ~1y cap so no unbounded scans
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 🔴 THE ONE SPELLING of the `block_spend_attribution.status` value that takes a row OUT of
 * the owner's view. Bound as a PARAMETER in the raw series read and compared via Prisma's
 * `not` in the aggregate — the two reads must never disagree, so neither re-spells it.
 *
 * ── WHY A DENYLIST AND NOT AN ALLOWLIST ─────────────────────────────────────────
 * `block_spend_attribution_status_check` permits SIX values — `tracked, pending, confirmed,
 * voided, paid_out, held` (read off the live constraint, not inferred from a migration).
 * `status: 'tracked'` would therefore silently drop a row the moment the payout rail starts
 * writing `confirmed` / `paid_out`, which is the same silent-deletion failure as the
 * nullability trap below, only arriving later and with nobody looking. Excluding the one
 * value that MEANS "not owner-visible" is the narrowest predicate that works.
 *
 * ── AND WHY IT IS `status`, NOT `voidedReason` ──────────────────────────────────
 * 🔴 `status` is `TEXT NOT NULL DEFAULT 'tracked'`, so Prisma's `not` and a bare SQL `<>`
 * agree on it. `voided_reason` is NULLABLE and NULL *is* the ordinary `tracked` population,
 * so the narrow spelling `voidedReason: { not: 'manual_review' }` drops every real row and
 * zeroes the owner's run count. Do not move this predicate onto that column.
 *
 * 🔴 AND IF YOU MUST, USE THE `OR`-WITH-`null` FORM — NOT a top-level `NOT`. This file used
 * to recommend either, and the `NOT` half is WRONG, measured against the live table
 * 2026-09-29: `WHERE NOT (voided_reason IN ('manual_review','self_spend'))` retains
 * **0 of 639 rows**, because `NULL IN (…)` is NULL and `NOT NULL` is NULL, so every one of
 * the 57 real `tracked` rows is filtered out. That is the exact zero the paragraph above
 * warns about, produced by the remedy it offered.
 *
 * 🔴 THERE IS EXACTLY ONE FORM THAT BOTH KEEPS NULLs AND ACTUALLY NARROWS:
 *   `voided_reason IS NULL OR voided_reason NOT IN (…)`  → 57 ✅
 * ⚠️ `voided_reason IS DISTINCT FROM 'manual_review'` → **639**, and an earlier version of
 * this note listed that as a second "form that works". It is null-aware but SINGLE-VALUED,
 * so against a two-value exclusion it narrows NOTHING — 639 is the whole population. Printing
 * 57 and 639 side by side as two working options invites picking the one that excludes
 * nothing, which is the same silent-no-op this paragraph exists to prevent.
 *
 * ⚠️ AND THE SCOPE OF THAT CLAIM, because it has been over- and under-stated in turn. What
 * is MEASURED here is the OUTCOME in Postgres: the SQL above retains 0 rows. A previous
 * revision of this note went further and asserted the RENDERING — "the engine emits a bare
 * `(NOT <expr>)` with no `IS NULL` disjunct" — which nothing in this change measured; no
 * generated SQL was ever captured. Prisma's own `in` reference is reported to document the
 * same combination ("combine `in` and `NOT` … rows with `null` are not returned"), but that
 * quote could not be re-confirmed against the live docs at the pinned major, so treat it as
 * corroboration rather than proof. Among the SCALAR filters, only `equals: null` /
 * `not: null` are null-aware — that is deliberately not a claim about the whole filter
 * surface (`isSet`, and the relation filters, interact with null on their own terms).
 *
 * None of that changes the instruction, which is why the hedging is worth getting right
 * rather than dropping: the observed behaviour is enough. Spell the `OR`.
 */
const VOIDED_ATTRIBUTION_STATUS = 'voided';

/**
 * 🔴 THE ONE DEFINITION of "exclude voided attribution rows", for every OWNER-VISIBLE read
 * of `block_spend_attribution`. Spread into the `where` of the aggregate below.
 *
 * ⚠️ A PRIVATE RUN NO LONGER WRITES A ROW AT ALL — the exclusion moved to the WRITE side
 * (`recordSpendAttribution` returns before building the row). This paragraph used to read
 * "A private run of a delisted app writes its generation row `voided` /
 * `voidedReason: 'manual_review'` … nothing else removes it", which was true when written
 * and is now false.
 *
 * 🔴 THE FILTER BELOW IS NOT DEAD — but for ONE reason, not three. `self_spend` and
 * `internal_owner` are written unchanged by `recordSpendAttribution` and are the entire
 * live voided population: measured, 582 of 639 rows, every one of them `self_spend`.
 * Removing this filter would surface them on owners' own panels.
 *
 * ⚠️ TWO FURTHER REASONS WERE CLAIMED HERE AND ARE BOTH RETRACTED — recorded rather than
 * deleted, so the next reader does not re-derive them. (1) "the historical private-run
 * rows written BEFORE the write-side change are still in the table": the flag has been
 * base-off with no rollout for its whole life, so no private run ever wrote a row — that
 * population is EMPTY. (2) "`'manual_review'` has a SECOND, still-live producer —
 * `backpay.service.ts`": false on both halves. That writer targets
 * `blockSubscriptionAttribution`, a DIFFERENT TABLE, with `status: 'held'`, not `voided`
 * — and this filter keys on `status`, so it would not exclude such a row in any case.
 *
 * ⚠️ THE PREDICATE IS WIDER THAN THE LEAK, DELIBERATELY, AND THAT IS AN OPERATOR DECISION
 * RATHER THAN A DETAIL. `status = 'voided'` covers THREE populations, not one —
 * `manual_review`, `self_spend` (the owner running their own app), and
 * `internal_owner`. ⚠️ `manual_review` was glossed here as "the private run" and that is no
 * longer its live meaning — private runs write no row. 🔴 NOR is there any OTHER producer:
 * an earlier correction here named historical private runs and `backpay.service.ts`, and
 * BOTH are retracted above. `manual_review` currently has NO live writer on this table.
 * Excluding `self_spend` is the accepted behaviour change: measured on
 * the live table before shipping, it was 582 of 639 rows, every one of them the app owner
 * spending on their own app, with no row of real third-party usage voided at all.
 *
 * 🔴 BUT "IT REMOVES SELF-TESTING, NOT USAGE" IS A CLAIM ABOUT TODAY'S ROWS, NOT ABOUT THE
 * MECHANISM — an earlier version of this docblock asserted the stronger form and it was
 * wrong. `internal_owner` is keyed on the APP OWNER, not the spender:
 * `buzz-attribution.service.ts` computes it as
 * `ACTIVE_RATE_CARD.internalAppOwnerUserIds.includes(app.userId)`. So the moment that
 * array is populated — and `blocks/rate-card.ts` instructs whoever launches to populate it
 * with civitai team userIds "before going live" — EVERY spend row on a team-owned app is
 * written `voided` regardless of who spent it, and this filter then reports 0 runs / 0 Buzz
 * for a first-party app's GENUINE third-party usage. It is inert today only because the
 * array is empty. The warning for whoever populates it lives on that field's own docblock.
 *
 * 🔴 AND IF YOU TAKE THE NARROWER FIX, READ THE TRAP PARAGRAPH ABOVE FIRST. Excluding by
 * `voidedReason` (`manual_review` + `self_spend`) is the right SHAPE, but every obvious
 * spelling of it is NULL-unsafe: `{ notIn: [...] }`, `{ not: ... }` AND a top-level `NOT`
 * all drop the 57 real `tracked` rows, whose `voided_reason` is NULL. Use the explicit
 * `OR`-with-`null` form, keep the `status` guard alongside it rather than replacing it, and
 * verify the row count moves the way you expect before believing it.
 *
 * ⚠️ Spread it FIRST and let the explicit keys win — `appBlockId: idIn` is the only thing
 * scoping this read to the caller's own apps, and a spread placed LAST wins any key
 * collision. `satisfies` constrains the constant's SHAPE, not which keys it may hold.
 */
const OWNER_VISIBLE_SPEND_FILTER = {
  status: { not: VOIDED_ATTRIBUTION_STATUS },
} satisfies Prisma.BlockSpendAttributionWhereInput;

export type AnalyticsTimePoint = { bucket: string; value: number };

export type AppAnalytics = {
  /** The resolved range actually queried (after clamping). */
  range: { from: Date; to: Date; granularity: 'day' | 'week' };
  /** True when the caller does not own `appBlockId` — all metrics are zeroed. */
  notOwned: boolean;
  /**
   * Present ONLY when the zeroed counters are a placeholder rather than a
   * measurement: `notEntitled` (the appBlocks flag is off for this caller, so
   * nothing was queried) or `notOwned`. A genuinely-measured result omits it
   * even when every counter is 0 — without this a real "no activity yet" app
   * and a never-queried one are byte-identical, and a client renders fabricated
   * zeros as data.
   *
   * DECIDED — a caller who owns NO apps is deliberately NOT flagged, and
   * "ownsNothing" is deliberately not a third value. (Raised twice in review as
   * "defensible but wants a recorded decision"; this is that record.)
   *
   * The discriminator's test is whether the zeros were MEASURED, not whether
   * they are interesting. `notEntitled` and `notOwned` are both cases where we
   * ran no aggregate at all, so their zeros are fabricated. Owning nothing is
   * not that case: an aggregate over an empty owned set genuinely IS zero, so
   * `getMyAppAnalytics` short-circuits only because the answer is already
   * knowable — "you have no apps, so you have no installs" is a true statement
   * about the world, and it is one the caller can already see without a flag.
   * Flagging it would put every honest new author behind an `unavailable`
   * branch on their first visit and teach clients to skip the flag that exists
   * to stop them believing a fabricated zero.
   *
   * PRECEDENT — #3581 settled the shape of this answer for the sibling
   * `getMyRevenue`: ONE value, not two, because `getRevenueForOwner` never
   * *computes* ownership (it scopes by `appOwnerUserId` in the WHERE clause),
   * so a not-owned request there returns a truthful zero-row aggregate and
   * `notOwned` is unproducible — declaring it would force an unreachable branch
   * into every renderer. Analytics DOES compute ownership up front, which is
   * why it has the second value revenue cannot have; the rule ("flag only what
   * was never measured") is identical, and it is what holds this union at two.
   *
   * SETTLED BY IMPLEMENTATION — #3613 applied the same rule one level down:
   * `views` carries its own flag and tracks this one, so the owns-nothing path
   * leaves views unflagged (`emptyViews()`, never `unavailableViews()`), with a
   * test pinning it. A third value here would have to move that section and
   * every renderer branch with it.
   */
  unavailable?: 'notEntitled' | 'notOwned';
  installs: {
    /** All-time installs for this app (subscription rows ever created). */
    total: number;
    /** Currently-active installs (enabled = true), all-time. */
    active: number;
    /** New installs per bucket within the range. */
    series: AnalyticsTimePoint[];
    /**
     * TRUE when an install row CANNOT EXIST for the app(s) in scope — every one
     * of them is page-only, and a page app is stateless by explicit decision
     * (`src/pages/apps/run/[slug]/[[...path]].tsx`: "STATELESS (Decision 2): no
     * `block_user_subscriptions` row, no migration"). The zeros above are then a
     * CATEGORY ERROR, not a measurement of user behaviour.
     *
     * This is a THIRD state, and the whole point is that it stays distinct from
     * the other two:
     *   1. measured non-zero — a model-slot app with installs;
     *   2. measured zero — a model-slot app that genuinely has none YET. This
     *      MUST still render `0`; it is a real, actionable number.
     *   3. not applicable — this flag.
     * Collapsing 3 into 2 is the defect (a page author reads `Installs 0` as
     * "nobody installed me" when nobody CAN). Collapsing 2 into 3 would be a NEW
     * defect — it would hide a truthful zero behind an excuse.
     *
     * PER-SECTION, exactly like `views.unavailable`, and for the same reason:
     * inapplicability of installs says nothing about the runs / Buzz / loads
     * counters in the same response, which are genuinely measured for a page
     * app. A payload-level flag would discard that good data. Distinct NAME on
     * purpose — `views.unavailable` means "we could not ask"; this means "we
     * asked, and the question is meaningless for this app".
     *
     * 🔴 NEVER set when a counter is non-zero. A `block_user_subscriptions` row
     * for a page app is not merely hypothetical: `upsertSubscription` applies no
     * slot check, and `assertLaunchAppForCaller` (blocks.router.ts) admits ANY
     * page-declaring app — so if `app-blocks-enabled` is ever widened past mods,
     * rows can appear against a stateless app. If that happens the author must
     * SEE the number, not an "n/a" that hides it. See `installsNotApplicable`.
     *
     * MIXED OWNERSHIP: on the "All my apps" (no `appBlockId`) read the flag is
     * set only when EVERY owned app is page-only. One installable app in the set
     * makes the aggregate a real measurement, so it is reported as one.
     */
    notApplicable?: boolean;
  };
  runs: {
    /** Generations/runs through the app within the range. */
    count: number;
    /** Sum of viewer Buzz burned through the app within the range. */
    buzzSpent: number;
    /** Runs per bucket within the range. */
    series: AnalyticsTimePoint[];
  };
  /** Buzz purchased (card) through the app within the range. */
  buzzPurchased: {
    /** Count of purchase rows. */
    count: number;
    /** Sum of buzz_amount purchased. */
    buzzAmount: number;
    /** Gross USD value purchased, in cents. */
    grossCents: number;
  };
  /**
   * Engagement from block_scope_invocations. COVERAGE CAVEAT: this table
   * is written ONLY on AUTHENTICATED, scope-gated API calls. Anonymous
   * viewers and static / no-scope blocks emit nothing here — so a block
   * with no scoped API surface shows installs + revenue but flat
   * engagement. The UI surfaces this caveat.
   */
  engagement: {
    /** Total scoped API calls within the range. */
    apiCalls: number;
    /** Distinct authenticated users who made a scoped call. */
    activeUsers: number;
    /** Ratio of calls with status_code >= 400 (0..1). */
    errorRate: number;
    /** Top scopes by call volume. */
    topScopes: Array<{ scope: string; count: number }>;
    /** Top endpoints by call volume. */
    topEndpoints: Array<{ endpoint: string; count: number }>;
  };
  /**
   * Impressions from the `blockRenders` ClickHouse table — the ONLY signal
   * that covers the viewers `engagement` structurally cannot see (anonymous
   * viewers, and static / no-scope blocks that never make a scoped API call).
   *
   * This is the one section NOT derived from Postgres, so it carries its own
   * `unavailable` flag: ClickHouse can be unconfigured or down while every
   * other counter in this payload is genuinely measured. See
   * `./app-views.service`.
   */
  views: AppViews;
};

export function emptyAnalytics(
  range: AppAnalytics['range'],
  notOwned: boolean,
  unavailable: AppAnalytics['unavailable'] = notOwned ? 'notOwned' : undefined
): AppAnalytics {
  return {
    range,
    notOwned,
    ...(unavailable ? { unavailable } : {}),
    // `installs.notApplicable` is deliberately NOT set on any of these paths.
    // It is a claim about the app's MANIFEST (page-only ⇒ no install row can
    // exist), and on every path that reaches here we either never resolved a
    // manifest (notEntitled / notOwned — the payload-level `unavailable` above
    // is what tells the client those zeros are fabricated) or the caller owns no
    // apps at all, where "you have no apps, so you have no installs" is a
    // truthful measured zero (see the DECIDED note on `unavailable`). Asserting
    // inapplicability without having read a manifest would fabricate a
    // DIFFERENT claim in place of the one this payload already makes.
    installs: { total: 0, active: 0, series: [] },
    runs: { count: 0, buzzSpent: 0, series: [] },
    buzzPurchased: { count: 0, buzzAmount: 0, grossCents: 0 },
    engagement: {
      apiCalls: 0,
      activeUsers: 0,
      errorRate: 0,
      topScopes: [],
      topEndpoints: [],
    },
    // Mirror the payload's own honesty: when `unavailable` is set nothing was
    // queried (notEntitled / notOwned), so the impression zeros are a
    // placeholder too. When it is NOT set the caller simply owns no apps —
    // that is a truthful measured zero, and flagging it would train clients to
    // ignore the flag.
    views: unavailable ? unavailableViews() : emptyViews(),
  };
}

/**
 * Clamp the requested range: default to the last DEFAULT_RANGE_DAYS, never
 * exceed MAX_RANGE_DAYS, and never let `from` be after `to`. Picks day
 * granularity for ranges up to ~60d, week granularity beyond, so the
 * series stays bounded (≤ ~53 points).
 */
export function resolveRange(input: { from?: Date; to?: Date; now?: Date }): AppAnalytics['range'] {
  const now = input.now ?? new Date();
  let to = input.to ?? now;
  if (to.getTime() > now.getTime()) to = now;
  let from = input.from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) from = new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  const maxFrom = new Date(to.getTime() - MAX_RANGE_DAYS * DAY_MS);
  if (from.getTime() < maxFrom.getTime()) from = maxFrom;
  const spanDays = (to.getTime() - from.getTime()) / DAY_MS;
  const granularity: 'day' | 'week' = spanDays > 60 ? 'week' : 'day';
  return { from, to, granularity };
}

/** The owned-app fields analytics reads: the id, plus the manifest that decides
 *  whether an install row is even possible (see `installsNotApplicable`). */
export type OwnedAppBlock = { id: string; manifest: unknown };

/**
 * The app_blocks the caller may see analytics for, optionally narrowed to a single
 * requested id. Returns [] when the requested id isn't reachable by them (or they can
 * see nothing) — the callers then fail closed to an empty result.
 *
 * 🔴 WIDENED FOR COLLABORATORS, and the widening is SAFE HERE for a reason that does
 * NOT generalise to the earnings path. This function is app-scoped by construction:
 * it resolves a permitted-id SET and `getMyAppAnalytics` filters every downstream
 * aggregate by `appBlockId IN thatSet`. The earnings reads (`getRevenueForOwner`,
 * `getRecentAttributionsForOwner`, `getMyApps`' groupBy) instead key on
 * `BlockBuzzAttribution.appOwnerUserId`, which does not mention the app at all — the
 * equivalent "widening" there would hand an editor the OWNER'S ENTIRE PORTFOLIO. Those
 * are served by `app-collaborator-earnings.service` instead. Do not copy this pattern
 * onto an `appOwnerUserId`-keyed query.
 *
 * The manifest rides along on this ONE query rather than a second round trip:
 * `getMyAppAnalytics` fans out per approved app row (see the note on
 * VIEWS_QUERY_TIMEOUT_SECONDS), so an extra query here is paid N times per page
 * load for a value the same `findMany` already has in hand.
 */
export async function getOwnedAppBlocks({
  ownerUserId,
  appBlockId,
}: {
  ownerUserId: number;
  appBlockId?: string;
}): Promise<OwnedAppBlock[]> {
  const { resolveAccessibleAppBlockIds } = await import(
    '~/server/services/blocks/app-access.service'
  );
  const { allIds } = await resolveAccessibleAppBlockIds(ownerUserId);
  if (allIds.length === 0) return [];
  const owned = await dbRead.appBlock.findMany({
    // Owner-held ids AND accepted-seat ids, resolved above. Never a bare
    // `app: { userId }` — that would drop every collaborator's app.
    where: { id: { in: allIds } },
    select: { id: true, manifest: true },
  });
  if (!appBlockId) return owned;
  return owned.filter((a) => a.id === appBlockId);
}

/**
 * The app_block ids the caller owns, optionally narrowed to a single
 * requested id. Returns [] when the requested id isn't theirs (or they
 * own nothing) — the callers then fail closed to an empty result.
 */
export async function getOwnedAppBlockIds(args: {
  ownerUserId: number;
  appBlockId?: string;
}): Promise<string[]> {
  return (await getOwnedAppBlocks(args)).map((a) => a.id);
}

/**
 * Is the installs section a CATEGORY ERROR for this set of apps? See
 * `AppAnalytics['installs'].notApplicable` for the three states this keeps
 * apart. Exported so the rule has exactly one home and one test target.
 *
 * `hasInstallSlot` is the SHARED predicate — the same one the marketplace card
 * (`components/Apps/AppBlockCard.tsx`) and the app detail page use to decide
 * whether to show the Install CTA. Reusing it keeps the manifest half of that
 * question in one place.
 *
 * 🔴 It is NOT the whole CTA predicate, so do not read this as "the panel and
 * the product can never disagree". Both CTA sites gate on
 * `!isExternal && hasInstallSlot(...)`, and this function deliberately omits
 * BOTH extra conditions: it ignores `isExternal`, and `getOwnedAppBlocks`
 * applies no `status` filter. So an EXTERNAL listing with model targets, or a
 * model-slot app that is not yet approved, gets no Install CTA while this
 * reports a measurement. Both are latent today (prod holds zero external and
 * zero pending rows) and both are strictly today's behaviour rather than a
 * regression — but if you widen this, widen it deliberately and say which of
 * the three axes you are adding.
 *
 * The `total`/`active` guard is not belt-and-braces, it is the state-(1) guard —
 * a real count is ALWAYS reported, even for an app whose slots say it should not
 * have one. Getting this backwards hides data behind an excuse.
 */
export function installsNotApplicable({
  ownedApps,
  total,
  active,
}: {
  ownedApps: Array<{ manifest?: unknown }>;
  total: number;
  active: number;
}): boolean {
  // No apps resolved: nothing to make a claim about. The caller's own
  // owns-nothing / notOwned handling covers this; see emptyAnalytics.
  if (ownedApps.length === 0) return false;
  // Never hide a measured count behind "not applicable".
  if (total > 0 || active > 0) return false;
  return !ownedApps.some((a) => hasInstallSlot(a.manifest as InstallSlotManifest | null));
}

/**
 * Author-facing analytics for ONE owned app block (or all the caller's
 * apps when `appBlockId` is omitted), over a bounded date range.
 *
 * SECURITY: resolves owned ids first; returns zeroed analytics with
 * `notOwned: true` if the requested id isn't the caller's.
 */
export async function getMyAppAnalytics({
  appBlockId,
  userId,
  from,
  to,
  now,
}: {
  appBlockId?: string;
  userId: number;
  from?: Date;
  to?: Date;
  now?: Date;
}): Promise<AppAnalytics> {
  const range = resolveRange({ from, to, now });
  const ownedApps = await getOwnedAppBlocks({ ownerUserId: userId, appBlockId });
  const ownedIds = ownedApps.map((a) => a.id);

  // Fail closed: a specifically-requested id that the caller does not own
  // yields zeroed analytics flagged notOwned (never another owner's data).
  if (appBlockId && ownedIds.length === 0) {
    return emptyAnalytics(range, true);
  }
  // The caller owns nothing — nothing to report, and deliberately NOT flagged
  // `unavailable`: they didn't ask for a specific foreign id, and an aggregate
  // over an empty owned set is a truthful measured zero rather than a
  // placeholder. See the DECIDED note on the `unavailable` field before
  // "fixing" this into a third discriminator value.
  if (ownedIds.length === 0) {
    return emptyAnalytics(range, false);
  }

  const idIn = { in: ownedIds };
  const rangeFilter = { gte: range.from, lte: range.to };
  // date_trunc unit string is a fixed literal chosen from a closed set —
  // never user input — so it is safe to inline in the raw SQL.
  const truncUnit = range.granularity;

  const [
    installsTotal,
    installsActive,
    installsSeries,
    runsAgg,
    runsSeries,
    purchasedAgg,
    invocationsAgg,
    distinctUsers,
    errorCount,
    topScopes,
    topEndpoints,
    views,
  ] = await Promise.all([
    // INSTALLS — block_user_subscriptions. Total & active are all-time
    // (an author cares about their current install base), the series is
    // new installs within the range.
    dbRead.blockUserSubscription.count({ where: { appBlockId: idIn } }),
    dbRead.blockUserSubscription.count({
      where: { appBlockId: idIn, enabled: true },
    }),
    dbRead.$queryRaw<Array<{ bucket: Date; value: bigint }>>(Prisma.sql`
      SELECT date_trunc(${truncUnit}, "created_at") AS bucket, count(*)::bigint AS value
      FROM "block_user_subscriptions"
      WHERE "app_block_id" IN (${Prisma.join(ownedIds)})
        AND "created_at" >= ${range.from}
        AND "created_at" <= ${range.to}
      GROUP BY 1
      ORDER BY 1 ASC
    `),

    // RUNS + BUZZ SPENT — block_spend_attribution. Generations through the
    // app + Buzz burned, within the range. Hits bsa_app_block_dashboard_idx
    // (app_block_id, attributed_at).
    dbRead.blockSpendAttribution.aggregate({
      where: { ...OWNER_VISIBLE_SPEND_FILTER, appBlockId: idIn, attributedAt: rangeFilter },
      _count: true,
      _sum: { buzzAmount: true },
    }),
    dbRead.$queryRaw<Array<{ bucket: Date; value: bigint }>>(Prisma.sql`
      SELECT date_trunc(${truncUnit}, "attributed_at") AS bucket, count(*)::bigint AS value
      FROM "block_spend_attribution"
      WHERE "app_block_id" IN (${Prisma.join(ownedIds)})
        AND "attributed_at" >= ${range.from}
        AND "attributed_at" <= ${range.to}
        AND "status" <> ${VOIDED_ATTRIBUTION_STATUS}
      GROUP BY 1
      ORDER BY 1 ASC
    `),

    // BUZZ PURCHASED — block_buzz_attribution. Card purchases originated
    // inside the app. Hits bba_app_block_dashboard_idx.
    dbRead.blockBuzzAttribution.aggregate({
      where: { appBlockId: idIn, attributedAt: rangeFilter },
      _count: true,
      _sum: { buzzAmount: true, usdAmountCents: true },
    }),

    // ENGAGEMENT — block_scope_invocations. AUTH + scoped-call only. Hits
    // bsi_app_block_invoked_idx (app_block_id, invoked_at).
    //
    // 🔴 ALL FIVE `block_scope_invocations` READS BELOW EXCLUDE PRIVATE-RUN ROWS, AND THE
    // SET MUST STAY COMPLETE. A private run is a moderator (or the owner, or an accepted
    // collaborator) running a DELISTED app's deployed bundle, and the operator decision is
    // that it must be invisible to that app's owner INCLUDING IN ANALYTICS — a visible
    // review run tells a bad actor exactly when review is happening. The invocation row
    // carries the app's real id and the reviewer's real user id by design, so these
    // `appBlockId IN (ownedIds)` aggregates are precisely where it lands. Miss ONE of the
    // five and the leak survives in whichever number that read feeds: the API-call total,
    // the distinct-active-user count, the error rate's numerator, or either top-5 rollup.
    // The exclusion is spread from `OWNER_VISIBLE_INVOCATION_FILTER` rather than re-spelled
    // per read, so the five cannot drift apart; the population is ledgered by
    // `src/server/services/__tests__/no-unmarked-private-run-invocation.test.ts`.
    //
    // 🔴 READ THAT AS A CLAIM ABOUT ONE TABLE, NOT ABOUT THIS FUNCTION. Two OTHER rails of
    // the same owner-visible payload are covered separately — read the ✅/open marks, not
    // the count:
    //
    //   · ✅ `runs` / `runs.buzzSpent` / `runs.series` — CLOSED, and closed HERE. Both
    //     `block_spend_attribution` reads above exclude `status = 'voided'`, so a private
    //     run's generation row (`voided` / `voidedReason: 'manual_review'`) is neither
    //     counted as a run nor summed. The aggregate spreads `OWNER_VISIBLE_SPEND_FILTER`
    //     and the raw series binds `VOIDED_ATTRIBUTION_STATUS` as a parameter — one
    //     constant, so the two cannot drift. Measured consequence, both directions, in
    //     `__tests__/app-analytics.void-exclusion.test.ts`.
    //     ⚠️ THE TRAP THAT WAS WAITING HERE IS STILL A TRAP, so it stays written down: the
    //     naive narrow spelling `voidedReason: { not: 'manual_review' }` is WRONG — that
    //     column is nullable and NULL is the ordinary `tracked` population, so Prisma's
    //     `not` drops every real row and zeroes the owner's run count. The predicate above
    //     avoids it by keying on `status`, which is `TEXT NOT NULL`. If a future change does
    //     need the reason, use the explicit `OR`-with-`null` form.
    //     🔴 NOT a top-level `NOT` — this line used to say either would do, and the `NOT`
    //     half is wrong: measured 2026-09-29, `NOT (voided_reason IN (…))` retains 0 of 639
    //     rows because `NOT NULL` is NULL. See `VOIDED_ATTRIBUTION_STATUS` above.
    //   · ✅ `views.count` / `views.uniqueViewers` — CLOSED, and closed at the WRITERS
    //     rather than here, so do not go looking for a filter on the ClickHouse read at the
    //     bottom of this `Promise.all`. It was the sharper of the two, because impressions
    //     are the number an app owner looks at most: a private run MOUNTS THE HOST, so it
    //     emitted a render row like any other view, and `app-views.service.ts` computes
    //     uniques as `uniqExactIf(userId, isAnon = 0) + uniqExactIf(ip, isAnon = 1)` — so the
    //     reviewer did not merely inflate a total, they landed as an IDENTIFIABLE unique
    //     viewer on the exact day review happened.
    //
    //     🔴 THE `source` MARKER STRUCTURALLY COULD NOT REACH IT: different store, different
    //     writer, and — measured — NEITHER writer sees a block token at all. The row is
    //     written from a CLIENT beacon (`components/AppBlocks/sendBlockRender.ts` →
    //     `pages/api/track/block-render.ts`) and from `track.router.ts`. So the closure is a
    //     predicate over the SESSION — `blocks/private-run-impression.service.ts` — applied
    //     at the insert in BOTH writers, which suppresses the row instead of marking it.
    //     Reasoning, the shape that was rejected and why, and the over-filtering bound:
    //     the canonical note in `blocks/app-views.service.ts`.
    //
    // ✅ THE ATTRIBUTION RAIL ABOVE IS NO LONGER A FLAG-FLIP PRECONDITION — it shipped, in
    // the same change that added this line. Its remaining ACCEPTANCE step is unchanged and
    // still belongs to whoever widens the flag: one private run against a delisted app, then
    // the operator reads that app's own analytics panel and confirms `runs` /
    // `runs.buzzSpent` did not move. That is a named human judgement over named evidence, and
    // it is the same shape as the `views.count` / `views.uniqueViewers` check for the rail
    // that closed before it. A filter verified by unit test is not the same claim as a
    // private run verified on a real dashboard; do not read one as the other.
    //
    // ⚠️ The predicate names ONE exact value and excludes nothing else. It is deliberately
    // NOT an allowlist (`source: 'app-block'`): over-filtering here silently deletes the
    // owner's REAL usage from their own dashboard, which is the worse failure because
    // nobody reports numbers they never saw. Measured against the live table before
    // shipping: zero of the rows this filter can see carry the marker, so it changes no
    // existing number.
    //
    // 🔴 THE SIBLING `status <> 'voided'` FILTER IS THE OPPOSITE CASE, AND THE CONTRAST IS
    // WORTH KEEPING. It moved ~9 in 10 owner-visible rows (639 to 57 rows, 4,738 to 268
    // Buzz), which is exactly why it was held for months. What unblocked it was measuring
    // the population rather than the proportion: every voided row is an owner spending on
    // their own app, so the drop is entirely self-testing and no real third-party usage row
    // is affected. A big percentage is not the same fact as a big harm — check which rows.
    //
    // 🔴 THE SPREAD COMES FIRST, AND THAT ORDER IS LOAD-BEARING. `appBlockId: idIn` is the
    // ONLY thing scoping these reads to the caller's own apps, and a spread placed LAST
    // wins any key collision — `satisfies Prisma.BlockScopeInvocationWhereInput` constrains
    // the constant's shape, not which keys it may hold, so a later edit adding `appBlockId`
    // to the shared filter would silently replace the ownership scope on four aggregates
    // served to app developers, with no type error and no failing test. Spread first and
    // the explicit keys always win.
    dbRead.blockScopeInvocation.count({
      where: { ...OWNER_VISIBLE_INVOCATION_FILTER, appBlockId: idIn, invokedAt: rangeFilter },
    }),
    dbRead.$queryRaw<Array<{ value: bigint }>>(Prisma.sql`
      SELECT count(DISTINCT "user_id")::bigint AS value
      FROM "block_scope_invocations"
      WHERE "app_block_id" IN (${Prisma.join(ownedIds)})
        AND "invoked_at" >= ${range.from}
        AND "invoked_at" <= ${range.to}
        AND "source" <> ${PRIVATE_RUN_INVOCATION_SOURCE}
    `),
    dbRead.blockScopeInvocation.count({
      where: {
        ...OWNER_VISIBLE_INVOCATION_FILTER,
        appBlockId: idIn,
        invokedAt: rangeFilter,
        statusCode: { gte: 400 },
      },
    }),
    dbRead.blockScopeInvocation.groupBy({
      by: ['scope'],
      where: { ...OWNER_VISIBLE_INVOCATION_FILTER, appBlockId: idIn, invokedAt: rangeFilter },
      _count: true,
      orderBy: { _count: { scope: 'desc' } },
      take: 5,
    }),
    dbRead.blockScopeInvocation.groupBy({
      by: ['endpoint'],
      where: { ...OWNER_VISIBLE_INVOCATION_FILTER, appBlockId: idIn, invokedAt: rangeFilter },
      _count: true,
      orderBy: { _count: { endpoint: 'desc' } },
      take: 5,
    }),

    // IMPRESSIONS — blockRenders (ClickHouse). The only non-Postgres read
    // here; it never throws and is time-bounded, degrading to `unavailable`
    // instead, so neither a ClickHouse outage NOR a slow ClickHouse can take
    // down the whole panel. (It is bounded rather than merely try/caught
    // because this Promise.all is on a per-app-row fan-out path.)
    getAppViews({ appBlockIds: ownedIds, from: range.from, to: range.to }),
  ]);

  const apiCalls = invocationsAgg;
  const activeUsers = Number(distinctUsers[0]?.value ?? 0);
  const errorRate = apiCalls > 0 ? errorCount / apiCalls : 0;
  // Page-only app(s): an install row cannot exist, so the zeros below are a
  // category error rather than a measurement. Omitted (not `false`) when the
  // number IS a measurement, matching `views.unavailable`.
  const notApplicable = installsNotApplicable({
    ownedApps,
    total: installsTotal,
    active: installsActive,
  });

  return {
    range,
    notOwned: false,
    installs: {
      total: installsTotal,
      active: installsActive,
      series: installsSeries.map((r) => ({
        bucket: r.bucket.toISOString(),
        value: Number(r.value),
      })),
      ...(notApplicable ? { notApplicable: true } : {}),
    },
    runs: {
      count: runsAgg._count ?? 0,
      buzzSpent: runsAgg._sum.buzzAmount ?? 0,
      series: runsSeries.map((r) => ({
        bucket: r.bucket.toISOString(),
        value: Number(r.value),
      })),
    },
    buzzPurchased: {
      count: purchasedAgg._count ?? 0,
      buzzAmount: purchasedAgg._sum.buzzAmount ?? 0,
      grossCents: purchasedAgg._sum.usdAmountCents ?? 0,
    },
    engagement: {
      apiCalls,
      activeUsers,
      errorRate,
      topScopes: (topScopes as Array<{ scope: string; _count: number }>).map((r) => ({
        scope: r.scope,
        count: r._count,
      })),
      topEndpoints: (topEndpoints as Array<{ endpoint: string; _count: number }>).map((r) => ({
        endpoint: r.endpoint,
        count: r._count,
      })),
    },
    views,
  };
}

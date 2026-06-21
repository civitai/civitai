import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';

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

export type AnalyticsTimePoint = { bucket: string; value: number };

export type AppAnalytics = {
  /** The resolved range actually queried (after clamping). */
  range: { from: Date; to: Date; granularity: 'day' | 'week' };
  /** True when the caller does not own `appBlockId` — all metrics are zeroed. */
  notOwned: boolean;
  installs: {
    /** All-time installs for this app (subscription rows ever created). */
    total: number;
    /** Currently-active installs (enabled = true), all-time. */
    active: number;
    /** New installs per bucket within the range. */
    series: AnalyticsTimePoint[];
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
};

function emptyAnalytics(range: AppAnalytics['range'], notOwned: boolean): AppAnalytics {
  return {
    range,
    notOwned,
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

/**
 * The app_block ids the caller owns, optionally narrowed to a single
 * requested id. Returns [] when the requested id isn't theirs (or they
 * own nothing) — the callers then fail closed to an empty result.
 */
export async function getOwnedAppBlockIds({
  ownerUserId,
  appBlockId,
}: {
  ownerUserId: number;
  appBlockId?: string;
}): Promise<string[]> {
  const owned = await dbRead.appBlock.findMany({
    where: { app: { userId: ownerUserId } },
    select: { id: true },
  });
  const ownedIds = owned.map((a) => a.id);
  if (!appBlockId) return ownedIds;
  return ownedIds.includes(appBlockId) ? [appBlockId] : [];
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
  const ownedIds = await getOwnedAppBlockIds({ ownerUserId: userId, appBlockId });

  // Fail closed: a specifically-requested id that the caller does not own
  // yields zeroed analytics flagged notOwned (never another owner's data).
  if (appBlockId && ownedIds.length === 0) {
    return emptyAnalytics(range, true);
  }
  // The caller owns nothing — nothing to report (but not "notOwned", since
  // they didn't ask for a specific foreign id).
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
      where: { appBlockId: idIn, attributedAt: rangeFilter },
      _count: true,
      _sum: { buzzAmount: true },
    }),
    dbRead.$queryRaw<Array<{ bucket: Date; value: bigint }>>(Prisma.sql`
      SELECT date_trunc(${truncUnit}, "attributed_at") AS bucket, count(*)::bigint AS value
      FROM "block_spend_attribution"
      WHERE "app_block_id" IN (${Prisma.join(ownedIds)})
        AND "attributed_at" >= ${range.from}
        AND "attributed_at" <= ${range.to}
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
    dbRead.blockScopeInvocation.count({
      where: { appBlockId: idIn, invokedAt: rangeFilter },
    }),
    dbRead.$queryRaw<Array<{ value: bigint }>>(Prisma.sql`
      SELECT count(DISTINCT "user_id")::bigint AS value
      FROM "block_scope_invocations"
      WHERE "app_block_id" IN (${Prisma.join(ownedIds)})
        AND "invoked_at" >= ${range.from}
        AND "invoked_at" <= ${range.to}
    `),
    dbRead.blockScopeInvocation.count({
      where: {
        appBlockId: idIn,
        invokedAt: rangeFilter,
        statusCode: { gte: 400 },
      },
    }),
    dbRead.blockScopeInvocation.groupBy({
      by: ['scope'],
      where: { appBlockId: idIn, invokedAt: rangeFilter },
      _count: true,
      orderBy: { _count: { scope: 'desc' } },
      take: 5,
    }),
    dbRead.blockScopeInvocation.groupBy({
      by: ['endpoint'],
      where: { appBlockId: idIn, invokedAt: rangeFilter },
      _count: true,
      orderBy: { _count: { endpoint: 'desc' } },
      take: 5,
    }),
  ]);

  const apiCalls = invocationsAgg;
  const activeUsers = Number(distinctUsers[0]?.value ?? 0);
  const errorRate = apiCalls > 0 ? errorCount / apiCalls : 0;

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
  };
}

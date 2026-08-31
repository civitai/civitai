import { dbRead } from '~/server/db/client';
import {
  listingKindSupports,
  resolveListingAccess,
  resolveAccessibleAppBlockIds,
} from '~/server/services/blocks/app-access.service';
import type { RevenueSummary } from '~/server/services/blocks/buzz-attribution.service';

/**
 * App Listing COLLABORATORS — the APP-SCOPED earnings read.
 *
 * 🔴 THIS MODULE EXISTS BECAUSE THE OBVIOUS IMPLEMENTATION LEAKS THE OWNER'S WHOLE
 * PORTFOLIO. Read this before touching it.
 *
 * Product decision: an editor is effectively a co-owner and DOES see earnings/payout
 * data — but only for the app they were seated on.
 *
 * Every pre-existing earnings read is keyed on `BlockBuzzAttribution.appOwnerUserId`,
 * a USER-WIDE filter:
 *
 *   `blocks.getMyApps`  (blocks.router.ts:5488-5496)
 *       groupBy appBlockId WHERE appOwnerUserId = caller  — no app filter at all
 *   `getRevenueForOwner` / `getRecentAttributionsForOwner`  (buzz-attribution.service)
 *       WHERE appOwnerUserId = caller, with `appBlockId` an OPTIONAL narrowing filter
 *       that is never checked against what the caller may actually see
 *   `getOwnedAppBlocks`  (app-analytics.service.ts:252)
 *       WHERE app.userId = caller
 *
 * The NAIVE way to serve an editor is to reuse one of those with the OWNER's id (the
 * editor has no attribution rows of their own, so passing the editor's id returns
 * nothing). That hands the editor **every app the owner has ever published**, because
 * `appOwnerUserId` does not mention the app. It looks right in a one-app fixture and
 * is catastrophic with two.
 *
 * So the rule here, with no exceptions:
 *
 *   🔴 RESOLVE THE PERMITTED APP IDS FIRST, THEN FILTER BY `appBlockId IN (thatSet)`.
 *      Never filter a collaborator-reachable money query by `appOwnerUserId` alone.
 *
 * `app-collaborator-earnings.service.test.ts` fixtures an owner with TWO apps and an
 * editor seated on ONE, and asserts the second never appears. That test was written
 * against a deliberately naive implementation first and watched to FAIL before this
 * one was written.
 *
 * ## The second scope: whose earnings, not just which app
 *
 * `appOwnerUserId` is SNAPSHOTTED at attribution time and is deliberately NOT rewritten
 * by an ownership transfer (Buzz stays with the old owner — see
 * `app-ownership-transfer.service`). So an app-scoped query on `appBlockId` ALONE would
 * show a new owner (and their editors) the PREVIOUS owner's pre-transfer earnings.
 * Both scopes are therefore applied: the app must be one the caller may see, AND the
 * rows must belong to the app's CURRENT owner. That is the same forward-cut the
 * transfer decision describes, enforced on the read side.
 *
 * ## The third scope: KIND
 *
 * 🔴 EARNINGS ARE BLOCK-SCOPED AND THEREFORE ON-SITE ONLY. `BlockBuzzAttribution` keys
 * on `appBlockId`; an OFF-SITE listing has no AppBlock, so no attribution row can ever
 * belong to it. That is a structural fact, not a policy toggle, and it is the
 * `earnings: false` cell of `CAPABILITIES_BY_KIND`.
 *
 * The refusal is EXPLICIT (`unsupportedKind`), never a zeroed summary. A zero here
 * would be indistinguishable from "this app earned nothing" — the exact silent-zero
 * shape this codebase keeps paying for — and would teach an off-site developer that
 * their listing earns and simply has not yet.
 */

export type AppScopedRevenue = {
  appBlockId: string;
  summary: RevenueSummary;
};

const EMPTY_BUCKET = { count: 0, grossCents: 0, shareCents: 0 };
const EMPTY_SUMMARY: RevenueSummary = {
  pending: EMPTY_BUCKET,
  confirmed: EMPTY_BUCKET,
  paidOut: EMPTY_BUCKET,
  voided: { count: 0, grossCents: 0 },
};

export type AppEarningsResult =
  | {
      ok: true;
      appListingId: string;
      appBlockId: string;
      role: 'owner' | 'editor';
      summary: RevenueSummary;
    }
  /**
   * `notPermitted` is a REAL, reachable state (unlike revenue's deliberately-absent
   * `notOwned`): a collaborator-reachable read genuinely does compute access, so the
   * caller can be told "you may not see this" rather than handed a zero that is
   * indistinguishable from "this app earned nothing".
   *
   * `unsupportedKind` is the OFF-SITE refusal — the listing exists and the caller may
   * well be its owner, but earnings are structurally block-scoped. Also explicit, for
   * the same never-a-silent-zero reason.
   */
  | {
      ok: false;
      appListingId: string;
      reason: 'notPermitted' | 'notFound' | 'unsupportedKind';
    };

/**
 * Earnings for ONE listing, readable by its owner OR an accepted collaborator.
 *
 * Fail-closed: a listing the caller has no role on returns `notPermitted` WITHOUT
 * running any aggregate — the caller never learns anything about a stranger's app, not
 * even its totals. An OFF-SITE listing returns `unsupportedKind`, also without an
 * aggregate (there is no id to aggregate on).
 */
export async function getAppEarnings(opts: {
  appListingId: string;
  userId: number;
  from?: Date;
  to?: Date;
}): Promise<AppEarningsResult> {
  const access = await resolveListingAccess(opts.appListingId, opts.userId);
  if (!access) return { ok: false, appListingId: opts.appListingId, reason: 'notFound' };
  if (!access.role) return { ok: false, appListingId: opts.appListingId, reason: 'notPermitted' };
  // 🔴 KIND GATE. TWO INDEPENDENT clauses, OR-ed so that EITHER ONE refuses on its own:
  // the declared capability table says off-site has no earnings, and the resolved
  // `appBlockId` is the physical reason it cannot. They agree on the common shapes and
  // DISAGREE on two that are both reachable, which is why neither clause may be dropped:
  //
  //   - kind 'offsite' WITH a block — `mapAppBlockToListing` mints this for any AppBlock
  //     carrying an `externalUrl` (reachable via the mod proc `backfillAppListings`).
  //     Only the KIND clause refuses it, and dropping it would return REAL money figures
  //     for a listing whose kind declares `earnings: false`.
  //   - kind 'onsite' WITHOUT a block — a listing whose backing AppBlock row is missing
  //     or not yet linked. Only the BLOCK clause refuses it; dropping it would run the
  //     aggregate with `appBlockId: null`.
  //
  // `app-collaborator-earnings.service.test.ts` fixtures BOTH shapes, so the `||`→`&&`
  // mutant (which requires both clauses to fire before refusing) dies on each of them.
  if (!listingKindSupports(access.kind, 'earnings') || !access.appBlockId) {
    return { ok: false, appListingId: opts.appListingId, reason: 'unsupportedKind' };
  }
  const appBlockId = access.appBlockId;

  const where = {
    // 🔴 BOTH scopes. See the module header — dropping either one is the leak.
    appBlockId,
    appOwnerUserId: access.ownerUserId,
    ...(opts.from || opts.to
      ? {
          attributedAt: {
            ...(opts.from ? { gte: opts.from } : {}),
            ...(opts.to ? { lte: opts.to } : {}),
          },
        }
      : {}),
  };

  const [pending, confirmed, paidOut, voided] = await Promise.all([
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'pending' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'confirmed' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'paid_out' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'voided' },
      _sum: { usdAmountCents: true },
      _count: true,
    }),
  ]);

  type Agg = {
    _count?: number;
    _sum: { usdAmountCents?: number | null; appOwnerShareCents?: number | null };
  };
  const bucket = (a: Agg) => ({
    count: a._count ?? 0,
    grossCents: a._sum.usdAmountCents ?? 0,
    shareCents: a._sum.appOwnerShareCents ?? 0,
  });

  return {
    ok: true,
    appListingId: opts.appListingId,
    appBlockId,
    role: access.role,
    summary: {
      pending: bucket(pending as Agg),
      confirmed: bucket(confirmed as Agg),
      paidOut: bucket(paidOut as Agg),
      voided: {
        count: (voided as Agg)._count ?? 0,
        grossCents: (voided as Agg)._sum.usdAmountCents ?? 0,
      },
    },
  };
}

export type MyAppsEarningsRow = {
  appBlockId: string;
  role: 'owner' | 'editor';
  lifetimeShareCents: number;
  lifetimeCount: number;
};

/**
 * Lifetime per-app earnings across every app the caller may see (owned + seated) —
 * the collaborator-aware replacement for `getMyApps`' portfolio-wide groupBy.
 *
 * 🔴 The groupBy is filtered by `appBlockId IN allIds`, NOT by `appOwnerUserId`. For
 * an OWNER those two happen to coincide today, which is exactly why the distinction
 * has to be written down: the moment an editor calls this, `appOwnerUserId` would be
 * the wrong axis and would return either nothing (their own id) or everything (the
 * owner's id). Neither is the answer.
 *
 * Ownership per row is resolved from the CURRENT owner, so a transferred app's
 * pre-transfer rows are excluded for exactly the reason in the module header.
 */
export async function getMyAppsEarnings(opts: { userId: number }): Promise<MyAppsEarningsRow[]> {
  const { ownedIds, editorIds, allIds } = await resolveAccessibleAppBlockIds(opts.userId);
  if (allIds.length === 0) return [];

  // Current owner per accessible app — the second scope axis.
  const blocks = await dbRead.appBlock.findMany({
    where: { id: { in: allIds } },
    select: { id: true, app: { select: { userId: true } } },
  });
  const ownerByApp = new Map<string, number>(
    blocks
      .filter((b: { app: { userId: number } | null }) => !!b.app)
      .map((b: { id: string; app: { userId: number } | null }) => [b.id, b.app!.userId])
  );

  // 🔴 GROUPED BY (appBlockId, appOwnerUserId), not appBlockId alone. The second key is
  // what lets a transferred app's PRE-transfer rows be dropped below — grouping on the
  // app alone would silently fold a previous owner's earnings into the current one's.
  const rows = (await dbRead.blockBuzzAttribution.groupBy({
    by: ['appBlockId', 'appOwnerUserId'] as const,
    where: { appBlockId: { in: allIds }, status: { in: ['confirmed', 'paid_out'] } },
    _sum: { appOwnerShareCents: true },
    _count: true,
  } as never)) as unknown as Array<{
    appBlockId: string;
    appOwnerUserId: number;
    _sum: { appOwnerShareCents: number | null };
    _count: number;
  }>;

  const totals = new Map<string, { shareCents: number; count: number }>();
  for (const r of rows) {
    // Drop rows attributed to a PREVIOUS owner of a transferred app.
    if (ownerByApp.get(r.appBlockId) !== r.appOwnerUserId) continue;
    const prev = totals.get(r.appBlockId) ?? { shareCents: 0, count: 0 };
    totals.set(r.appBlockId, {
      shareCents: prev.shareCents + (r._sum.appOwnerShareCents ?? 0),
      count: prev.count + r._count,
    });
  }

  const ownedSet = new Set(ownedIds);
  const editorSet = new Set(editorIds);
  return allIds.map((id) => ({
    appBlockId: id,
    role: ownedSet.has(id)
      ? ('owner' as const)
      : editorSet.has(id)
      ? ('editor' as const)
      : ('owner' as const),
    lifetimeShareCents: totals.get(id)?.shareCents ?? 0,
    lifetimeCount: totals.get(id)?.count ?? 0,
  }));
}

/** Exposed for the empty/unavailable render path so a caller never invents a shape. */
export const emptyAppRevenueSummary = EMPTY_SUMMARY;

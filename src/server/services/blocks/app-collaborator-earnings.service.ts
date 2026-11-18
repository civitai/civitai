import {
  listingKindSupports,
  resolveListingAccess,
  resolveAccessibleAppBlockIds,
} from '~/server/services/blocks/app-access.service';
import {
  getAuthorFeeEarningsForOwner,
  type AuthorFeeEarnings,
} from '~/server/services/blocks/author-fee-earnings.service';
import {
  getGoodsSalesForOwner,
  unreadableIfGoodsTableMissing,
  type GoodsSalesSummary,
} from '~/server/services/blocks/buzz-attribution.service';

/**
 * App Listing COLLABORATORS — the APP-SCOPED earnings read.
 *
 * 🔴 THIS MODULE EXISTS BECAUSE THE OBVIOUS IMPLEMENTATION LEAKS THE OWNER'S WHOLE
 * PORTFOLIO. Read this before touching it.
 *
 * Product decision: an editor is effectively a co-owner and DOES see earnings/payout
 * data — but only for the app they were seated on.
 *
 * The owner earnings reads are keyed on the snapshotted `appOwnerUserId`, a USER-WIDE
 * filter:
 *
 *   `blocks.getMyRevenue`  (`getAuthorFeeEarningsForOwner`, `getGoodsSalesForOwner`)
 *       WHERE appOwnerUserId = caller, with `appBlockId` an OPTIONAL narrowing filter
 *       that is never checked against what the caller may actually see
 *   `getOwnedAppBlocks`  (app-analytics.service.ts)
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
 * `appOwnerUserId` is SNAPSHOTTED when a fee accrues or a sale settles, and is deliberately NOT rewritten
 * by an ownership transfer (Buzz stays with the old owner — see
 * `app-ownership-transfer.service`). So an app-scoped query on `appBlockId` ALONE would
 * show a new owner (and their editors) the PREVIOUS owner's pre-transfer earnings.
 * Both scopes are therefore applied: the app must be one the caller may see, AND the
 * rows must belong to the app's CURRENT owner. That is the same forward-cut the
 * transfer decision describes, enforced on the read side.
 *
 * ## The third scope: KIND
 *
 * 🔴 EARNINGS ARE BLOCK-SCOPED AND THEREFORE ON-SITE ONLY. Author fees and goods sales key
 * on `appBlockId`; an OFF-SITE listing has no AppBlock, so no row can ever belong to it. That is a structural fact, not a policy toggle, and it is the
 * `earnings: false` cell of `CAPABILITIES_BY_KIND`.
 *
 * The refusal is EXPLICIT (`unsupportedKind`), never a zeroed summary. A zero here
 * would be indistinguishable from "this app earned nothing" — the exact silent-zero
 * shape this codebase keeps paying for — and would teach an off-site developer that
 * their listing earns and simply has not yet.
 */

export type AppEarningsResult =
  | {
      ok: true;
      appListingId: string;
      appBlockId: string;
      role: 'owner' | 'editor';
      authorFees: AuthorFeeEarnings;
      goods: GoodsSalesSummary;
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

  // 🔴 BOTH scopes for both reads: this app, and rows owed to its CURRENT owner — never the
  // caller's id. See the module header; dropping either one is the leak.
  const ownerUserId = access.ownerUserId;
  const [authorFees, goods] = await Promise.all([
    // The app's CURRENT owner, not the caller: owner and editors see the same whole-app
    // figure, and a transferred app shows only what accrued to the owner now holding it.
    getAuthorFeeEarningsForOwner({ ownerUserId, appBlockId, from: opts.from, to: opts.to }),
    unreadableIfGoodsTableMissing(
      getGoodsSalesForOwner({ ownerUserId, appBlockId, from: opts.from, to: opts.to }),
      { appBlockId }
    ),
  ]);

  return {
    ok: true,
    appListingId: opts.appListingId,
    appBlockId,
    role: access.role,
    authorFees,
    goods,
  };
}

export type MyAppRole = {
  appBlockId: string;
  role: 'owner' | 'editor';
};

/**
 * Every app the caller may see (owned + seated), with their role on it — what `getMyApps` lists.
 *
 * 🔴 The set comes from `resolveAccessibleAppBlockIds`, never from an `appOwnerUserId` filter:
 * for an editor that axis would return either nothing (their own id) or the owner's whole
 * portfolio (the owner's id). It reads no money: the lifetime card-purchase share it used to
 * aggregate is no longer shown anywhere.
 */
export async function getMyAppRoles(opts: { userId: number }): Promise<MyAppRole[]> {
  const { ownedIds, editorIds, allIds } = await resolveAccessibleAppBlockIds(opts.userId);
  const ownedSet = new Set(ownedIds);
  const editorSet = new Set(editorIds);
  return allIds.map((id) => ({
    appBlockId: id,
    role: ownedSet.has(id)
      ? ('owner' as const)
      : editorSet.has(id)
      ? ('editor' as const)
      : ('owner' as const),
  }));
}

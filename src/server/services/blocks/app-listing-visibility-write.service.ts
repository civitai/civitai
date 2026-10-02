/**
 * App Store Listings — setting a listing's per-listing VISIBILITY LEVEL.
 *
 * 🔴 SEPARATE MODULE FROM THE GUARDED READER (`app-listing-visibility.service.ts`), and
 * the split is structural rather than stylistic. That module is imported by
 * `app-listing.service.ts`, which is the public `/apps` store read path; this one pulls
 * `dbWrite`, the role resolver and the moderation-event id helper. Putting the write
 * beside the read would drag all three into the hot read path's module graph.
 *
 * 🔴 TWO ENTRY POINTS, NOT ONE FUNCTION WITH AN `asModerator` FLAG. A boolean argument
 * that selects between "resolve the caller's role" and "trust the caller" is an
 * authorization decision the CALLER makes, and every call site then has to be audited to
 * see which it passed. Two exported functions make the gate a property of which symbol you
 * imported: the owner path cannot skip the role resolve, and the moderator path has no
 * role resolve to be handed a wrong argument for.
 *
 * 🔴 THE STATUS GATE IS ENFORCED HERE, NOT INFERRED FROM THE ROLE RESOLVER.
 * `resolveListingAccess` applies NO status filter — its own header says so in as many
 * words, and a caller that needs a status must read it itself. So D1 ("levels apply to
 * non-suspended listings only") is a check in {@link applyVisibility} against
 * `VISIBILITY_ELIGIBLE_LISTING_STATUSES`, plus the backing block's own suspension.
 */

import { TRPCError } from '@trpc/server';

import { dbWrite } from '~/server/db/client';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';
import {
  assertVisibilityWritable,
  readListingVisibility,
} from '~/server/services/blocks/app-listing-visibility.service';
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';
import {
  isVisibilityEligibleListingStatus,
  VISIBILITY_ELIGIBLE_LISTING_STATUSES,
} from '~/shared/utils/app-listing-visibility';

/** What a level change reports back. `changed: false` is a successful no-op, not a
 *  failure — the caller asked for a state the listing is already in. */
export type SetListingVisibilityResult = {
  appListingId: string;
  visibility: AppListingVisibility;
  changed: boolean;
};

/**
 * The refusal an INELIGIBLE listing status produces.
 *
 * 🔴 IT DOES NOT NAME THE STATUS, AND THAT IS DELIBERATE on the moderator path as well as
 * the owner path. The owner already knows their listing is down; a moderator reads the
 * status from the row they are looking at. Naming it here would make this message the one
 * place in the feature that distinguishes "removed" from "rejected" to whoever can reach
 * the proc, and a refusal message is the easiest surface to forget when the audience of a
 * proc widens later.
 */
export const VISIBILITY_STATUS_INELIGIBLE_MESSAGE =
  'This listing is not in a state where its visibility can be changed.';

/** The refusal a SUSPENDED backing block produces. Same no-detail posture as above. */
export const VISIBILITY_BLOCK_SUSPENDED_MESSAGE =
  'This app is suspended, so its listing visibility cannot be changed.';

/** The refusal a caller with no role on the listing produces. */
export const VISIBILITY_NOT_OWNED_MESSAGE = 'You can only change your own listings.';

/**
 * The shared core: gate on D1, then write.
 *
 * 🔴 THE WRITE IS A COMPARE-AND-SET, NOT A BARE `update`. It re-asserts the eligible
 * status set in the `where` clause, so a concurrent delist landing between the read above
 * and this write cannot be overtaken — `updateMany` matching zero rows is the signal, and
 * it is turned into the same refusal the pre-read produces rather than reported as
 * success. This is the shape `delistListing` uses for every status transition in
 * `offsite-moderation.service.ts`, and the reason is identical: a read-then-write on a row
 * a moderator may be acting on at the same moment is a race, and the race's losing side
 * must not be silent.
 *
 * 🔴 `changed: false` IS DISTINGUISHED FROM `count === 0`. A level that is already the
 * requested one is an idempotent success (the `setReviewExclude` precedent); zero matched
 * rows after a status re-check is a REFUSAL. Collapsing the two would report success for a
 * listing that was taken down a millisecond ago.
 */
async function applyVisibility(args: {
  appListingId: string;
  visibility: AppListingVisibility;
  /** Present ⇒ write a `set-visibility` moderation event attributed to this actor. */
  moderatorUserId?: number;
}): Promise<SetListingVisibilityResult> {
  const { appListingId, visibility, moderatorUserId } = args;

  // 🔴 THE PRIMARY, NOT THE REPLICA. A freshly-delisted or freshly-relisted row read
  // through a replication-lag window would be gated on a stale status — in both
  // directions. Same argument `resolvePrivateRunAccess` makes for threading its pool.
  const listing = await dbWrite.appListing.findUnique({
    where: { id: appListingId },
    select: {
      id: true,
      slug: true,
      status: true,
      // The backing block's own suspension. Null for an offsite listing, which has no
      // block and therefore no block-level suspension to respect.
      appBlock: { select: { status: true } },
    },
  });
  if (!listing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Listing not found' });

  // D1, half one: the listing's own lifecycle. `removed` and `rejected` are refused.
  if (!isVisibilityEligibleListingStatus(listing.status)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_STATUS_INELIGIBLE_MESSAGE });
  }
  // D1, half two: a suspended BLOCK. A delist flips both the listing status and the
  // backing block's, so this is normally redundant — but it is the half that holds if a
  // block is ever suspended through a path that leaves the listing row alone, and "levels
  // apply to non-suspended listings only" is a claim about the app, not only the row.
  if (listing.appBlock?.status === 'suspended') {
    throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_BLOCK_SUSPENDED_MESSAGE });
  }

  // The manual-apply column. Refuses rather than silently dropping the write — the caller
  // picked this level and expects to see it again.
  const before = await readListingVisibility(appListingId, dbWrite);
  assertVisibilityWritable(before.available);
  if (before.visibility === visibility) {
    return { appListingId, visibility, changed: false };
  }

  await dbWrite.$transaction(async (tx) => {
    const flipped = await tx.appListing.updateMany({
      where: {
        id: appListingId,
        // 🔴 DERIVED, NOT A SECOND LITERAL. This re-asserts the gate inside the write so a
        // concurrent takedown wins the race — but a hardcoded list would silently fall out
        // of step with the allowlist the READ uses, and the failure mode is a misdiagnosis:
        // `updateMany` would match zero rows and the refusal would surface from the
        // CONCURRENCY branch below, reporting a stale allowlist as a race.
        status: { in: [...VISIBILITY_ELIGIBLE_LISTING_STATUSES] },
      },
      data: { visibility },
    });
    if (flipped.count === 0) {
      throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_STATUS_INELIGIBLE_MESSAGE });
    }
    if (moderatorUserId != null) {
      await tx.appListingModerationEvent.create({
        data: {
          id: newAppListingModerationEventId(),
          appListingId,
          slug: listing.slug,
          action: 'set-visibility',
          actorUserId: moderatorUserId,
          before: { visibility: before.visibility },
          after: { visibility },
          detail: `visibility ${before.visibility} -> ${visibility}`,
        },
      });
    }
  });

  // The cached store catalog keys on which rows a cohort sees, and this write moves
  // exactly that. Fire-and-forget by this module's convention: a cache-bus outage must
  // never fail a mutation that already committed.
  // 🔴 AWAITED AND CAUGHT, matching all 21 other call sites. A bare `void` here would be
  // the only unhandled one: `bustCacheTag` can reject on a cache-bus fault, and with
  // nothing awaiting it that rejection has nowhere to go but `unhandledRejection`. Catching
  // rather than propagating is the same trade every sibling makes — a stale grid for at
  // most the TTL beats a mutation that reports failure after having committed.
  const { bustAppListingCatalogCache } = await import(
    '~/server/services/blocks/app-listing.service'
  );
  await bustAppListingCatalogCache().catch(() => undefined);

  return { appListingId, visibility, changed: true };
}

/**
 * OWNER path — set the level on a listing the caller holds a role on.
 *
 * Admits the OWNER **or an accepted collaborator (editor)**, because that is what
 * `resolveListingAccess` returns a non-null role for and what every other owner-side
 * listing edit in this feature already admits (`updateListing` → `loadOwnedEditableListing`
 * takes the same `role !== null` test). Narrowing to owner-only here would make this the
 * one authored field an accepted editor cannot touch, which is a separate decision from
 * the four this change implements.
 *
 * 🔴 NO MODERATOR BYPASS ON THIS PATH, deliberately — `updateListing`'s own resolver has
 * none either, and the divergence between it and `app-listing-assets.service`'s
 * mod-bypassing loader is recorded in the access call-site ledger. A moderator uses
 * {@link setListingVisibilityAsModerator}, which writes an audit event; letting them in
 * here would be an unaudited moderator write on someone else's listing.
 */
export async function setListingVisibilityAsOwner(args: {
  appListingId: string;
  visibility: AppListingVisibility;
  userId: number;
}): Promise<SetListingVisibilityResult> {
  const { resolveListingAccess } = await import('~/server/services/blocks/app-access.service');
  // `dbWrite` so a seat accepted moments ago is visible — the same reason the status read
  // below uses the primary.
  // 🔴 NO CAST. `dbWrite` assigns to this parameter cleanly (`app-listing-assets.service`
  // passes it the same way), and the double cast this line used to carry would have
  // defeated the only compile-time check on a SECURITY argument — the one that says this
  // is the role resolver's db handle and not some other client.
  const access = await resolveListingAccess(args.appListingId, args.userId, dbWrite);
  // A missing row and a caller with no role produce the SAME refusal. Distinguishing them
  // would turn this proc into an existence oracle over listing ids.
  if (!access || access.role == null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_NOT_OWNED_MESSAGE });
  }
  return applyVisibility({ appListingId: args.appListingId, visibility: args.visibility });
}

/**
 * MODERATOR path — set the level on ANY listing, with an audit event.
 *
 * 🔴 THIS FUNCTION PERFORMS NO ROLE CHECK AND MUST NOT BE CALLED WITHOUT ONE. Its gate is
 * the router's `moderatorProcedure` plus the inner `ctx.user.isModerator` recheck, which is
 * the shape every moderator mutation in `app-listings.router.ts` uses. `moderatorUserId`
 * is bound from `ctx.user.id` at that call site and is never client-supplied — it is the
 * actor on the audit row.
 *
 * D1 still applies: a moderator may not set a level on a `removed` or `rejected` listing
 * either. The decision is that levels govern non-suspended listings, not that moderators
 * are exempt from it — a taken-down listing's only path is private-run, for everyone.
 */
export async function setListingVisibilityAsModerator(args: {
  appListingId: string;
  visibility: AppListingVisibility;
  moderatorUserId: number;
}): Promise<SetListingVisibilityResult> {
  return applyVisibility({
    appListingId: args.appListingId,
    visibility: args.visibility,
    moderatorUserId: args.moderatorUserId,
  });
}

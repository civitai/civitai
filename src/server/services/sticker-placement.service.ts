import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  holdPlacementEscrow,
  settlePlacement,
  MAX_LEG_ATTEMPTS,
} from '~/server/services/placement-escrow.service';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { spendStickerUsesFor } from '~/server/services/sticker.service';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { PlacementStatus } from '~/shared/utils/placement';
import type {
  PlacementSettlementState,
  StickerPlacementData,
} from '~/shared/utils/sticker-placement';
import {
  isStickerPlacementData,
  normalizeStickerPlacement,
} from '~/shared/utils/sticker-placement';

const SURFACE = 'sticker' as const;
const TARGET_TYPE = 'image' as const;

/**
 * How many pending placements one placer may have waiting on one owner.
 *
 * A cap rather than a rate limit: the cost is already real Buzz, so this is not
 * about spam economics but about a review queue an owner can actually work
 * through. Their remedy for the rest is block, which declines all of them.
 */
const MAX_PENDING_PER_OWNER = 10;

/**
 * The sticker the placer chose, from the primary, with ownership resolved.
 *
 * `userOwnedStickerCache` is a Redis cache over a `dbRead` replica. That is the
 * right thing for deciding whether to show a sticker in the picker and the wrong
 * thing here — this is a mutation guard, and a revocation committed seconds ago
 * must refuse rather than be filtered out one render later. Same distinction as
 * `assertCanPlace` versus `getBlockedPairIds`; keep both.
 */
async function loadPlaceableSticker({
  cosmeticId,
  placerId,
}: {
  cosmeticId: number;
  placerId: number;
}) {
  const [cosmetic] = await dbWrite.$queryRaw<
    { id: number; createdById: number | null; owned: boolean }[]
  >`
    SELECT c.id, c."createdById",
           EXISTS (
             SELECT 1 FROM "UserCosmetic" uc
             WHERE uc."cosmeticId" = c.id AND uc."userId" = ${placerId}
           ) AS owned
    FROM "Cosmetic" c
    WHERE c.id = ${cosmeticId} AND c.type = 'Sticker'::"CosmeticType"
  `;

  if (!cosmetic) throw throwBadRequestError('placement: that sticker no longer exists');
  if (!cosmetic.owned) throw throwAuthorizationError('placement: you do not own that sticker');

  return cosmetic;
}

export type CreateStickerPlacement = {
  placerId: number;
  imageId: number;
  data: Omit<StickerPlacementData, 'cosmeticId'> & { cosmeticId: number };
};

/**
 * Places a sticker on an image, charging a use and the owner's price.
 *
 * Every guard here refuses on the mutation. A listing that filters is not a
 * mutation that refuses, and v1 shipped that mistake five times.
 *
 * **Ordering, which is the whole design of this function:**
 *
 * The placement row has to be committed before the escrow can be taken — its id
 * is a parameter to the hold, and the hold's ledger rows carry a foreign key to
 * it. So "create and hold in one transaction" is not available, and threading a
 * transaction through would be worse: it would put a Buzz call inside an open
 * Prisma transaction, and the hold's claim rows are *designed* to outlive the
 * caller so the sweeper can finish what a crash interrupted. Rolling them back
 * destroys the evidence recovery depends on.
 *
 * So the row is created, the escrow is taken, and anything that throws after the
 * row exists expires it. Expiry refunds both holds in full through real refunds
 * of real holds, so a partial hold reverses in the exact currency mix it was
 * drawn from, and the row lands in a terminal state nobody sees. If that
 * compensating settle also fails — Buzz still down — `holdPlacementEscrow` has
 * already stamped `expiresAt`, so the expiry job reaches it anyway.
 *
 * The use is spent *after* the escrow lands, so a failed charge cannot consume
 * one. The pre-check below is a courtesy refusal; the spend is the authority,
 * and it is all-or-nothing under `FOR UPDATE`.
 */
export async function createStickerPlacement({ placerId, imageId, data }: CreateStickerPlacement) {
  const space = await resolvePlacementSpaceFor({
    surface: SURFACE,
    targetType: TARGET_TYPE,
    targetId: imageId,
  });

  if (space.mode === 'off')
    throw throwBadRequestError('placement: this creator is not accepting stickers here');

  // Placing on your own content would charge you and pay you, minus the
  // platform's cut — a fee for decorating your own image. Refused rather than
  // priced at zero: free self-placement is a product decision, and allowing it
  // later is additive where charging for it wrongly is not.
  if (space.ownerId === placerId)
    throw throwBadRequestError('placement: you cannot place a sticker on your own content');

  if (space.price == null)
    throw throwBadRequestError('placement: this creator has not set a price yet');

  await assertCanPlace({ ownerId: space.ownerId, placerId });

  const pending = await dbWrite.placement.count({
    where: { surface: SURFACE, ownerId: space.ownerId, placerId, status: 'pending' },
  });
  if (pending >= MAX_PENDING_PER_OWNER)
    throw throwBadRequestError(
      'placement: you already have the maximum pending placements with this creator'
    );

  const sticker = await loadPlaceableSticker({ cosmeticId: data.cosmeticId, placerId });
  await assertHasUse({ userId: placerId, cosmeticId: sticker.id });

  const placement = await dbWrite.placement.create({
    data: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: imageId,
      ownerId: space.ownerId,
      placerId,
      // The seller lives on the row rather than being passed to settlement,
      // which is resumable: a sweeper that never saw the argument would strand
      // their share with no record anyone was owed.
      sellerId: sticker.createdById,
      amount: space.price,
      status: 'pending',
      data: {
        cosmeticId: sticker.id,
        ...normalizeStickerPlacement(data),
      },
    },
    select: { id: true },
  });

  try {
    await holdPlacementEscrow({
      placementId: placement.id,
      placerId,
      surface: SURFACE,
      amount: space.price,
    });

    await spendStickerUsesFor({ userId: placerId, counts: new Map([[sticker.id, 1]]) });
  } catch (error) {
    await settlePlacement({ placementId: placement.id, action: 'expire' }).catch((settleError) =>
      // Not swallowed silently: the row still has a deadline, so the expiry job
      // will reach it, but a compensating settle that fails means Buzz is held
      // for a placement the user was told failed.
      logToAxiom({
        name: 'sticker-placement',
        type: 'error',
        message: 'could not unwind a placement whose escrow failed',
        placementId: placement.id,
        error: (settleError as Error).message,
      }).catch(() => null)
    );
    throw error;
  }

  // `auto` settles immediately, which is what makes the placement live. `review`
  // leaves it pending, visible only to its placer, until the owner acts.
  if (space.mode === 'auto')
    await settlePlacement({ placementId: placement.id, action: 'approve', actorId: space.ownerId });

  return { placementId: placement.id, status: space.mode === 'auto' ? 'approved' : 'pending' };
}

/**
 * A courtesy refusal before any money moves. The spend after the escrow is the
 * authority — this only exists so "you're out of uses" arrives before a charge
 * and a refund rather than as a surprising round trip.
 */
async function assertHasUse({ userId, cosmeticId }: { userId: number; cosmeticId: number }) {
  const [balance] = await dbWrite.$queryRaw<{ spendable: number | null; unlimited: boolean }[]>`
    SELECT SUM("remaining")::int AS spendable, bool_or("remaining" IS NULL) AS unlimited
    FROM "UserCosmetic"
    WHERE "userId" = ${userId} AND "cosmeticId" = ${cosmeticId}
  `;

  if (!balance?.unlimited && (balance?.spendable ?? 0) < 1)
    throw throwBadRequestError(
      "You don't have any uses left on that sticker. Buy more to keep placing it."
    );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type StickerPlacementView = {
  id: number;
  imageId: number;
  placerId: number;
  ownerId: number;
  status: PlacementStatus;
  amount: number;
  data: StickerPlacementData;
  /** True only for the placer's own placement awaiting the owner. */
  isPending: boolean;
};

/**
 * Who placed one sticker, and when.
 *
 * Its own query rather than a wider `getStickerPlacements`: that one runs for
 * every image on a feed page, and joining a user onto every placement would pay
 * for the hover card on every sticker nobody hovers.
 *
 * The visibility rule is repeated here on purpose. It matches
 * `getStickerPlacements`, but a caller reaching this with an id it guessed has
 * not been through that query, so leaving the check to the listing would make
 * every pending placement's placer readable by anyone who could count.
 */
export async function getStickerPlacementDetail({
  placementId,
  viewerId,
}: {
  placementId: number;
  viewerId?: number;
}) {
  const placement = await dbRead.placement.findFirst({
    where: {
      id: placementId,
      surface: SURFACE,
      OR: [
        { status: 'approved' },
        ...(viewerId ? [{ status: 'pending' as const, placerId: viewerId }] : []),
      ],
    },
    select: {
      id: true,
      createdAt: true,
      status: true,
      placer: { select: userWithCosmeticsSelect },
    },
  });

  if (!placement) throw throwNotFoundError('placement: that placement is not available');

  return {
    id: placement.id,
    // When they placed it, not when it was approved: the question the card
    // answers is who put this here and when, and an owner sitting on a review
    // queue for two days did not change that.
    placedAt: placement.createdAt,
    status: placement.status as PlacementStatus,
    placer: placement.placer,
  };
}

/**
 * Approved placements for a set of images, plus the viewer's own pending ones.
 *
 * The pending row is deliberately in the same payload rather than a second call:
 * the placer sees their own submission rendered faint while it waits, and
 * nobody else sees it at all. Splitting it into its own query is how a surface
 * ends up rendering someone else's pending placement on a page that forgot to
 * filter.
 */
export async function getStickerPlacements({
  imageIds,
  viewerId,
}: {
  imageIds: number[];
  viewerId?: number;
}): Promise<StickerPlacementView[]> {
  if (!imageIds.length) return [];

  const rows = await dbRead.placement.findMany({
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: { in: imageIds },
      OR: [
        { status: 'approved' },
        // A pending placement is visible to the person who paid for it and to
        // nobody else. Without the placerId this becomes "everyone sees every
        // pending placement", which is the feature working in reverse.
        ...(viewerId ? [{ status: 'pending' as const, placerId: viewerId }] : []),
      ],
    },
    select: {
      id: true,
      targetId: true,
      placerId: true,
      ownerId: true,
      status: true,
      amount: true,
      data: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  return rows
    .filter((row) => isStickerPlacementData(row.data))
    .map((row) => ({
      id: row.id,
      imageId: row.targetId,
      placerId: row.placerId,
      ownerId: row.ownerId,
      status: row.status as PlacementStatus,
      amount: row.amount,
      data: row.data as StickerPlacementData,
      isPending: row.status === 'pending',
    }));
}

/** Approved placements per image, for the reaction-bar count. */
export async function getStickerPlacementCounts(imageIds: number[]) {
  if (!imageIds.length) return {} as Record<number, number>;

  const rows = await dbRead.placement.groupBy({
    by: ['targetId'],
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: { in: imageIds },
      status: 'approved',
    },
    _count: { _all: true },
  });

  return Object.fromEntries(rows.map((row) => [row.targetId, row._count._all]));
}

/**
 * Whether the money behind a placement moved, derived from the ledger.
 *
 * `Placement.status` is not consulted, and that is the point: it says the
 * placement was processed, not that anyone was paid. A leg that exhausted its
 * retries leaves a placement reading `approved` with Buzz still in escrow, and a
 * support thread where someone insists a creator was paid is exactly how that
 * surfaces if this reads the column.
 */
export async function getPlacementSettlementStates(
  placementIds: number[]
): Promise<Record<number, PlacementSettlementState>> {
  if (!placementIds.length) return {};

  const legs = await dbRead.placementTransaction.findMany({
    where: {
      placementId: { in: placementIds },
      kind: { notIn: ['holdFee', 'holdPrincipal'] },
      amount: { gt: 0 },
    },
    select: { placementId: true, transactionId: true, attempts: true },
  });

  const states: Record<number, PlacementSettlementState> = Object.fromEntries(
    // No payout legs means nothing was owed — a placement still pending, or one
    // whose escrow never landed. Neither is money in flight.
    placementIds.map((id) => [id, 'settled' as PlacementSettlementState])
  );

  for (const leg of legs) {
    if (leg.transactionId) continue;
    states[leg.placementId] =
      leg.attempts >= MAX_LEG_ATTEMPTS
        ? 'stalled'
        : states[leg.placementId] === 'stalled'
        ? 'stalled'
        : 'pending';
  }

  return states;
}

// ---------------------------------------------------------------------------
// Owner actions
// ---------------------------------------------------------------------------

type OwnerAction = 'approve' | 'decline' | 'remove';

/**
 * The owner acting on a placement on their own content.
 *
 * `remove` maps to `removeByOwner`, which refunds the placer in full and pays
 * the owner nothing. That asymmetry with decline is deliberate: a fee for
 * after-the-fact removal would pay creators to accept placements, bank the
 * money, and sweep them off later.
 */
export async function actOnStickerPlacement({
  placementId,
  action,
  userId,
  isModerator = false,
}: {
  placementId: number;
  action: OwnerAction;
  userId: number;
  isModerator?: boolean;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: { id: true, ownerId: true, status: true, surface: true },
  });

  if (!placement || placement.surface !== SURFACE)
    throw throwBadRequestError('placement: that placement no longer exists');
  if (placement.ownerId !== userId && !isModerator)
    throw throwAuthorizationError('placement: that placement is not on your content');

  if (action === 'remove' && placement.status !== 'approved')
    throw throwBadRequestError('placement: only a live placement can be removed');
  if (action !== 'remove' && placement.status !== 'pending')
    throw throwBadRequestError('placement: that placement has already been actioned');

  const settleAction =
    action === 'approve' ? 'approve' : action === 'decline' ? 'decline' : 'removeByOwner';

  return settlePlacement({ placementId, action: settleAction, actorId: userId });
}

/** The owner's review queue: pending placements across all of their content. */
export const getPendingStickerPlacements = ({
  ownerId,
  limit = 50,
}: {
  ownerId: number;
  limit?: number;
}) =>
  dbRead.placement.findMany({
    where: { surface: SURFACE, ownerId, status: 'pending' },
    select: {
      id: true,
      targetId: true,
      placerId: true,
      amount: true,
      data: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

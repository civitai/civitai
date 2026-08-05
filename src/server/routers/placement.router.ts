import {
  actOnStickerPlacementSchema,
  createStickerPlacementSchema,
  getPlacementSpaceSchema,
  countPendingPlacementsFromSchema,
  getPlacementSettlementStatesSchema,
  getStickerPlacementsSchema,
  placementPriceRangeSchema,
  placementSpaceSchema,
} from '~/server/schema/placement.schema';
import { placementPriceRange } from '~/server/services/placement.service';
import {
  getPlacementSpaces,
  resolvePlacementSpaceFor,
  setPlacementSpace,
} from '~/server/services/placement-space.service';
import { countPendingPlacementsFrom } from '~/server/services/placement-moderation.service';
import {
  actOnStickerPlacement,
  createStickerPlacement,
  getPendingStickerPlacements,
  getPlacementSettlementStates,
  getStickerPlacementCounts,
  getStickerPlacements,
} from '~/server/services/sticker-placement.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import type { Context } from '~/server/createContext';

/**
 * Placement is gated separately from stickers.
 *
 * Owning a sticker and putting one on someone else's work are different risks —
 * the harassment surface is what the spec calls out — so the two flags let
 * stickers open up while placement stays with testers until the artwork
 * moderation work lands. Both are required, so placement cannot outlive the
 * feature it belongs to.
 *
 * **Checked on every mutation, not just where the button is drawn.** A listing
 * that filters is not a mutation that refuses; v1 shipped that mistake five
 * times.
 */
function assertPlacementEnabled(ctx: Context) {
  if (!ctx.features.stickers || !ctx.features.stickerPlacement)
    throw throwAuthorizationError('placement: sticker placement is not available yet');
}

export const placementRouter = router({
  getSpace: publicProcedure
    .input(getPlacementSpaceSchema)
    .query(({ input }) => resolvePlacementSpaceFor(input)),

  getMySpaces: protectedProcedure
    .input(placementPriceRangeSchema)
    .query(({ input, ctx }) => getPlacementSpaces({ surface: input.surface, userId: ctx.user.id })),

  getPriceRange: protectedProcedure
    .input(placementPriceRangeSchema)
    .query(({ input, ctx }) => placementPriceRange(ctx.user.id, input.surface)),

  setSpace: protectedProcedure.input(placementSpaceSchema).mutation(({ input, ctx }) => {
    assertPlacementEnabled(ctx);
    return setPlacementSpace({ ...input, userId: ctx.user.id });
  }),

  getStickerPlacements: publicProcedure
    .input(getStickerPlacementsSchema)
    .query(({ input, ctx }) =>
      getStickerPlacements({ imageIds: input.imageIds, viewerId: ctx.user?.id })
    ),

  getStickerPlacementCounts: publicProcedure
    .input(getStickerPlacementsSchema)
    .query(({ input }) => getStickerPlacementCounts(input.imageIds)),

  // Derived from the ledger, never from `Placement.status` — that column says a
  // placement was processed, not that anyone was paid.
  getSettlementStates: protectedProcedure
    .input(getPlacementSettlementStatesSchema)
    .query(({ input }) => getPlacementSettlementStates(input.placementIds)),

  createSticker: protectedProcedure
    .input(createStickerPlacementSchema)
    .mutation(({ input, ctx }) => {
      assertPlacementEnabled(ctx);
      return createStickerPlacement({ ...input, placerId: ctx.user.id });
    }),

  actOnSticker: protectedProcedure.input(actOnStickerPlacementSchema).mutation(({ input, ctx }) =>
    // Deliberately NOT flag-gated. Turning the flag off must not trap a creator
    // with pending placements on their content and no way to decline them.
    actOnStickerPlacement({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),

  getPending: protectedProcedure.query(({ ctx }) =>
    getPendingStickerPlacements({ ownerId: ctx.user.id })
  ),

  // How many pending placements blocking someone would decline, so the confirm
  // dialog can say. Advisory by construction — holding it accurate across a
  // human's confirmation would be a distributed transaction for no benefit, and
  // the number that matters is the one the cascade actually declined.
  countPendingFrom: protectedProcedure
    .input(countPendingPlacementsFromSchema)
    .query(({ input, ctx }) =>
      countPendingPlacementsFrom({ ownerId: ctx.user.id, placerId: input.userId })
    ),
});

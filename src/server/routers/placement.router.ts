import {
  actOnRemixGallerySubmissionSchema,
  declineOutOfBandRemixGallerySubmissionsSchema,
  actOnStickerPlacementsSchema,
  createStickerPlacementSchema,
  getPlacementSpaceRowSchema,
  getPlacementSpaceSchema,
  countPendingPlacementsFromSchema,
  getPlacementSettlementStatesSchema,
  getMyRemixGallerySubmissionsSchema,
  getMyStickerPlacementsSchema,
  getPendingRemixGallerySubmissionsSchema,
  getPendingStickerPlacementsSchema,
  getRemixGallerySchema,
  getRemixGalleryFreeEligibilitySchema,
  getRemixGalleryVisibilitySchema,
  getStickerPlacementDetailSchema,
  getStickerPlacementsSchema,
  placementPriceRangeSchema,
  placementSpaceSchema,
  placerSchema,
  removePlacementSchema,
  retractRemixGallerySubmissionSchema,
  setRemixGalleryPinsSchema,
  setStickerCommentHiddenSchema,
  submitToRemixGallerySchema,
  suspendPlacerSchema,
} from '~/server/schema/placement.schema';
import {
  getFreePlacementAllowance,
  hasUsedFreePlacementOn,
} from '~/server/services/free-placement.service';
import { placementPriceRange } from '~/server/services/placement.service';
import {
  clearPlacementSpace,
  getPlacementSpaceRow,
  getPlacementSpaces,
  resolvePlacementSpaceFor,
  setPlacementSpace,
} from '~/server/services/placement-space.service';
import {
  countPendingPlacementsFrom,
  isPlacementSuspended,
  removePlacementByModerator,
  removePlacementsByUser,
  restorePlacementPrivileges,
  suspendPlacementPrivileges,
} from '~/server/services/placement-moderation.service';
import {
  actOnStickerPlacements,
  createStickerPlacement,
  getMyStickerPlacements,
  getPendingStickerPlacements,
  getStickerPlacementDetail,
  getPlacementSettlementStates,
  getStickerPlacementCounts,
  getStickerPlacements,
  setStickerCommentHidden,
} from '~/server/services/sticker-placement.service';
import {
  actOnRemixGallerySubmission,
  declineOutOfBandRemixGallerySubmissions,
  createRemixGallerySubmission,
  getMyRemixGallerySubmissions,
  getPendingRemixGallerySubmissions,
  getRemixGallery,
  getRemixGalleryFreeEligibility,
  getRemixGalleryVisibility,
  retractRemixGallerySubmission,
  setRemixGalleryPins,
} from '~/server/services/remix-gallery.service';
import {
  guardedProcedure,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { domainSpendType } from '~/server/utils/buzz-helpers';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { domainServableLevels, viewerBrowsingLevel } from '~/server/utils/placement-levels';
import type { PlacementSurface } from '~/shared/utils/placement';
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

/**
 * The gallery's own gate. Not `assertPlacementEnabled`: that one requires the
 * sticker flags, and the two surfaces open on different schedules.
 *
 * Applied to submission and pinning only. An owner acting on what is already
 * waiting on their content is deliberately outside it, for the same reason
 * `actOnStickers` is — turning the flag off must not trap a creator with pending
 * submissions and no way to answer them.
 */
function assertRemixGalleryEnabled(ctx: Context) {
  if (!ctx.features.remixGallery)
    throw throwAuthorizationError('remix gallery: this is not available yet');
}

/**
 * The space endpoints are shared by both surfaces, so their gate has to follow
 * the surface being configured rather than the sticker flags.
 *
 * Without this a tester holding only `remix-gallery` gets a settings section
 * that renders and a save that always fails — the flag opens the feature
 * everywhere except the one endpoint that turns it on.
 */
function assertSurfaceEnabled(ctx: Context, surface: PlacementSurface) {
  if (surface === 'remixGallery') return assertRemixGalleryEnabled(ctx);
  return assertPlacementEnabled(ctx);
}

export const placementRouter = router({
  getSpace: publicProcedure
    .input(getPlacementSpaceSchema)
    .query(({ input }) => resolvePlacementSpaceFor(input)),

  // The row for one level, so a toggle shows what that level is set to rather
  // than what it inherits.
  getSpaceRow: protectedProcedure
    .input(getPlacementSpaceRowSchema)
    .query(({ input, ctx }) => getPlacementSpaceRow({ ...input, userId: ctx.user.id })),

  clearSpace: protectedProcedure.input(getPlacementSpaceRowSchema).mutation(({ input, ctx }) => {
    assertSurfaceEnabled(ctx, input.surface);
    return clearPlacementSpace({ ...input, userId: ctx.user.id });
  }),

  getMySpaces: protectedProcedure
    .input(placementPriceRangeSchema)
    .query(({ input, ctx }) => getPlacementSpaces({ surface: input.surface, userId: ctx.user.id })),

  getPriceRange: protectedProcedure
    .input(placementPriceRangeSchema)
    .query(({ input, ctx }) => placementPriceRange(ctx.user.id, input.surface)),

  setSpace: protectedProcedure.input(placementSpaceSchema).mutation(({ input, ctx }) => {
    assertSurfaceEnabled(ctx, input.surface);
    return setPlacementSpace({ ...input, userId: ctx.user.id });
  }),

  /**
   * Where the viewer stands against the free tier on one target: their daily
   * allowance, and whether they have already spent a free placement here.
   *
   * **A listing.** Both halves read a replica and are stale the moment they
   * return; the refusals live in `createFreePlacement`, under a lock, in the
   * transaction that inserts. This exists so the choice can be offered with the
   * numbers visible — an allowance spent silently is the worst version of a
   * scarce thing — and for no other purpose.
   *
   * Takes the target rather than being sticker-specific, because the allowance
   * is one placement a day across the whole site and both surfaces need to say
   * so. Surface-agnostic by reusing what PR 1 already exposes, not by anything
   * new sitting between the two.
   *
   * `placerId` is the session's. Off the input it would read anyone's allowance.
   */
  getFreeStanding: protectedProcedure
    .input(getPlacementSpaceSchema)
    .query(async ({ input, ctx }) => {
      const [allowance, usedHere] = await Promise.all([
        getFreePlacementAllowance({ placerId: ctx.user.id }),
        hasUsedFreePlacementOn({ ...input, placerId: ctx.user.id }),
      ]);

      return { ...allowance, usedHere };
    }),

  getStickerPlacements: publicProcedure
    .input(getStickerPlacementsSchema)
    .query(({ input, ctx }) =>
      getStickerPlacements({ imageIds: input.imageIds, viewerId: ctx.user?.id })
    ),

  // Its own query, hit only when someone hovers a sticker. Folding it into the
  // listing would pay for it on every sticker in a feed.
  getStickerPlacementDetail: publicProcedure
    .input(getStickerPlacementDetailSchema)
    .query(({ input, ctx }) =>
      getStickerPlacementDetail({
        placementId: input.placementId,
        viewerId: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
      })
    ),

  getStickerPlacementCounts: publicProcedure
    .input(getStickerPlacementsSchema)
    .query(({ input }) => getStickerPlacementCounts(input.imageIds)),

  // Derived from the ledger, never from `Placement.status` — that column says a
  // placement was processed, not that anyone was paid.
  getSettlementStates: protectedProcedure
    .input(getPlacementSettlementStatesSchema)
    .query(({ input, ctx }) => getPlacementSettlementStates(input.placementIds, ctx.user.id)),

  /**
   * `guardedProcedure`, not `protectedProcedure`: placing a sticker publishes
   * content onto someone else's image, so a muted account has to be refused the
   * same way it is refused a comment. Account state lives here; placement state
   * — the moderator suspension and the block pair — lives in `assertCanPlace`.
   */
  createSticker: guardedProcedure.input(createStickerPlacementSchema).mutation(({ input, ctx }) => {
    assertPlacementEnabled(ctx);
    return createStickerPlacement({
      ...input,
      // After the spread, and the schema has no `placerId` to strip anyway —
      // both, because this is the id the whole free tier is scoped by and
      // every check downstream is a statement about it rather than a check of
      // it. Read off the payload it would spend someone else's daily
      // allowance and place under their name with nothing raising.
      placerId: ctx.user.id,
      // From the request's own domain, never the input: `...input` spreads
      // first, so a client-sent `spendType` cannot survive this line.
      spendType: domainSpendType(ctx.features),
    });
  }),

  /**
   * The one mutation here that is deliberately NOT flag-gated: turning the flag
   * off must not trap a creator with pending placements on their content and no
   * way to decline them. Ownership is still enforced — `actOnStickerPlacement`
   * refuses anything that is not yours unless you are a moderator.
   *
   * Takes a list even for one placement, so the queue's bulk action and the
   * buttons on the image are the same call rather than two paths to a settlement
   * that already has rules.
   */
  actOnStickers: protectedProcedure
    .input(actOnStickerPlacementsSchema)
    .mutation(({ input, ctx }) =>
      actOnStickerPlacements({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  /**
   * Hiding or restoring the note on a sticker. Ungated for the same reason
   * `actOnStickers` is: turning the flag off must not leave an owner holding a
   * note on their own image with no way to refuse it.
   */
  setStickerCommentHidden: protectedProcedure
    .input(setStickerCommentHiddenSchema)
    .mutation(({ input, ctx }) =>
      setStickerCommentHidden({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),

  isSuspended: moderatorProcedure
    .input(placerSchema)
    .query(({ input }) => isPlacementSuspended(input.userId)),

  /**
   * Suspend first, then remove. `removePlacementsByUser` asserts the suspension
   * is already committed, because its correctness argument is that the placer
   * cannot create new placements behind the sweep — and that only holds once the
   * suspension is real.
   */
  suspendPlacer: moderatorProcedure.input(suspendPlacerSchema).mutation(async ({ input, ctx }) => {
    await suspendPlacementPrivileges({
      userId: input.userId,
      actorId: ctx.user.id,
      reason: input.reason,
    });

    if (!input.removeExisting) return { removed: null };

    // Drains rather than clearing one batch: `removePlacementsByUser` is bounded
    // at 200 and returns `hasMore`, and nothing else resumes it — a placer with
    // 500 placements would otherwise be reported as fully handled with 300 still
    // live on other people's work. Capped so a runaway cannot hold the request.
    let removed = {
      considered: 0,
      settled: 0,
      failed: [] as number[],
      takenDown: 0,
      hasMore: false,
    };
    for (let batch = 0; batch < 10; batch++) {
      const result = await removePlacementsByUser({
        placerId: input.userId,
        actorId: ctx.user.id,
      });
      removed = {
        considered: removed.considered + result.considered,
        settled: removed.settled + result.settled,
        failed: [...removed.failed, ...result.failed],
        takenDown: removed.takenDown + result.takenDown,
        hasMore: result.hasMore,
      };
      if (!result.hasMore) break;
    }

    return { removed };
  }),

  /**
   * Not flag-gated, for the same reason `actOnStickers` isn't: turning the flag
   * off must not leave a reported placement live with nothing able to take it
   * down.
   */
  removePlacement: moderatorProcedure
    .input(removePlacementSchema)
    .mutation(({ input, ctx }) =>
      removePlacementByModerator({ placementId: input.placementId, actorId: ctx.user.id })
    ),

  restorePlacer: moderatorProcedure
    .input(placerSchema)
    .mutation(({ input }) => restorePlacementPrivileges(input.userId)),

  getPending: protectedProcedure.input(getPendingStickerPlacementsSchema).query(({ input, ctx }) =>
    getPendingStickerPlacements({
      ownerId: ctx.user.id,
      cursor: input.cursor,
      domainLevels: domainServableLevels(ctx),
      viewerLevels: viewerBrowsingLevel(ctx, input.browsingLevel),
    })
  ),

  /**
   * The placer's own side of the same queue. `ctx.user.id` is the only source of
   * `placerId` — there is no input for it, so this cannot be pointed at anyone
   * else's placements.
   */
  getMyStickerPlacements: protectedProcedure
    .input(getMyStickerPlacementsSchema)
    .query(({ input, ctx }) =>
      getMyStickerPlacements({
        placerId: ctx.user.id,
        domainLevels: domainServableLevels(ctx),
        viewerLevels: viewerBrowsingLevel(ctx, input.browsingLevel),
      })
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

  // --- Remix gallery -------------------------------------------------------
  //
  // Space settings (on/off, price, content rule) deliberately have no endpoints
  // of their own: they go through `setSpace` / `getMySpaces` / `getPriceRange`
  // with `surface: 'remixGallery'`. A second way to write a space is a second
  // set of rules to keep correct.

  getRemixGallery: publicProcedure.input(getRemixGallerySchema).query(({ input, ctx }) =>
    getRemixGallery({
      hostImageId: input.imageId,
      browsingLevel: viewerBrowsingLevel(ctx, input.browsingLevel),
      cursor: input.cursor,
      limit: input.limit,
      // Carried through so hydration applies the viewer's blocks and hidden
      // preferences — a gallery is other people's content on someone else's
      // page, so it is exactly where a block should still bite.
      user: ctx.user ?? undefined,
    })
  ),

  // Whether to draw the card at all, and at what price. Its own query because
  // the answer is needed on every image detail view while the gallery contents
  // are needed only where one exists.
  getRemixGalleryVisibility: publicProcedure
    .input(getRemixGalleryVisibilitySchema)
    .query(({ input, ctx }) =>
      getRemixGalleryVisibility({
        hostImageId: input.imageId,
        browsingLevel: viewerBrowsingLevel(ctx, input.browsingLevel),
        domainLevels: domainServableLevels(ctx),
        // The service only counts pending submissions when this matches the
        // space owner, so a signed-out or unrelated viewer never learns how
        // many someone has waiting.
        viewerId: ctx.user?.id,
      })
    ),

  /** `guardedProcedure` for the same reason `createSticker` is. */
  submitToRemixGallery: guardedProcedure
    .input(submitToRemixGallerySchema)
    .mutation(({ input, ctx }) => {
      assertRemixGalleryEnabled(ctx);
      return createRemixGallerySubmission({
        ...input,
        // From the session, never the input. `createFreePlacement` takes this as
        // a plain number and cannot tell where it came from, and every check
        // downstream is *about* this id rather than a check *of* it — so a
        // client-supplied one would spend someone else's daily allowance and
        // submit under their account with nothing raising. `...input` spreads
        // first, so no client value can survive this line.
        placerId: ctx.user.id,
        spendType: domainSpendType(ctx.features),
      });
    }),

  /**
   * The free option's inputs, for the submit card. A listing: everything it
   * returns is stale by the time it renders, and the refusals live on the
   * mutation.
   */
  getRemixGalleryFreeEligibility: protectedProcedure
    .input(getRemixGalleryFreeEligibilitySchema)
    .query(({ input, ctx }) => getRemixGalleryFreeEligibility({ ...input, placerId: ctx.user.id })),

  /**
   * Not flag-gated, for the same reason `actOnStickers` isn't: turning the flag
   * off must not leave a creator holding submissions on their own work with no
   * way to decline them. Ownership is still enforced in the service.
   */
  actOnRemixGallerySubmission: protectedProcedure
    .input(actOnRemixGallerySubmissionSchema)
    .mutation(({ input, ctx }) =>
      actOnRemixGallerySubmission({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),

  /**
   * Ungated for the same reason as the single action above: an owner must be
   * able to clear submissions their own rule should never have taken, whatever
   * the flag says.
   *
   * `isModerator` is deliberately not passed. This resolves a set from a
   * gallery's own rule and settles every row in it — a moderator running it on
   * someone else's gallery would be a bulk action attributed to the owner.
   */
  declineOutOfBandRemixGallerySubmissions: protectedProcedure
    .input(declineOutOfBandRemixGallerySubmissionsSchema)
    .mutation(({ input, ctx }) =>
      declineOutOfBandRemixGallerySubmissions({ ...input, userId: ctx.user.id })
    ),

  // Also ungated: a submitter must be able to get their Buzz back out of escrow
  // whatever the flag says.
  retractRemixGallerySubmission: protectedProcedure
    .input(retractRemixGallerySubmissionSchema)
    .mutation(({ input, ctx }) =>
      retractRemixGallerySubmission({ placementId: input.placementId, placerId: ctx.user.id })
    ),

  setRemixGalleryPins: protectedProcedure
    .input(setRemixGalleryPinsSchema)
    .mutation(({ input, ctx }) => {
      assertRemixGalleryEnabled(ctx);
      return setRemixGalleryPins({ ...input, ownerId: ctx.user.id });
    }),

  getPendingRemixGallerySubmissions: protectedProcedure
    .input(getPendingRemixGallerySubmissionsSchema)
    .query(({ input, ctx }) =>
      getPendingRemixGallerySubmissions({
        ownerId: ctx.user.id,
        hostImageId: input.hostImageId,
        cursor: input.cursor,
        domainLevels: domainServableLevels(ctx),
        viewerLevels: viewerBrowsingLevel(ctx, input.browsingLevel),
      })
    ),

  getMyRemixGallerySubmissions: protectedProcedure
    .input(getMyRemixGallerySubmissionsSchema)
    .query(({ input, ctx }) =>
      getMyRemixGallerySubmissions({
        placerId: ctx.user.id,
        domainLevels: domainServableLevels(ctx),
        viewerLevels: viewerBrowsingLevel(ctx, input.browsingLevel),
      })
    ),
});

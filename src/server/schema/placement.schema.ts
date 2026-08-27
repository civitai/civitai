import { z } from 'zod';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { PLACEMENT_SURFACES, placementSurfaces } from '~/shared/utils/placement';
import { REMIX_GALLERY_MAX_PINNED } from '~/shared/utils/remix-gallery';
import {
  STICKER_COMMENT_MAX_LENGTH,
  STICKER_PLACEMENT_DEFAULT_OPACITY,
  STICKER_PLACEMENT_MAX_OPACITY,
  STICKER_PLACEMENT_MAX_ROTATION,
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_OPACITY,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

export const placementSurfaceSchema = z.enum(
  placementSurfaces as [string, ...string[]]
) as z.ZodType<(typeof placementSurfaces)[number]>;

const finite = z.number().finite();

/**
 * Bounds, not clamps. The service clamps a drag that ran a pixel past the edge;
 * the schema still refuses a non-finite value, which would render nowhere and be
 * indistinguishable from the sticker not existing.
 */
export const stickerPlacementDataSchema = z.object({
  cosmeticId: z.number().int().positive(),
  x: finite.min(0).max(1),
  y: finite.min(0).max(1),
  scale: finite.min(STICKER_PLACEMENT_MIN_SCALE).max(STICKER_PLACEMENT_MAX_SCALE),
  rotation: finite.min(-STICKER_PLACEMENT_MAX_ROTATION).max(STICKER_PLACEMENT_MAX_ROTATION),
  // Bounded well above what the field allows, because the service trims and
  // truncates. The limit here is what stops a megabyte of text reaching a JSON
  // column; the normaliser is what decides the stored value.
  comment: z
    .string()
    .max(STICKER_COMMENT_MAX_LENGTH * 4)
    .optional(),
  // Refused, not clamped, and refused here rather than at the slider: the floor
  // is what stops a placement being a quiet defacement, and a client-side clamp
  // is a filter rather than a refusal — it decides nothing about a crafted
  // request. Defaulted so a client cached from before these existed still
  // places a sticker instead of failing validation.
  flip: z.boolean().default(false),
  opacity: finite
    .min(STICKER_PLACEMENT_MIN_OPACITY)
    .max(STICKER_PLACEMENT_MAX_OPACITY)
    .default(STICKER_PLACEMENT_DEFAULT_OPACITY),
});

export const createStickerPlacementSchema = z.object({
  imageId: z.number().int().positive(),
  data: stickerPlacementDataSchema,
  /**
   * Take the creator's free capacity rather than paying their price.
   *
   * Safe to accept from the client because it selects a path, not an outcome:
   * everything that makes a free placement legal is re-decided by
   * `createFreePlacement` under a lock. Defaulted false so a client cached from
   * before the free tier existed still places a paid sticker.
   *
   * 🔴 There is deliberately no `placerId` here, and there must never be one —
   * see the note on `CreateStickerPlacement`.
   */
  free: z.boolean().default(false),
});
export type CreateStickerPlacementInput = z.infer<typeof createStickerPlacementSchema>;

export const getStickerPlacementsSchema = z.object({
  imageIds: z.array(z.number().int().positive()).min(1).max(100),
});

export const actOnStickerPlacementSchema = z.object({
  placementId: z.number().int().positive(),
  action: z.enum(['approve', 'decline', 'remove']),
});

export const placementSpaceSchema = z
  .object({
    surface: placementSurfaceSchema,
    entityType: z.enum(['image', 'post', 'user']),
    entityId: z.number().int().positive(),
    mode: z.enum(['off', 'review', 'auto']),
    // Distinguishes "leave whatever is set" from "clear it and inherit", which a
    // single optional number cannot: `undefined` keeps, `null` clears.
    price: z.number().int().min(0).nullable().optional(),
    // Same three-way distinction as `price`, for the same reason: `undefined`
    // keeps, `null` clears so the level inherits, a number sets. Bounded below
    // only — the score/tier ceiling is applied at read, so refusing above it here
    // would rewrite a creator's choice the moment their tier lapsed. The upper
    // bound is a sanity limit on what may reach the column at all, well above the
    // highest cap the table can produce.
    freeSlots: z.number().int().min(0).max(1_000).nullable().optional(),
    // Surface-owned. Bounded here so a client cannot store a max size outside the
    // global limits; the reader clamps too, since the column is editable by hand.
    // Each surface reads only its own keys, so the union is carried rather than
    // discriminated — nothing reads a key belonging to another surface.
    settings: z
      .object({
        maxScale: z.number().min(STICKER_PLACEMENT_MIN_SCALE).max(STICKER_PLACEMENT_MAX_SCALE),
        contentRule: z.enum(['atOrBelow', 'any']),
      })
      .partial()
      .optional(),
  })
  .superRefine((input, ctx) => {
    // A remix gallery places arbitrary user-uploaded media on someone else's
    // page. `auto` is safe for stickers because the placed artwork comes from a
    // moderated catalogue; nothing bounds what an image can be. Refused where
    // the value is stored rather than merely omitted from the settings picker —
    // a listing that filters is not a mutation that refuses.
    //
    // Read from the surface table rather than naming `remixGallery` here, so
    // this and the refusal on the acting side (`createFreePlacement`) cannot
    // disagree about which modes a surface allows.
    const allowed = PLACEMENT_SURFACES[input.surface].allowedModes as readonly string[];
    if (!allowed.includes(input.mode))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message:
          input.surface === 'remixGallery'
            ? 'Remix gallery submissions always need review'
            : 'That is not a mode this surface accepts',
      });
  });

export const getPlacementSpaceSchema = z.object({
  surface: placementSurfaceSchema,
  targetType: z.enum(['image']),
  targetId: z.number().int().positive(),
});

export const placementPriceRangeSchema = z.object({ surface: placementSurfaceSchema });

export const getPlacementSettlementStatesSchema = z.object({
  placementIds: z.array(z.number().int().positive()).min(1).max(100),
});

export const countPendingPlacementsFromSchema = z.object({
  userId: z.number().int().positive(),
});

export const getStickerPlacementDetailSchema = z.object({
  placementId: z.number().int().positive(),
});

export const actOnStickerPlacementsSchema = z.object({
  placementIds: z.array(z.number().int().positive()).min(1).max(50),
  action: z.enum(['approve', 'decline', 'remove']),
  /** Partial approval — take the sticker, refuse the note it came with. */
  hideComment: z.boolean().optional(),
});

export const setStickerCommentHiddenSchema = z.object({
  placementId: z.number().int().positive(),
  hidden: z.boolean(),
});

export const getPlacementSpaceRowSchema = z.object({
  surface: placementSurfaceSchema,
  entityType: z.enum(['image', 'post', 'user']),
  entityId: z.number().int().positive(),
});

export const suspendPlacerSchema = z.object({
  userId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  /** Also take down everything they have already placed. */
  removeExisting: z.boolean().default(false),
});

export const placerSchema = z.object({ userId: z.number().int().positive() });

export const removePlacementSchema = z.object({ placementId: z.number().int().positive() });

// ---------------------------------------------------------------------------
// Remix gallery
// ---------------------------------------------------------------------------

/**
 * `browsingLevel` arrives from the client the same way every image listing takes
 * it (`baseQuerySchema`), and the service narrows it with `onlySelectableLevels`
 * before it reaches a query. The router additionally clamps it on the SFW
 * domain, because the gallery renders someone else's content on a page the host
 * creator does not control.
 */
export const getRemixGallerySchema = z.object({
  imageId: z.number().int().positive(),
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
  cursor: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const getRemixGalleryVisibilitySchema = z.object({
  imageId: z.number().int().positive(),
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
});

/**
 * Counts and preview thumbnails for the host images on one surface.
 *
 * Capped at 100 to match the sticker batch, which is what sets a feed's cost at
 * one query per 100 cards rather than one per card.
 */
export const getRemixGalleryCardSummariesSchema = z.object({
  imageIds: z.array(z.number().int().positive()).min(1).max(100),
  /**
   * 🔴 Defaults to PG, not to every level.
   *
   * An omitted level is not a narrower request, it is the widest one:
   * `applyDomainFeature` only narrows where the DOMAIN has a cap, so a signed-in
   * viewer on blue or red gets every level. That is exactly how this shipped wide
   * once. Failing closed costs a client that forgets the prop some missing
   * frames, which is visible; failing open costs someone content they asked not
   * to see.
   *
   * The two schemas above still default wide, and `getRemixGallery` is fine
   * because its only caller passes the level. `getRemixGalleryVisibility` was
   * NOT — its caller omitted it, which made it a boolean oracle for whether
   * entries exist above the asker's level. Fixed at the call site rather than
   * here, because narrowing that default would hide the gallery card from
   * viewers entitled to see it.
   */
  browsingLevel: z.number().min(0).default(publicBrowsingLevelsFlag),
});

export const submitToRemixGallerySchema = z
  .object({
    hostImageId: z.number().int().positive(),
    imageId: z.number().int().positive(),
    /**
     * The price the submitter was shown. Refused if the owner has moved it since,
     * rather than silently charging the new one — the client can only check
     * affordability against the number it rendered, so without this an owner
     * raising their price between the modal opening and the button being pressed
     * is charged without consent.
     *
     * Optional only because a free submission has no price to agree to. The
     * refinement below still requires it on the paid path, so this cannot become
     * a route to submitting without one.
     */
    expectedPrice: z.number().int().min(0).optional(),
    /**
     * Spend the daily free placement instead of Buzz. The server decides whether
     * that is allowed — the remix must be one it resolved as derived from the
     * host, and the creator must have a slot free — so this asks rather than
     * asserts. `placerId` is never taken from here; it comes from the session.
     */
    free: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    // Without this, omitting `expectedPrice` on a paid submission reaches the
    // service as `undefined`, which it reads as "the submitter agreed to
    // whatever it is now" — the exact consent hole the field exists to close.
    if (!input.free && input.expectedPrice == null)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedPrice'],
        message: 'A paid submission has to carry the price it was shown',
      });
  });

/**
 * What the submit card needs to offer the free option, for the candidates it has
 * already loaded.
 *
 * Bounded to one page of the picker rather than taking the viewer's whole
 * library: the verification is a jsonb containment test per row, and answering
 * it for every image someone has ever posted is a scan nobody asked for.
 */
export const getRemixGalleryFreeEligibilitySchema = z.object({
  hostImageId: z.number().int().positive(),
  imageIds: z.array(z.number().int().positive()).max(200),
});

export const actOnRemixGallerySubmissionSchema = z.object({
  placementId: z.number().int().positive(),
  action: z.enum(['approve', 'decline', 'remove']),
  // A moderator acting on their OWN gallery, which ownership alone cannot
  // express: without it they get creator rules on their own content and can
  // moderate everyone except themselves. Requested, never inferred — moderators
  // browsing the site as ordinary users is the default and stays that way.
  // Ignored for anyone who is not a moderator.
  asModerator: z.boolean().optional(),
});

export const retractRemixGallerySubmissionSchema = z.object({
  placementId: z.number().int().positive(),
});

/**
 * The gallery, not the rows. The set is resolved server-side from the owner's
 * own content rule — accepting placement ids here would let a caller decline
 * submissions that are perfectly in band.
 */
export const declineOutOfBandRemixGallerySubmissionsSchema = z.object({
  hostImageId: z.number().int().positive(),
});

/**
 * The whole pinned set, in order, rather than a per-entry toggle — the cap is a
 * property of the set, and enforcing it one toggle at a time lets two concurrent
 * pins both see room for one more.
 */
export const setRemixGalleryPinsSchema = z.object({
  hostImageId: z.number().int().positive(),
  placementIds: z.array(z.number().int().positive()).max(REMIX_GALLERY_MAX_PINNED),
});

/** Where the last page stopped. Opaque to the client; see `placementQueueKeyset`. */
const placementQueueCursorSchema = z.string().max(100).nullish();

/**
 * The review queues take a browsing level like every image listing, but they do
 * not filter on it: an owner has to be shown everything waiting on them, or the
 * escrow behind what they cannot see expires unreviewed. It marks rows instead,
 * so the surface can say what is outside the viewer's band and offer to widen it.
 * The domain ceiling is the separate, non-negotiable one, applied in the router.
 */
export const getPendingRemixGallerySubmissionsSchema = z.object({
  /** Omitted for the account-wide queue; set to scope to one gallery. */
  hostImageId: z.number().int().positive().optional(),
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
  cursor: placementQueueCursorSchema,
});

/**
 * One of your own images, asking which galleries its provenance points at. The
 * hosts are resolved server-side from `sourceImageIds`; the caller cannot name
 * them, which is what keeps the free gate meaningful.
 */
export const getRemixSourcesForImageSchema = z.object({
  imageId: z.number().int().positive(),
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
});

/** Same marking rule as the owner queue: the submitter's own band, not a filter. */
export const getMyRemixGallerySubmissionsSchema = z.object({
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
});

export const getPendingStickerPlacementsSchema = z.object({
  cursor: placementQueueCursorSchema,
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
});

/** Same marking rule as the owner queue: the placer's own band, not a filter. */
export const getMyStickerPlacementsSchema = z.object({
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
});

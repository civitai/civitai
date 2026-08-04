import { CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { comfylessImageSchema } from '~/server/schema/image.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

export type GetPaginatedCosmeticShopItemInput = z.infer<typeof getPaginatedCosmeticShopItemInput>;
export const getPaginatedCosmeticShopItemInput = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    name: z.string().optional(),
    types: z.array(z.enum(CosmeticType)).optional(),
    minPrice: z.number().optional(),
    maxPrice: z.number().optional(),
    archived: z.boolean().optional(),
    // Only published creator-listed items marked sellable-by-others — lets mods
    // pick up resellable creator cosmetics for official shop sections.
    resellable: z.boolean().optional(),
    ids: z.array(z.number()).optional(),
  })
);

// Shop context for purchases: the official Civitai shop attributes as the
// system user (-1); creator storefronts attribute as their owner's user id.
export const CIVITAI_SHOP_ATTRIBUTION = -1;

export type CosmeticShopItemMeta = z.infer<typeof cosmeticShopItemMeta>;
export const cosmeticShopItemMeta = z.object({
  paidToUserIds: z.array(z.number()).optional(),
  purchases: z.number().default(0),
  // Creator Shop: id of the creator who submitted this item (also drives payout),
  // the Buzz submission-fee transaction, and the last moderator-approved price
  // used to decide whether a price edit (>±25%) requires re-review.
  creatorId: z.number().optional(),
  submissionTxId: z.string().optional(),
  lastApprovedAmount: z.number().optional(),
  // Pre-submit artwork validation + image info, surfaced to moderators in the
  // Creator Shop review queue.
  autoChecks: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        passed: z.boolean(),
        detail: z.string().optional(),
      })
    )
    .optional(),
  imageMeta: z
    .object({ width: z.number(), height: z.number(), hasTransparency: z.boolean() })
    .optional(),
  // sha256 of the submitted artwork bytes — used to block duplicate submissions.
  imageHash: z.string().optional(),
  // Cross-creator selling: whether other creators may resell this item, and the %
  // of price (0-70, out of the creator's 70% pool) the reseller keeps.
  sellableByOthers: z.boolean().optional(),
  sellerShare: z.number().optional(),
  // Creator opt-in: buyers may pay with Blue Buzz (fully or partially). The
  // creator is paid blue for the blue-paid portion of each sale.
  acceptsBlueBuzz: z.boolean().optional(),
  // Creator Shop: who affirmed they hold the rights to sell this artwork, when,
  // and the exact wording they accepted. Re-recorded whenever the artwork is
  // replaced, so it always describes the art currently on the item. Absent on
  // official items and on creator items submitted before this was required.
  rightsAffirmation: z
    .object({
      userId: z.number(),
      affirmedAt: z.string(),
      version: z.number(),
      statement: z.string(),
    })
    .optional(),
});

export type UpsertCosmeticInput = z.infer<typeof upsertCosmeticInput>;
export const upsertCosmeticInput = z
  .object({
    id: z.number().optional(),
    videoUrl: z.string().nullish(),
    // Fields below are required when creating a new cosmetic (no id provided)
    name: z.string().min(1).optional(),
    description: getSanitizedStringSchema().nullish(),
    type: z.enum(CosmeticType).optional(),
    source: z.enum(CosmeticSource).optional(),
    permanentUnlock: z.boolean().optional(),
    // Cosmetic-specific config — for image-based types this carries
    // { url, animated?, type? }; NamePlate carries text styling. Free-form so
    // moderators can author types we haven't built UI for yet.
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => value.id != null || (value.name && value.type && value.source), {
    message: 'name, type, and source are required when creating a new cosmetic',
    path: ['name'],
  });

export type UpsertCosmeticShopItemInput = z.infer<typeof upsertCosmeticShopItemInput>;
export const upsertCosmeticShopItemInput = z.object({
  id: z.number().optional(),
  title: z.string().max(255),
  description: getSanitizedStringSchema().nullish(),
  videoUrl: z.string().nullish(),
  cosmeticId: z.number(),
  unitAmount: z.number(),
  availableFrom: z.date().nullish(),
  availableTo: z.date().nullish(),
  availableQuantity: z.number().nullish(),
  archived: z.boolean().optional(),
  meta: cosmeticShopItemMeta.optional(),
  addToSectionIds: z.array(z.number()).optional(),
});

export type GetAllCosmeticShopSections = z.infer<typeof getAllCosmeticShopSections>;
export const getAllCosmeticShopSections = z.object({
  title: z.string().optional(),
  withItems: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export type CosmeticShopSectionMeta = z.infer<typeof cosmeticShopSectionMeta>;
export const cosmeticShopSectionMeta = z.object({
  hideTitle: z.boolean().optional(),
  availableItemsMax: z.number().optional(),
  // Renders the sitewide community-cosmetics feed in place of hand-picked
  // items, so mods control the hub's placement/banner/copy like any section.
  communityHub: z.boolean().optional(),
});

export type UpsertCosmeticShopSectionInput = z.infer<typeof upsertCosmeticShopSectionInput>;
export const upsertCosmeticShopSectionInput = z.object({
  id: z.number().optional(),
  title: z.string().max(255),
  description: getSanitizedStringSchema().nullish(),
  placement: z.number().optional(),
  items: z.array(z.number()).optional(),
  image: comfylessImageSchema.nullish(),
  published: z.boolean().optional(),
  meta: cosmeticShopSectionMeta.optional(),
});

export type UpdateCosmeticShopSectionsOrderInput = z.infer<
  typeof updateCosmeticShopSectionsOrderInput
>;
export const updateCosmeticShopSectionsOrderInput = z.object({
  sortedSectionIds: z.array(z.number()),
});

export type PurchaseCosmeticShopItemInput = z.infer<typeof purchaseCosmeticShopItemInput>;
export const purchaseCosmeticShopItemInput = z.object({
  shopItemId: z.number(),
  // The creator whose shop this was bought through — used to credit a reseller
  // (Creator Shop cross-creator selling). Verified server-side.
  viaShopUserId: z.number().optional(),
  // Buyer's payment choice for items that accept Blue Buzz: the domain color
  // only (default), or blue first with the remainder in the domain color.
  // Rejected server-side if the item doesn't accept blue.
  payWith: z.enum(['default', 'blue-first']).optional(),
});

export type ToggleWishlistShopItemInput = z.infer<typeof toggleWishlistShopItemInput>;
export const toggleWishlistShopItemInput = z.object({
  shopItemId: z.number(),
  // Desired end state rather than a blind flip, so a rapid double-click settles
  // on what the last click asked for instead of racing to an arbitrary value.
  // Omitted = flip whatever is currently stored.
  wishlisted: z.boolean().optional(),
});

export type GetPreviewImagesInput = z.infer<typeof getPreviewImagesInput>;
export const getPreviewImagesInput = z.object({
  browsingLevel: z.number(),
  limit: z.number().optional(),
});

export type GetShopInput = z.infer<typeof getShopInput>;
export const getShopInput = z.object({
  cosmeticTypes: z.array(z.enum(CosmeticType)).optional(),
  sectionId: z.number().optional(),
});

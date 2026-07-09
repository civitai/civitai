import * as z from 'zod';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * Creator Shop input contracts. See docs/features/creator-shop.md.
 * Creator cosmetics reuse the existing Cosmetic + CosmeticShopItem tables.
 */

// Business rules (shared by client + server).
export const COSMETIC_PRICE_FLOOR = 500;
export const CREATOR_SHOP_SUBMISSION_FEE = 1000;
export const CREATOR_SHOP_MAX_FEATURED = 6;
// Creator keeps this share of each sale; platform keeps the remainder.
export const CREATOR_SHOP_CREATOR_SHARE = 0.7;
// A price edit beyond ±this fraction of the last approved price re-enters review.
export const PRICE_REVIEW_THRESHOLD = 0.25;

// Cosmetic subtypes a creator may submit (merch is a separate, later product).
export const creatorCosmeticTypes = [
  CosmeticType.Badge,
  CosmeticType.ProfileDecoration,
  CosmeticType.ContentDecoration,
  CosmeticType.ProfileBackground,
] as const;

// Per-type artwork requirements. `exact` = dimensions must match exactly,
// otherwise width/height are treated as minimums.
export type CosmeticImageRequirement = {
  width: number;
  height: number;
  exact: boolean;
  requireTransparency: boolean;
};
export const cosmeticImageRequirements = (type: CosmeticType): CosmeticImageRequirement => {
  switch (type) {
    case CosmeticType.ProfileDecoration:
      return { width: 120, height: 120, exact: true, requireTransparency: true };
    case CosmeticType.ProfileBackground:
      return { width: 450, height: 155, exact: true, requireTransparency: false };
    case CosmeticType.ContentDecoration:
      return { width: 256, height: 256, exact: false, requireTransparency: true };
    case CosmeticType.Badge:
    default:
      return { width: 144, height: 144, exact: false, requireTransparency: true };
  }
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

// Human-readable aspect ratio, e.g. 144×144 -> "1:1", 450×155 -> "90:31".
export const aspectRatioLabel = (width: number, height: number): string => {
  const g = gcd(width, height) || 1;
  return `${width / g}:${height / g}`;
};

// Dimensions requirement label — shared by the submit form and both validators.
export const cosmeticDimensionsLabel = (req: CosmeticImageRequirement): string =>
  req.exact
    ? `${req.width}×${req.height}px`
    : `At least ${req.width}×${req.height}px · ${aspectRatioLabel(req.width, req.height)} ratio`;

// `exact` types must match WxH exactly; the rest must meet the minimum size AND
// keep the requirement's aspect ratio (within 2%).
export const cosmeticDimensionsPass = (
  req: CosmeticImageRequirement,
  width: number,
  height: number
): boolean => {
  if (req.exact) return width === req.width && height === req.height;
  const meetsMin = width >= req.width && height >= req.height;
  const targetRatio = req.width / req.height;
  const ratioMatch = height > 0 && Math.abs(width / height - targetRatio) <= 0.02 * targetRatio;
  return meetsMin && ratioMatch;
};

// Computed SERVER-SIDE from the uploaded artwork and persisted to item meta so
// moderators can see them. Not accepted as client input.
export type AutoCheck = z.infer<typeof autoCheckSchema>;
export const autoCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});

export type CosmeticImageMeta = z.infer<typeof cosmeticImageMetaSchema>;
export const cosmeticImageMetaSchema = z.object({
  width: z.number(),
  height: z.number(),
  hasTransparency: z.boolean(),
});

export type SubmitCreatorShopItemInput = z.infer<typeof submitCreatorShopItemSchema>;
export const submitCreatorShopItemSchema = z.object({
  cosmeticType: z.enum(CosmeticType),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).nullish(),
  // CF image id from the upload. The server builds the cosmetic `data` from this
  // and validates the artwork itself (format/dimensions/transparency).
  imageUrl: z.string().min(1),
  animated: z.boolean().optional(),
  price: z.number().int().min(COSMETIC_PRICE_FLOOR),
  availableQuantity: z.number().int().positive().nullish(),
  buzzType: z.enum(['green', 'yellow']).default('yellow'),
});

export type UpdateCreatorShopItemInput = z.infer<typeof updateCreatorShopItemSchema>;
export const updateCreatorShopItemSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullish(),
  // Only present when replacing artwork (blocked once the item is published).
  imageUrl: z.string().optional(),
  animated: z.boolean().optional(),
  price: z.number().int().min(COSMETIC_PRICE_FLOOR).optional(),
  availableQuantity: z.number().int().positive().nullish(),
});

export type GetCreatorShopInput = z.infer<typeof getCreatorShopSchema>;
export const getCreatorShopSchema = z.object({
  userId: z.number(),
});

export type GetEarlyAccessPricesInput = z.infer<typeof getEarlyAccessPricesSchema>;
export const getEarlyAccessPricesSchema = z.object({
  modelVersionIds: z.array(z.number()).max(200),
});

export type ReviewCreatorShopItemInput = z.infer<typeof reviewCreatorShopItemSchema>;
export const reviewCreatorShopItemSchema = z
  .object({
    id: z.number(),
    // reject = terminal; request-changes = creator can edit & resubmit.
    action: z.enum(['approve', 'reject', 'request-changes']),
    rejectionReason: z.string().max(1000).optional(),
  })
  .refine((v) => v.action === 'approve' || !!v.rejectionReason?.length, {
    message: 'A note is required when rejecting or requesting changes',
    path: ['rejectionReason'],
  });

export type GetReviewQueueInput = z.infer<typeof getReviewQueueSchema>;
export const getReviewQueueSchema = z.object({
  limit: z.number().min(1).max(100).default(20),
  cursor: z.number().optional(),
  // Defaults to PendingReview in the service; moderators can also review
  // Published / Rejected, and filter to a single creator.
  status: z.enum(CosmeticShopItemStatus).optional(),
  username: z.string().optional(),
});

export type GetManageItemsInput = z.infer<typeof getManageItemsSchema>;
export const getManageItemsSchema = z.object({
  // Moderators may inspect another creator's shop by passing their userId.
  userId: z.number().optional(),
});

// Storefront section order + per-section visibility (stored in User.settings).
export const creatorShopSectionKeys = ['featured', 'cosmetics', 'merch', 'models'] as const;
export type CreatorShopSectionKey = (typeof creatorShopSectionKeys)[number];
export const creatorShopSectionSchema = z.object({
  key: z.enum(['featured', 'cosmetics', 'merch', 'models']),
  visible: z.boolean(),
});

export type UpdateCreatorShopSettingsInput = z.infer<typeof updateCreatorShopSettingsSchema>;
export const updateCreatorShopSettingsSchema = z.object({
  // Whether the shop is public. Off by default so creators can prep in private.
  enabled: z.boolean().optional(),
  showModels: z.boolean().optional(),
  featuredItemIds: z.array(z.number()).max(CREATOR_SHOP_MAX_FEATURED).optional(),
  description: z.string().max(1000).nullish(),
  coverImageId: z.number().nullish(),
  sections: z.array(creatorShopSectionSchema).optional(),
});

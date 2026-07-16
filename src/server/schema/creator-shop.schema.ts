import * as z from 'zod';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * Creator Shop input contracts. See docs/features/creator-shop.md.
 * Creator cosmetics reuse the existing Cosmetic + CosmeticShopItem tables.
 */

// Business rules (shared by client + server).
export const COSMETIC_PRICE_FLOOR = 500;
export const CREATOR_SHOP_SUBMISSION_FEE = 10000;
export const CREATOR_SHOP_MAX_FEATURED = 6;
// Creator keeps this share of each sale; platform keeps the remainder.
export const CREATOR_SHOP_CREATOR_SHARE = 0.7;
// A price edit beyond ±this fraction of the last approved price re-enters review.
export const PRICE_REVIEW_THRESHOLD = 0.25;

// The single source of truth for how a sale splits. `sellerShare` (0-70, % of
// price) is the reseller's cut out of the creator's 70% pool; the creator keeps
// the remainder; the platform always keeps 30%. Used by the payout AND the UI
// so the numbers shown always match what's paid.
export function computeCreatorShopSplit(price: number, sellerShare = 0) {
  const creatorPool = Math.floor(price * CREATOR_SHOP_CREATOR_SHARE);
  const share = Math.min(70, Math.max(0, sellerShare));
  const sellerAmount = Math.floor(price * (share / 100));
  const creatorAmount = creatorPool - sellerAmount;
  const platformCut = price - creatorPool;
  return { creatorPool, sellerAmount, creatorAmount, platformCut };
}

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
    // Sizes are minimums + a required aspect ratio (not exact) — a larger upload
    // at the same ratio (e.g. a 500×500 avatar frame) is fine.
    case CosmeticType.ProfileDecoration:
      return { width: 120, height: 120, exact: false, requireTransparency: true };
    case CosmeticType.ProfileBackground:
      return { width: 450, height: 144, exact: false, requireTransparency: false };
    case CosmeticType.ContentDecoration:
      return { width: 256, height: 256, exact: false, requireTransparency: true };
    case CosmeticType.Badge:
    default:
      return { width: 144, height: 144, exact: false, requireTransparency: true };
  }
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

// Human-readable aspect ratio, e.g. 144×144 -> "1:1", 450×144 -> "25:9".
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
  // Allow other creators to list this cosmetic, giving the seller this % of the
  // price (0-70, out of the creator's 70% pool).
  sellableByOthers: z.boolean().default(false),
  sellerShare: z.number().int().min(0).max(70).default(0),
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
  // Moderator-only: return site-wide sample data so an empty/unset shop still
  // renders every populated section for design work. Honored only for mods.
  preview: z.boolean().optional(),
});

export type GetEarlyAccessPricesInput = z.infer<typeof getEarlyAccessPricesSchema>;
export const getEarlyAccessPricesSchema = z.object({
  modelVersionIds: z.array(z.number()).max(200),
});

// Cross-creator selling: resell another creator's sellable shop item (by id) in
// your own shop — a reference, not a copy, so the original owns price/inventory.
export type ResoldItemInput = z.infer<typeof resoldItemSchema>;
export const resoldItemSchema = z.object({
  shopItemId: z.number(),
});

export type GetPublicShopItemsInput = z.infer<typeof getPublicShopItemsSchema>;
export const getPublicShopItemsSchema = z.object({
  limit: z.number().min(1).max(100).default(50),
  cursor: z.number().optional(),
  cosmeticTypes: z.array(z.enum(CosmeticType)).optional(),
  // Matches the item title OR the owning creator's username.
  query: z.string().optional(),
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
export const creatorShopSectionKeys = [
  'featured',
  'cosmetics',
  'resold',
  'merch',
  'models',
] as const;
export type CreatorShopSectionKey = (typeof creatorShopSectionKeys)[number];
export const creatorShopSectionSchema = z.object({
  key: z.enum(['featured', 'cosmetics', 'resold', 'merch', 'models']),
  visible: z.boolean(),
});

export type UpdateCreatorShopSettingsInput = z.infer<typeof updateCreatorShopSettingsSchema>;
export const getCreatorShopSettingsSchema = z.object({
  // Moderators may read another creator's settings by passing their userId.
  userId: z.number().optional(),
});
export type GetCreatorShopSettingsInput = z.infer<typeof getCreatorShopSettingsSchema>;

export const updateCreatorShopSettingsSchema = z.object({
  // Moderators may target another creator's shop by passing their userId.
  userId: z.number().optional(),
  // Whether the shop is public. Off by default so creators can prep in private.
  enabled: z.boolean().optional(),
  showModels: z.boolean().optional(),
  featuredItemIds: z.array(z.number()).max(CREATOR_SHOP_MAX_FEATURED).optional(),
  // Other creators' shop items this creator resells (referenced by id).
  resoldItemIds: z.array(z.number()).optional(),
  description: z.string().max(1000).nullish(),
  coverImageId: z.number().nullish(),
  sections: z.array(creatorShopSectionSchema).optional(),
});

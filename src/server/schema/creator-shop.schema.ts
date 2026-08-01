import * as z from 'zod';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * Creator Shop input contracts. See docs/features/creator-shop.md.
 * Creator cosmetics reuse the existing Cosmetic + CosmeticShopItem tables.
 */

// Business rules (shared by client + server).
// Every type is seeded at the same value today; the point of the lookup is that
// emoji economics can be tuned later without touching badges.
const PRICE_FLOOR_DEFAULT = 500;

/** Minimum Buzz a creator may list this cosmetic type for individually. */
export const cosmeticPriceFloor = (type: CosmeticType): number => {
  switch (type) {
    case CosmeticType.Emoji:
    case CosmeticType.Badge:
    case CosmeticType.ProfileDecoration:
    case CosmeticType.ProfileBackground:
    case CosmeticType.ContentDecoration:
    default:
      return PRICE_FLOOR_DEFAULT;
  }
};

/**
 * Per-member contribution a pack must clear for this type. Summed per member
 * rather than multiplied, so a mixed-type pack prices correctly once these
 * diverge; it degenerates to `count × floor` while they're all equal.
 */
export const packItemFloor = (type: CosmeticType): number => {
  switch (type) {
    case CosmeticType.Emoji:
    case CosmeticType.Badge:
    case CosmeticType.ProfileDecoration:
    case CosmeticType.ProfileBackground:
    case CosmeticType.ContentDecoration:
    default:
      return PRICE_FLOOR_DEFAULT;
  }
};

/**
 * Cheap zod gate only — the floor is type-dependent, so the authoritative check
 * is `cosmeticPriceFloor(type)` in the service. This is the minimum across all
 * types, so it can never reject something the real floor would allow.
 */
export const COSMETIC_PRICE_FLOOR_MIN = PRICE_FLOOR_DEFAULT;
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

// Animated artwork limits (maximums only — no minimums). Tune freely.
export const MAX_ANIMATION_FRAMES = 150;
export const MAX_ANIMATION_FPS = 30;
// Compare per-frame delays against this instead of computed fps so a 33ms
// (~30.3fps) encode of a nominal 30fps animation isn't rejected by rounding.
export const MIN_ANIMATION_FRAME_DELAY_MS = Math.floor(1000 / MAX_ANIMATION_FPS);

// Cosmetic subtypes a creator may submit (merch is a separate, later product).
export const creatorCosmeticTypes = [
  CosmeticType.Badge,
  CosmeticType.ProfileDecoration,
  CosmeticType.ContentDecoration,
  CosmeticType.ProfileBackground,
  CosmeticType.Emoji,
] as const;

export type CreatorCosmeticType = (typeof creatorCosmeticTypes)[number];
export const isCreatorCosmeticType = (type: CosmeticType): type is CreatorCosmeticType =>
  (creatorCosmeticTypes as readonly CosmeticType[]).includes(type);

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
    // Exact 128×128 so a 48px jumbo render is clean at 2x DPI.
    case CosmeticType.Emoji:
      return { width: 128, height: 128, exact: true, requireTransparency: true };
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

// Per-side fit adjustment for avatar decorations, stored on the cosmetic's
// `data.offsets` as pixels. Negative extends the frame outside the avatar —
// effectively scaling it up (see decorationFrameStyle).
export const DECORATION_OFFSET_LIMIT = 5;
const cosmeticOffsetSideSchema = z
  .number()
  .int()
  .min(-DECORATION_OFFSET_LIMIT)
  .max(DECORATION_OFFSET_LIMIT);
export type CosmeticOffsets = z.infer<typeof cosmeticOffsetsSchema>;
export const cosmeticOffsetsSchema = z.object({
  top: cosmeticOffsetSideSchema,
  right: cosmeticOffsetSideSchema,
  bottom: cosmeticOffsetSideSchema,
  left: cosmeticOffsetSideSchema,
});

export type SubmitCreatorShopItemInput = z.infer<typeof submitCreatorShopItemSchema>;
export const submitCreatorShopItemSchema = z.object({
  cosmeticType: z.enum(creatorCosmeticTypes),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).nullish(),
  // CF image id from the upload. The server builds the cosmetic `data` from this
  // and validates the artwork itself (format/dimensions/transparency).
  imageUrl: z.string().min(1),
  animated: z.boolean().optional(),
  // Emoji only — the `:slug:` users type. Required for Emoji, ignored otherwise.
  slug: z.string().optional(),
  price: z.number().int().min(COSMETIC_PRICE_FLOOR_MIN),
  availableQuantity: z.number().int().positive().nullish(),
  buzzType: z.enum(['green', 'yellow', 'blue']).default('yellow'),
  // Allow other creators to list this cosmetic, giving the seller this % of the
  // price (0-70, out of the creator's 70% pool).
  sellableByOthers: z.boolean().default(false),
  sellerShare: z.number().int().min(0).max(70).default(0),
  // Accept Blue Buzz from buyers (fully or partially); the creator is paid
  // blue for the blue-paid portion.
  acceptsBlueBuzz: z.boolean().default(false),
  // ProfileDecoration only — per-side fit adjustment (ignored for other types).
  offsets: cosmeticOffsetsSchema.nullish(),
});

export type UpdateCreatorShopItemInput = z.infer<typeof updateCreatorShopItemSchema>;
export const updateCreatorShopItemSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullish(),
  // Only present when replacing artwork (blocked once the item is published).
  imageUrl: z.string().optional(),
  animated: z.boolean().optional(),
  price: z.number().int().min(COSMETIC_PRICE_FLOOR_MIN).optional(),
  availableQuantity: z.number().int().positive().nullish(),
  // Payment term like price/quantity — editable on published items, no re-review.
  acceptsBlueBuzz: z.boolean().optional(),
  // ProfileDecoration only — null clears the adjustment; treated as a content
  // change (same rules as name/description/artwork).
  offsets: cosmeticOffsetsSchema.nullish(),
  // Emoji only. Omitted leaves the existing slug alone — replacing artwork must
  // not silently drop it, since owners' `:slug:` text depends on it.
  slug: z.string().optional(),
});

export type SetCreatorShopItemListedInput = z.infer<typeof setCreatorShopItemListedSchema>;
export const setCreatorShopItemListedSchema = z.object({
  id: z.number(),
  listed: z.boolean(),
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

// Site-wide community cosmetics hub on /shop — one feed of every published
// creator cosmetic from public shops, filterable by type.
export type GetCommunityCosmeticsInput = z.infer<typeof getCommunityCosmeticsSchema>;
export const getCommunityCosmeticsSchema = z.object({
  limit: z.number().min(1).max(100).default(40),
  cursor: z.number().optional(),
  cosmeticTypes: z.array(z.enum(CosmeticType)).optional(),
});

export type ReviewCreatorShopItemInput = z.infer<typeof reviewCreatorShopItemSchema>;
export const reviewCreatorShopItemSchema = z
  .object({
    id: z.number(),
    // reject = terminal; request-changes = creator can edit & resubmit;
    // revert = pull a published item back into the review queue.
    action: z.enum(['approve', 'reject', 'request-changes', 'revert']),
    rejectionReason: z.string().max(1000).optional(),
  })
  .refine((v) => v.action === 'approve' || !!v.rejectionReason?.length, {
    message: 'A note is required when rejecting, requesting changes, or reverting',
    path: ['rejectionReason'],
  });

export type GetReviewQueueInput = z.infer<typeof getReviewQueueSchema>;
export const getReviewQueueSchema = z.object({
  limit: z.number().min(1).max(100).default(20),
  cursor: z.number().optional(),
  // Defaults to PendingReview in the service; moderators can also review
  // Published / Rejected / Archived, and filter to a single creator (by
  // username or id) and/or cosmetic types.
  status: z.enum(CosmeticShopItemStatus).optional(),
  username: z.string().optional(),
  userId: z.number().optional(),
  cosmeticTypes: z.array(z.enum(CosmeticType)).optional(),
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

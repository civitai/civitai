import { Flags } from '~/shared/utils/flags';
import type { PlacementSurface } from '~/shared/utils/placement';

/**
 * Paid promotions on someone else's model page: a post in its gallery, or a
 * model card in its Suggested Resources. Both are placements on the page's
 * model, paid in full to the host when they accept.
 */
export const PROMOTION_SURFACES = [
  'galleryPromotion',
  'modelPromotion',
] as const satisfies readonly PlacementSurface[];
export type PromotionSurface = (typeof PROMOTION_SURFACES)[number];

export const isPromotionSurface = (surface: string): surface is PromotionSurface =>
  (PROMOTION_SURFACES as readonly string[]).includes(surface);

export const PROMOTION_TARGET_TYPE = 'model' as const;

/** Run lengths a buyer can pick, in days. */
export const PROMOTION_RUN_DAYS = [1, 3, 7] as const;
export type PromotionRunDays = (typeof PROMOTION_RUN_DAYS)[number];

export const isPromotionRunDays = (days: unknown): days is PromotionRunDays =>
  (PROMOTION_RUN_DAYS as readonly unknown[]).includes(days);

/**
 * How long after accepting a host may not end a promotion. The same week the
 * sticker and remix surfaces hold an owner to, because the host is paid at
 * accept: without it a host could accept, keep the Buzz and end the run at once.
 *
 * At least as long as the longest run, so a host never ends an accepted run.
 */
export const PROMOTION_REMOVAL_LOCK_HOURS = 24 * 7;

/** What the buyer pays: the host's daily price for every day of the run. */
export const promotionAmount = (dailyPrice: number, days: PromotionRunDays) => dailyPrice * days;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A run starts when the host accepts. There are no scheduled start dates. */
export const promotionRunEndsAt = (acceptedAt: Date, days: number) =>
  new Date(acceptedAt.getTime() + days * DAY_MS);

export const isPromotionLive = (
  { acceptedAt, days }: { acceptedAt: Date; days: number },
  now = new Date()
) => acceptedAt <= now && now < promotionRunEndsAt(acceptedAt, days);

/** A model page link (`/models/123/...`) or a bare id. */
export function parseHostModelId(value: string) {
  const trimmed = value.trim();
  const match = /^\d+$/.test(trimmed) ? trimmed : /\/models\/(\d+)/.exec(trimmed)?.[1];
  const id = match ? Number(match) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const positiveInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

/** `galleryPromotion` payload: the promoted post, and the host versions it used. */
export type GalleryPromotionData = {
  postId: number;
  days: PromotionRunDays;
  /** The host model's versions the post was made with. It shows in those galleries. */
  modelVersionIds: number[];
};

/** `modelPromotion` payload: the promoted model. */
export type ModelPromotionData = {
  modelId: number;
  days: PromotionRunDays;
};

export const parseGalleryPromotionData = (value: unknown): GalleryPromotionData | null => {
  if (!value || typeof value !== 'object') return null;
  const { postId, days, modelVersionIds } = value as Record<string, unknown>;
  if (!positiveInt(postId) || !isPromotionRunDays(days)) return null;
  if (!Array.isArray(modelVersionIds) || !modelVersionIds.length) return null;
  if (!modelVersionIds.every(positiveInt)) return null;
  return { postId, days, modelVersionIds };
};

export const parseModelPromotionData = (value: unknown): ModelPromotionData | null => {
  if (!value || typeof value !== 'object') return null;
  const { modelId, days } = value as Record<string, unknown>;
  if (!positiveInt(modelId) || !isPromotionRunDays(days)) return null;
  return { modelId, days };
};

export type PromotedImage = { id: number; nsfwLevel: number; tagIds: number[] };

export type GalleryHostSettings = {
  hiddenUserIds: number[];
  hiddenTagIds: number[];
  hiddenImageIds: number[];
  /** The gallery's browsing-level cap, as a flag. `undefined` when the host set none. */
  level?: number;
};

export type GalleryPromotionRefusal =
  | 'noImages'
  | 'unrated'
  | 'aboveMaxLevel'
  | 'aboveGalleryLevel'
  | 'hiddenByHost';

/**
 * Whether a post may be promoted in a host's gallery, judged against the host's
 * gallery settings as they are now. Called at purchase and again at review. An
 * accepted run is never re-judged against a later change (the removal lock).
 *
 * `hiddenByHost` covers the promoter, a tag and an image alike, so a refusal
 * never tells the buyer which of the host's private lists they are on.
 */
export function galleryPromotionRefusal({
  placerId,
  images,
  host,
  maxLevel,
}: {
  placerId: number;
  images: PromotedImage[];
  host: GalleryHostSettings;
  maxLevel: number;
}): GalleryPromotionRefusal | null {
  if (!images.length) return 'noImages';
  if (images.some((image) => !image.nsfwLevel)) return 'unrated';
  if (images.some((image) => !Flags.hasFlag(maxLevel, image.nsfwLevel))) return 'aboveMaxLevel';
  const galleryLevel = host.level;
  if (galleryLevel && images.some((image) => !Flags.hasFlag(galleryLevel, image.nsfwLevel)))
    return 'aboveGalleryLevel';

  const hiddenTags = new Set(host.hiddenTagIds);
  const hiddenImages = new Set(host.hiddenImageIds);
  const hidden =
    host.hiddenUserIds.includes(placerId) ||
    images.some(
      (image) => hiddenImages.has(image.id) || image.tagIds.some((tagId) => hiddenTags.has(tagId))
    );
  return hidden ? 'hiddenByHost' : null;
}

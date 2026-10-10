import { Flags } from '~/shared/utils/flags';
import type { PlacementSurface } from '~/shared/utils/placement';
import { parseCivitaiUrlSafe } from '~/utils/civitai-url';

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
 * Where a sponsored item goes in a list: after the pinned items, or second when
 * there are none, so the list still opens on an organic item. The gallery server
 * and client both splice by this, and must agree.
 */
export const sponsoredSlotIndex = (pinnedCount: number, length: number) =>
  pinnedCount || Math.min(1, length);

/**
 * The level a sponsored gallery post is fetched at: the viewer's level before
 * the gallery's current cap, held to what the run may be served at. Both
 * request levels arrive already clamped to the domain by `applyDomainFeature`.
 */
export const sponsoredBrowsingLevel = ({
  browsingLevel,
  preCapBrowsingLevel,
  servingLevel,
}: {
  browsingLevel: number;
  preCapBrowsingLevel?: number;
  servingLevel: number;
}) => Flags.intersection(preCapBrowsingLevel ?? browsingLevel, servingLevel);

/** What a buyer is told a decline costs them, from the host's percent and the fee in Buzz. */
export const promotionDeclineTerms = (percent: number, fee: number) =>
  fee > 0
    ? `If they decline, they keep ${percent}% (${fee} Buzz) and the rest comes back.`
    : 'If they decline, all of it comes back.';

export const promotionRunLabel = (days: number) => (days === 1 ? '1 day' : `${days} days`);

/** How many rows a promotion queue returns. */
export const PROMOTION_QUEUE_LIMIT = 50;

/** What the buyer pays: the host's daily price for every day of the run. */
export const promotionAmount = (dailyPrice: number, days: PromotionRunDays) => dailyPrice * days;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A run starts when the host accepts. There are no scheduled start dates. */
export const promotionRunEndsAt = (acceptedAt: Date, days: number) =>
  new Date(acceptedAt.getTime() + days * DAY_MS);

/** `endsAt` is the end frozen at accept; a run accepted without one ends `days` after. */
export const isPromotionLive = (
  { acceptedAt, days, endsAt }: { acceptedAt: Date; days: number; endsAt?: string },
  now = new Date()
) => acceptedAt <= now && now < (endsAt ? new Date(endsAt) : promotionRunEndsAt(acceptedAt, days));

/** A link to one of our model pages, or a bare model id. */
export function parseHostModelId(value: string) {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  const ref = parseCivitaiUrlSafe(trimmed);
  return ref?.type === 'model' ? ref.modelId : null;
}

const positiveInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

/**
 * Written when the host accepts, so everyone is held to what was sold: the run
 * ends at `endsAt`, and until then it is served at the page's browsing-level cap
 * as it stood at accept. A host who lowers their cap mid-run cannot hide a run
 * they were already paid for.
 */
export type PromotionAcceptance = { acceptedLevel: number; endsAt: string };

/** Both or neither; a half-written acceptance is refused as malformed. */
function parseAcceptance(value: Record<string, unknown>): Partial<PromotionAcceptance> | null {
  const { acceptedLevel, endsAt } = value;
  if (acceptedLevel === undefined && endsAt === undefined) return {};
  if (!positiveInt(acceptedLevel)) return null;
  if (typeof endsAt !== 'string' || Number.isNaN(Date.parse(endsAt))) return null;
  return { acceptedLevel, endsAt };
}

/** `galleryPromotion` payload: the promoted post, and the host versions it used. */
export type GalleryPromotionData = {
  postId: number;
  days: PromotionRunDays;
  /** The host model's versions the post was made with. It shows in those galleries. */
  modelVersionIds: number[];
  /** The post's images as the host last judged them; only these are shown. */
  imageIds: number[];
} & Partial<PromotionAcceptance>;

/** `modelPromotion` payload: the promoted model. */
export type ModelPromotionData = {
  modelId: number;
  days: PromotionRunDays;
} & Partial<PromotionAcceptance>;

export const parseGalleryPromotionData = (value: unknown): GalleryPromotionData | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const { postId, days, modelVersionIds, imageIds } = record;
  if (!positiveInt(postId) || !isPromotionRunDays(days)) return null;
  if (!Array.isArray(modelVersionIds) || !modelVersionIds.length) return null;
  if (!modelVersionIds.every(positiveInt)) return null;
  if (!Array.isArray(imageIds) || !imageIds.length || !imageIds.every(positiveInt)) return null;
  const acceptance = parseAcceptance(record);
  if (!acceptance) return null;
  return { postId, days, modelVersionIds, imageIds, ...acceptance };
};

export const parseModelPromotionData = (value: unknown): ModelPromotionData | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const { modelId, days } = record;
  if (!positiveInt(modelId) || !isPromotionRunDays(days)) return null;
  const acceptance = parseAcceptance(record);
  if (!acceptance) return null;
  return { modelId, days, ...acceptance };
};

export type PromotedImage = { id: number; nsfwLevel: number; tagIds: number[] };

export type GalleryHostSettings = {
  hiddenUserIds: number[];
  hiddenTagIds: number[];
  hiddenImageIds: number[];
};

export type GalleryPromotionRefusal = 'noImages' | 'unrated' | 'aboveMaxLevel' | 'hiddenByHost';

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

  const hiddenTags = new Set(host.hiddenTagIds);
  const hiddenImages = new Set(host.hiddenImageIds);
  const hidden =
    host.hiddenUserIds.includes(placerId) ||
    images.some(
      (image) => hiddenImages.has(image.id) || image.tagIds.some((tagId) => hiddenTags.has(tagId))
    );
  return hidden ? 'hiddenByHost' : null;
}

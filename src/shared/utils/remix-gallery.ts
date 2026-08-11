import { NsfwLevel } from '~/server/common/enums';

/**
 * What a remix-gallery placement carries. Opaque to the placement foundation,
 * which never reads inside `Placement.data`.
 *
 * `remixOfId` is recorded when the submitted image has one and is never
 * required. It exists only for onsite generations that went through the remix
 * entry point, so requiring it would refuse local generations, uploads,
 * img2video and edit-model results — the cases the feature exists for.
 */
export type RemixGalleryPlacementData = {
  imageId: number;
  remixOfId?: number | null;
  /** Set by the owner. Pinned entries render before the rotation. */
  pinnedAt?: string | null;
  /** Order among pinned entries only. The rest are shuffled. */
  position?: number | null;
};

export const isRemixGalleryPlacementData = (value: unknown): value is RemixGalleryPlacementData =>
  !!value &&
  typeof value === 'object' &&
  Number.isInteger((value as RemixGalleryPlacementData).imageId);

/**
 * How many entries an owner may pin. Pinned entries displace nothing — they
 * render above the rotation — so the cap is what stops a gallery becoming a
 * fixed list and taking the rotation's value with it.
 */
export const REMIX_GALLERY_MAX_PINNED = 4;

/** Entries per page. The rest arrive on scroll against the same seed. */
export const REMIX_GALLERY_PAGE_SIZE = 12;

/** Cards per row, used to trim a page to a whole number of rows. */
export const REMIX_GALLERY_ROW_WIDTH = 4;

/**
 * How many pending submissions one submitter may have waiting on one owner.
 *
 * Same reasoning as the sticker cap: the cost is already real Buzz, so this is
 * about a review queue the owner can work through rather than about spam
 * economics. Their remedy for the rest is block.
 */
export const REMIX_GALLERY_MAX_PENDING_PER_OWNER = 10;

export type RemixGalleryContentRule =
  /** The submission may not exceed the host image's rating. */
  | 'atOrBelow'
  /** Anything the site allows. Some creators want their work taken further. */
  | 'any';

export const REMIX_GALLERY_DEFAULT_CONTENT_RULE: RemixGalleryContentRule = 'atOrBelow';

export const remixGalleryContentRule = (
  settings: Record<string, unknown> | null | undefined
): RemixGalleryContentRule =>
  settings?.contentRule === 'any' ? 'any' : REMIX_GALLERY_DEFAULT_CONTENT_RULE;

/**
 * Whether a submission's rating is acceptable for a host under a rule.
 *
 * `nsfwLevel` is a single bitwise flag per image and the levels are ordered
 * powers of two, so "at or below" is a numeric comparison rather than a flag
 * test.
 *
 * A level of 0 means unscanned or unrated and is refused under **both** rules.
 * It is not a safe value, it is an absent one, and treating it as PG is how an
 * unscanned image lands on someone else's page.
 */
export function remixGalleryLevelAllowed({
  rule,
  submissionLevel,
  hostLevel,
}: {
  rule: RemixGalleryContentRule;
  submissionLevel: number;
  hostLevel: number;
}) {
  if (!submissionLevel || submissionLevel === NsfwLevel.Blocked) return false;
  if (rule === 'any') return true;
  // An unrated host cannot ceiling anything, so it fails closed rather than
  // admitting everything.
  if (!hostLevel) return false;
  return submissionLevel <= hostLevel;
}

/**
 * Hours since the epoch, the same value the contest-collection shuffle uses.
 *
 * That seed is cached in sysRedis and refreshed hourly by a cron, but the cron
 * writes exactly this expression and the cached read falls back to it on any
 * error — so computing it here is the same number without the round trip, and
 * gallery ordering rotates in step with collections rather than on its own
 * clock.
 */
export const remixGalleryShuffleSeed = () => Math.floor(Date.now() / 3_600_000);

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

/**
 * How many rows either review queue returns in one request.
 *
 * Neither queue pages, so this is also the point at which a busy owner stops
 * being shown everything — the queues say so rather than looking complete.
 */
export const REMIX_GALLERY_QUEUE_LIMIT = 50;

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

/**
 * How long an approved entry is protected from the owner removing it.
 *
 * Approval settles the money immediately, so without this an owner could accept
 * a submission, take the Buzz and remove the entry before anyone saw it — the
 * submitter pays in full for nothing, and it is indistinguishable from an honest
 * removal. A week is long enough that the entry was genuinely shown.
 *
 * A moderator is not bound by it: a takedown is a moderation record, not an
 * owner decision, and the abusive cases are exactly the ones that must not wait.
 */
export const REMIX_GALLERY_REMOVAL_LOCK_HOURS = 24 * 7;

/** When an entry approved at `approvedAt` may be removed by its owner. */
export const remixGalleryRemovableAt = (approvedAt: Date | string) =>
  new Date(new Date(approvedAt).getTime() + REMIX_GALLERY_REMOVAL_LOCK_HOURS * 60 * 60 * 1000);

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
 * The hard ceiling on what may be submitted into a host image flagged as
 * depicting a minor. Not a creator preference and not overridable by one.
 */
export const REMIX_GALLERY_MINOR_HOST_MAX_LEVEL = NsfwLevel.PG13;

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
 *
 * `hostMinor` is required rather than optional so a caller cannot reach this
 * without having loaded the flag: the submitted image being clean says nothing
 * about the host, and a remix can arrive from an external generation, so the
 * generator's own refusals are not in the path.
 */
export function remixGalleryLevelAllowed({
  rule,
  submissionLevel,
  hostLevel,
  hostMinor,
}: {
  rule: RemixGalleryContentRule;
  submissionLevel: number;
  hostLevel: number;
  hostMinor: boolean;
}) {
  if (!submissionLevel || submissionLevel === NsfwLevel.Blocked) return false;
  return submissionLevel <= remixGalleryMaxSubmissionLevel({ rule, hostLevel, hostMinor });
}

/**
 * The highest rating this gallery will take, as a number the picker can filter
 * on before anyone pays.
 *
 * Expressed as the ceiling rather than as a second copy of the rules, because
 * `remixGalleryLevelAllowed` is defined in terms of it — a picker that filtered
 * on its own reading of the rules would drift from what the mutation refuses,
 * and the direction it drifts in decides whether someone is charged for a
 * submission that was never going to be accepted.
 *
 * Zero means nothing may be submitted: an unrated host cannot ceiling anything,
 * so `atOrBelow` fails closed rather than admitting everything.
 */
export function remixGalleryMaxSubmissionLevel({
  rule,
  hostLevel,
  hostMinor,
}: {
  rule: RemixGalleryContentRule;
  hostLevel: number;
  hostMinor: boolean;
}) {
  const ceiling = rule === 'any' ? NsfwLevel.XXX : hostLevel;
  // The one ceiling `any` does not lift.
  return hostMinor ? Math.min(ceiling, REMIX_GALLERY_MINOR_HOST_MAX_LEVEL) : ceiling;
}

/** Whether a refusal from `remixGalleryLevelAllowed` was the minor-host cap. */
export const remixGalleryBlockedByMinorHost = ({
  submissionLevel,
  hostMinor,
}: {
  submissionLevel: number;
  hostMinor: boolean;
}) => hostMinor && submissionLevel > REMIX_GALLERY_MINOR_HOST_MAX_LEVEL;

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

import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';

/**
 * Crucible feature constants
 * These constants define limits and configuration for the Crucible feature
 */

/**
 * Maximum entry fee in Buzz that can be charged for joining a crucible.
 * Set to 1M Buzz to prevent integer overflow in prize pool calculations.
 */
export const CRUCIBLE_MAX_ENTRY_FEE = 1_000_000;

/**
 * Maximum number of entries per user per crucible.
 * Set to 10K to prevent abuse and ensure fair competition.
 */
export const CRUCIBLE_MAX_ENTRIES = 10_000;

/**
 * Cost in Buzz for each crucible duration option.
 * Keys are duration in hours.
 */
export const CRUCIBLE_DURATION_COSTS: Record<number, number> = {
  8: 0, // 8 hours - free
  24: 500, // 24 hours
  72: 1000, // 3 days
  168: 2000, // 7 days
};

/**
 * Cost in Buzz for customizing the prize distribution.
 * This fee is charged when the crucible creator changes the default prize percentages.
 */
export const CRUCIBLE_PRIZE_CUSTOMIZATION_COST = 500;

/**
 * Cost in Buzz for restricting entries to specific model versions (`allowedResources`).
 */
export const CRUCIBLE_RESOURCE_REQUIREMENTS_COST = 500;

/** Matches ModelVersionMultiSelect's default `maxSelections`. */
export const CRUCIBLE_MAX_ALLOWED_RESOURCES = 10;

/** How far ahead a crucible's start may be scheduled. */
export const CRUCIBLE_MAX_START_LEAD_DAYS = 30;

export const getMaxCrucibleStartAt = (from: Date = new Date()) =>
  new Date(from.getTime() + CRUCIBLE_MAX_START_LEAD_DAYS * 24 * 60 * 60 * 1000);

/**
 * A live ranking predisposes judges, so scores and positions stay hidden — from everyone but the
 * entry's own owner — until the crucible is over.
 */
export const crucibleRankingsAreFinal = (status: CrucibleStatus) =>
  status === CrucibleStatus.Completed || status === CrucibleStatus.Cancelled;

/**
 * Media types entries may be. Audio is excluded: judging is a side-by-side visual comparison.
 */
export const CRUCIBLE_CONTENT_TYPES = [MediaType.image, MediaType.video] as const;
export type CrucibleContentType = (typeof CRUCIBLE_CONTENT_TYPES)[number];

/**
 * Maximum Buzz a creator can seed into a crucible's prize pool at setup.
 * Matches CHALLENGE_MAX_INITIAL_PRIZE so the two seeded-pool features share one ceiling, and sits
 * two orders below int4 so `seededPrizePool + entryFee * entryCount` cannot overflow the column.
 */
export const CRUCIBLE_MAX_SEEDED_PRIZE_POOL = 10_000_000;

/**
 * The only values a crucible's `maxClipSeconds` may take. Topped just under
 * `constants.mediaUpload.maxVideoDurationSeconds`: a longer limit could never reject anything,
 * since no uploaded video can exceed that cap.
 */
export const CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS = [10, 15, 30, 60, 120, 240] as const;

/**
 * The only values a crucible's `minViewSeconds` may take. A judge is asked to watch BOTH clips
 * before either vote unlocks, so the wait a setting buys is twice its value.
 */
export const CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS = [3, 6, 10, 15, 30] as const;

/**
 * Both video settings are meaningless on an image crucible, and NULL is the only value that reads
 * as "no rule" — mirrored by the `Crucible_video_settings_require_video` CHECK constraint.
 */
export const crucibleSupportsVideoSettings = (contentType: MediaType) =>
  contentType === MediaType.video;

/**
 * Whether a clip may be entered. A crucible with no `maxClipSeconds` takes any length, and a
 * video whose duration was never recorded is accepted rather than blocked on missing metadata.
 */
export const clipLengthAllowed = (durationSeconds: number | null, maxClipSeconds: number | null) =>
  maxClipSeconds == null || durationSeconds == null || durationSeconds <= maxClipSeconds;

/**
 * `timeupdate` fires about every 250ms during playback. A gap larger than this is a seek or a
 * resume after a pause, not time anyone spent watching.
 */
export const CRUCIBLE_PLAYBACK_SAMPLE_CEILING_MS = 1000;

/**
 * Playback watched so far, advanced by one `timeupdate`.
 *
 * Accumulates the gaps BETWEEN samples rather than reading `currentTime` directly, so the figure
 * is time the judge actually sat through: seeking to the end jumps further than the ceiling and
 * contributes nothing, scrubbing backwards is negative and contributes nothing, and a paused or
 * backgrounded clip stops firing the event and so stops counting.
 *
 * `previousTime` null means this is the first sample of a clip, which establishes the baseline.
 */
export const accumulatePlaybackMs = ({
  watchedMs,
  previousTime,
  currentTime,
}: {
  watchedMs: number;
  previousTime: number | null;
  currentTime: number;
}) => {
  if (previousTime == null) return watchedMs;

  const deltaMs = (currentTime - previousTime) * 1000;
  if (deltaMs <= 0 || deltaMs > CRUCIBLE_PLAYBACK_SAMPLE_CEILING_MS) return watchedMs;

  return watchedMs + deltaMs;
};

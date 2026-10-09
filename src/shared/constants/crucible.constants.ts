import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';

/**
 * Crucible feature constants
 * These constants define limits and configuration for the Crucible feature
 */

/** The minimum is nonzero because entry fees are what fund the prize pool. */
export const CRUCIBLE_MIN_ENTRY_FEE = 10;
export const CRUCIBLE_MAX_ENTRY_FEE = 1_000;

/** Per-user entry cap. A viewer's own entries render unpaged on the detail page. */
export const CRUCIBLE_MAX_ENTRIES = 20;

/**
 * How close to the end entrants are warned, and when entries close, as a share of the run. A late
 * entry can't collect the votes it needs to place: each judge votes on an entry at most
 * CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY times, so its votes are capped by how many judges come
 * back after it is posted.
 */
export const CRUCIBLE_ENTRY_WARNING_PERCENT = { min: 10, max: 50, default: 20 } as const;
export const CRUCIBLE_ENTRY_CUTOFF_PERCENT = { min: 0, max: 40, default: 10 } as const;
export const CRUCIBLE_ENTRY_WINDOW_ORDER_MESSAGE =
  'Entries must close later than the late-entry warning starts';
export const CRUCIBLE_ENTRIES_CLOSED_MESSAGE =
  'Entries are closed. This crucible stops taking entries near the end so every entry has time to be judged.';

/** Judging needs a pair, so the cap is at least 2; `maxTotalEntries` is int4, so the ceiling must stay under 2^31. */
export const CRUCIBLE_MIN_TOTAL_ENTRIES = 2;
export const CRUCIBLE_MAX_TOTAL_ENTRIES = 100_000;

/** Following only buys something while the crucible still has an ending ahead of it. */
export const CRUCIBLE_FOLLOWABLE_STATUSES: CrucibleStatus[] = [
  CrucibleStatus.Pending,
  CrucibleStatus.Active,
];

/** Throwaway accounts score 0, so a bot farm has to earn real engagement before its votes count. */
export const CRUCIBLE_JUDGE_MIN_CREATOR_SCORE = 500;
export const CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE = `You need a creator score of at least ${CRUCIBLE_JUDGE_MIN_CREATOR_SCORE} to judge crucibles.`;

export const CRUCIBLE_NAME_MAX_LENGTH = 100;
export const CRUCIBLE_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Cost in Buzz for each crucible duration option.
 * Keys are duration in hours.
 */
export const CRUCIBLE_DURATION_COSTS: Record<number, number> = {
  24: 0,
  72: 0,
  168: 1000,
};

export const CRUCIBLE_DEFAULT_DURATION = 24;

/**
 * Cost in Buzz for customizing the prize distribution.
 * This fee is charged when the crucible creator changes the default prize percentages.
 */
export const CRUCIBLE_PRIZE_CUSTOMIZATION_COST = 500;

export const CRUCIBLE_DEFAULT_PRIZE_POSITIONS: Readonly<Record<string, number>> = {
  '1': 50,
  '2': 30,
  '3': 20,
};

export const CRUCIBLE_MAX_PRIZE_POSITIONS = 100;

/** Decides the customization fee — compute it from the positions, never from a client-sent flag. */
export const isCustomPrizeDistribution = (prizePositions: Record<string, number>) => {
  const keys = Object.keys(prizePositions);
  const defaultKeys = Object.keys(CRUCIBLE_DEFAULT_PRIZE_POSITIONS);
  return (
    keys.length !== defaultKeys.length ||
    defaultKeys.some((key) => prizePositions[key] !== CRUCIBLE_DEFAULT_PRIZE_POSITIONS[key])
  );
};

export const getPrizeDistributionTotal = (prizePositions: Record<string, number>) =>
  Object.values(prizePositions).reduce((sum, value) => sum + value, 0);

/**
 * Cost in Buzz for restricting entries to specific model versions (`allowedResources`).
 * Restricting by base model (`allowedBaseModels`) is free.
 */
export const CRUCIBLE_RESOURCE_REQUIREMENTS_COST = 500;

/** Matches ModelVersionMultiSelect's default `maxSelections`. */
export const CRUCIBLE_MAX_ALLOWED_RESOURCES = 10;

export const CRUCIBLE_MAX_ALLOWED_BASE_MODELS = 10;

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

export { hasCrucibleStarted } from '@civitai/shared/crucible';

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

/** How far past the watch cap a clip may run and still play to its end rather than stop at the cap. */
export const CRUCIBLE_PLAY_TO_END_TOLERANCE = 0.35;

export const playsToEnd = (durationSeconds: number | null, capSeconds: number) =>
  capSeconds > 0 &&
  durationSeconds != null &&
  durationSeconds > capSeconds &&
  durationSeconds <= capSeconds * (1 + CRUCIBLE_PLAY_TO_END_TOLERANCE);

/** Bounds how far one judge can move a single entry. */
export const CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY = 5;

import type { JobQueueType } from '@civitai/db-schema/enums';

/** Days a blocked image's row and bytes are held before `remove-blocked-images` destroys them. */
export const BLOCKED_IMAGE_RETENTION_DAYS = 7;

/** Days a replaced image stays fetchable before `remove-replaced-images` reaps it. */
export const REPLACED_IMAGE_RETENTION_DAYS = 30;

/** Hours a post waits before `job-queue-clean-if-empty` will delete it for having no images. */
export const CLEAN_IF_EMPTY_DELAY_HOURS = 24;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * How long a row of each type may sit before it counts as OVERDUE — a queue that is not draining.
 *
 * 🔴 Not the same question as "how deep is the queue". Three of these types hold rows on purpose, so
 * depth alone reads as an incident when nothing is wrong: `BlockedImageDelete` sat at 63k rows with a
 * 7-day tail while working exactly as designed. Each figure below is that type's own deliberate wait
 * plus enough slack for the cron that drains it to come round, so a non-zero count here means the
 * drain has actually stopped.
 *
 * `0` means nothing in this repo consumes the type, so any row is stranded the moment it is written.
 */
export const JOB_QUEUE_OVERDUE_MINUTES: Record<JobQueueType, number> = {
  // `job-queue-cleanup`, every minute.
  CleanUp: MINUTES_PER_HOUR,
  // No producer and no consumer anywhere in the workspace.
  UpdateMetrics: 0,
  // `update-nsfw-levels` every minute (10k/run); the Collection lane every 10 minutes (500/run).
  UpdateNsfwLevel: MINUTES_PER_HOUR,
  // No producer and no consumer anywhere in the workspace.
  UpdateSearchIndex: 0,
  // Waits CLEAN_IF_EMPTY_DELAY_HOURS, then an hourly job.
  CleanIfEmpty: CLEAN_IF_EMPTY_DELAY_HOURS * MINUTES_PER_HOUR + 12 * MINUTES_PER_HOUR,
  // `entity-moderation-queues`, every 5 minutes.
  ModerationRequest: MINUTES_PER_HOUR,
  // Waits BLOCKED_IMAGE_RETENTION_DAYS, then an hourly job taking 15k.
  BlockedImageDelete: (BLOCKED_IMAGE_RETENTION_DAYS + 1) * MINUTES_PER_DAY,
  // `ingest-images` every 5 minutes, but an Error row legitimately sits here for hours across
  // retries — the main app's oldest-age gauge is documented as context for the same reason.
  ImageScan: MINUTES_PER_DAY,
  // Waits REPLACED_IMAGE_RETENTION_DAYS, then a once-daily job.
  ReplacedImageDelete: (REPLACED_IMAGE_RETENTION_DAYS + 1) * MINUTES_PER_DAY,
};

/** Types nothing drains: a row of one of these is stranded on arrival, not merely waiting. */
export const JOB_QUEUE_UNCONSUMED_TYPES = Object.entries(JOB_QUEUE_OVERDUE_MINUTES)
  .filter(([, minutes]) => minutes === 0)
  .map(([type]) => type as JobQueueType);

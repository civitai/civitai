import { Prisma } from '@prisma/client';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

// The `retry-failed-text-moderation` job's limits, apart from the job so a service can read them
// without importing the job and every moderation adapter it reaches.
export const TEXT_MODERATION_PENDING_TIMEOUT_MINUTES = 30; // 30 min for stuck Pending rows
export const TEXT_MODERATION_RETRY_LIMIT = 9;
// A check that spent its retries is sent again after this, with a fresh retry budget.
export const TEXT_MODERATION_EXHAUSTED_RESEND_AFTER_HOURS = 24;

/** A check row in one of these is the retry job's to send again, until its retries run out. */
export const TEXT_MODERATION_RETRY_STATUSES: EntityModerationStatus[] = [
  EntityModerationStatus.Failed,
  EntityModerationStatus.Expired,
  EntityModerationStatus.Canceled,
];

/** The same set for raw SQL, as literals: the column is an enum, and a bound text param is not. */
export const textModerationRetryStatusSql = Prisma.raw(
  `(${TEXT_MODERATION_RETRY_STATUSES.map((status) => `'${status}'`).join(', ')})`
);

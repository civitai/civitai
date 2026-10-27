import dayjs from '~/shared/utils/dayjs';
import { dbRead } from '~/server/db/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import {
  LOCK_REVIEW_COOLDOWN_DAYS,
  LOCK_REVIEW_REPORT_REASON,
  lockReviewQueueLabel,
  REQUESTABLE_LOCKS,
  requestableLocks,
  type RequestableLock,
} from '~/shared/constants/lock-review.constants';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';

export type LockReviewState = {
  requestable: RequestableLock[];
  pending: boolean;
  /** Set while a recent request was closed with every setting it named still locked. */
  reopensAt: Date | null;
};

const lockReviewReports = (modelId: number) => ({
  reason: ReportReason.AdminAttention,
  model: { modelId },
  details: { path: ['reason'], equals: LOCK_REVIEW_REPORT_REASON },
});

export async function getLockReviewState({
  modelId,
  userId,
  isModerator,
}: {
  modelId: number;
  userId: number;
  isModerator?: boolean;
}): Promise<LockReviewState | null> {
  if (isModerator) return null;
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    select: { userId: true, lockedProperties: true },
  });
  if (!model || model.userId !== userId) return null;

  const locked = model.lockedProperties ?? [];
  const requestable = requestableLocks(locked);
  if (!requestable.length) return { requestable, pending: false, reopensAt: null };

  const [pending, recentlyClosed] = await Promise.all([
    dbRead.report.findFirst({
      where: { ...lockReviewReports(modelId), status: ReportStatus.Pending },
      select: { id: true },
    }),
    dbRead.report.findMany({
      where: {
        ...lockReviewReports(modelId),
        status: { in: [ReportStatus.Actioned, ReportStatus.Unactioned] },
        statusSetAt: { gt: dayjs().subtract(LOCK_REVIEW_COOLDOWN_DAYS, 'day').toDate() },
      },
      select: { statusSetAt: true, details: true },
      orderBy: { statusSetAt: 'desc' },
    }),
  ]);

  // A request whose settings were all left locked starts the cooldown; lifting any of them ends it.
  const unchanged = recentlyClosed.find(({ details }) => {
    const asked = (details as { lockedProperties?: unknown } | null)?.lockedProperties;
    return Array.isArray(asked) && asked.length > 0 && asked.every((key) => locked.includes(key));
  });
  const reopensAt = unchanged?.statusSetAt
    ? dayjs(unchanged.statusSetAt).add(LOCK_REVIEW_COOLDOWN_DAYS, 'day').toDate()
    : null;

  return { requestable, pending: !!pending, reopensAt };
}

/** Refuses a request the owner may not file now. An open request is left to the report dedupe. */
export async function assertLockReviewAllowed({
  modelId,
  userId,
  isModerator,
  lockedProperties,
}: {
  modelId: number;
  userId: number;
  isModerator?: boolean;
  lockedProperties: unknown;
}) {
  if (isModerator) throw throwBadRequestError('Moderators can change locked settings directly.');
  const state = await getLockReviewState({ modelId, userId });
  if (!state) throw throwBadRequestError("Only the model's owner can request this review.");

  const asked = Array.isArray(lockedProperties) ? lockedProperties : [];
  if (!asked.length || !asked.every((key) => state.requestable.includes(key)))
    throw throwBadRequestError("That setting can't be reviewed this way.");

  if (state.reopensAt && !state.pending)
    throw throwBadRequestError(
      `A moderator reviewed this recently. You can ask again on ${dayjs(state.reopensAt).format(
        'MMMM D, YYYY'
      )}.`
    );
}

const asLocks = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];

/** The details an owner's open request carries after they ask again: one request, every setting named. */
export function mergeOwnLockReview(existing: unknown, incoming: MixedObject): MixedObject {
  const current = (existing ?? {}) as MixedObject;
  const named = new Set([
    ...asLocks(current.lockedProperties),
    ...asLocks(incoming.lockedProperties),
  ]);
  const lockedProperties = REQUESTABLE_LOCKS.filter((key) => named.has(key));
  const comments = [current.comment, incoming.comment].filter(
    (text, index, all): text is string =>
      typeof text === 'string' && !!text.trim() && all.indexOf(text) === index
  );
  return {
    ...current,
    lockedProperties,
    violation: lockReviewQueueLabel(lockedProperties),
    ...(comments.length ? { comment: comments.join('\n\n') } : {}),
  };
}

import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { onTopicCommentsRemoved } from '~/server/events/points/hooks';
import {
  deleteComments,
  prismaRunner,
  setCommentFlags,
} from '~/server/services/commentv3/write.service';
import { logToAxiom } from '~/server/logging/client';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';

/** Moderator actions on comments. */

/**
 * Removes comments as ToS violations: the flag takes them off the page, their ToS reports are
 * actioned and the reporters rewarded, and each author is told. Counts the live comments it was
 * given: one already hidden still has its reports actioned, but its author is not told again.
 */
export async function bulkSetCommentV3TosViolation({
  ids,
  actor,
}: {
  ids: number[];
  actor: { id: number; ip?: string };
}) {
  const { flagged, already } = await dbWrite.$transaction(async (tx) => {
    const flagged = await setCommentFlags(prismaRunner(tx), ids, { tosViolation: true });
    const already = ids.length
      ? await tx.$queryRaw<{ id: number; userId: number }[]>`
          SELECT id, "userId" FROM "CommentV3"
          WHERE id = ANY(${ids}::int[]) AND "tosViolation" AND "deletedAt" IS NULL
            AND id <> ALL(${flagged.map((f) => f.id)}::int[])`
      : [];
    return { flagged, already };
  });
  if (!flagged.length && !already.length) return { count: 0, notified: 0, rewardedReports: 0 };
  // Loaded on use: both modules import back into the comment services.
  const { reportAcceptedReward } = await import('~/server/rewards');
  const { createNotification } = await import('~/server/services/notification.service');
  const newlyFlagged = new Set(flagged.map((f) => f.id));
  let rewardedReports = 0;
  let notified = 0;
  for (const { id, userId } of [...flagged, ...already]) {
    // Through CommentV3Report, which also holds the mirrored links of a comment's older reports.
    const reports = await dbWrite.$queryRaw<{ id: number; userId: number }[]>`
      UPDATE "Report" r SET
        status = ${ReportStatus.Actioned}::"ReportStatus",
        "statusSetAt" = now(),
        "statusSetBy" = ${actor.id}
      FROM "CommentV3Report" c
      WHERE c."reportId" = r.id
        AND c."commentId" = ${id}
        AND r.reason = ${ReportReason.TOSViolation}::"ReportReason"
        AND r.status <> ${ReportStatus.Actioned}::"ReportStatus"
      RETURNING r.id, r."userId"
    `;
    rewardedReports += reports.length;
    await Promise.allSettled(
      reports.map((report) =>
        reportAcceptedReward.apply({ userId: report.userId, reportId: report.id }, { ip: actor.ip })
      )
    );
    if (!newlyFlagged.has(id)) continue;
    await createNotification({
      userId,
      type: 'tos-violation',
      category: NotificationCategory.System,
      key: `tos-violation:commentv3:${randomUUID()}`,
      details: { modelName: '', entity: 'comment' },
    })
      .then(() => (notified += 1))
      .catch(() => undefined);
  }
  return { count: flagged.length + already.length, notified, rewardedReports };
}

/**
 * Restores comments removed as ToS violations and reopens the ToS reports that removal actioned.
 * No reward claw-back and no notification, as for the v2 restore.
 */
export async function bulkClearCommentV3TosViolation({ ids }: { ids: number[] }) {
  const none = { count: 0, reopenedReports: 0, failed: 0 };
  if (!ids.length) return none;
  try {
    const { cleared, reopenedReports } = await dbWrite.$transaction(async (tx) => {
      const candidates = (
        await tx.$queryRaw<{ id: number }[]>`
          SELECT c.id FROM "CommentV3" c
          WHERE c.id = ANY(${ids}::int[]) AND c."tosViolation" AND c."deletedAt" IS NULL
          FOR UPDATE`
      ).map((r) => r.id);
      const cleared = await setCommentFlags(prismaRunner(tx), candidates, { tosViolation: false });
      // In the clear's transaction, so a clear never lands without its reports reopened.
      const reopened = cleared.length
        ? await tx.$queryRaw<{ id: number }[]>`
            UPDATE "Report" r SET status = ${ReportStatus.Pending}::"ReportStatus"
            FROM "CommentV3Report" c
            WHERE c."reportId" = r.id
              AND c."commentId" = ANY(${cleared.map((c) => c.id)}::int[])
              AND r.reason = ${ReportReason.TOSViolation}::"ReportReason"
              AND r.status = ${ReportStatus.Actioned}::"ReportStatus"
            RETURNING r.id`
        : [];
      return { cleared, reopenedReports: reopened.length };
    });
    return { count: cleared.length, reopenedReports, failed: 0 };
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'comment-tos-restore',
      message: 'Clearing a ToS flag failed; the comments stay hidden',
      details: { table: 'CommentV3', ids, error: (e as Error)?.message },
    }).catch(() => undefined);
    return { ...none, failed: ids.length };
  }
}

/** Deletes comments in the caller's transaction; one with replies stays as a placeholder for them. */
export function deleteCommentsV3(tx: Prisma.TransactionClient, ids: number[]) {
  return deleteComments(prismaRunner(tx), ids);
}

/** Run after the delete's transaction commits. */
export function afterCommentsV3Deleted(deleted: Awaited<ReturnType<typeof deleteCommentsV3>>) {
  void onTopicCommentsRemoved(deleted);
}

/** The moderator bulk delete, in one transaction. */
export async function bulkDeleteComments({ ids }: { ids: number[] }) {
  const deleted = await dbWrite.$transaction((tx) => deleteCommentsV3(tx, ids));
  afterCommentsV3Deleted(deleted);
  return { deleted: deleted.length };
}

/** Flags a user's live comments as ToS violations (the ban path). */
export async function setUserCommentsV3Tos(userId: number) {
  const ids = (
    await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT id FROM "CommentV3"
      WHERE "userId" = ${userId} AND "deletedAt" IS NULL AND NOT "tosViolation"`
  ).map((r) => r.id);
  await setFlagsInBatches(ids, { tosViolation: true });
}

const FLAG_BATCH = 1_000;

/**
 * `setCommentFlags` over any number of comments, a batch per transaction: one account can hold
 * hundreds of thousands. Returns the rows it changed.
 */
export async function setFlagsInBatches(
  ids: number[],
  flags: Parameters<typeof setCommentFlags>[2]
) {
  const changed: Awaited<ReturnType<typeof setCommentFlags>> = [];
  for (let i = 0; i < ids.length; i += FLAG_BATCH) {
    const batch = ids.slice(i, i + FLAG_BATCH);
    changed.push(
      ...(await dbWrite.$transaction((tx) => setCommentFlags(prismaRunner(tx), batch, flags)))
    );
  }
  return changed;
}

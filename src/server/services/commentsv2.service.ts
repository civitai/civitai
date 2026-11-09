import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { kyselyRead } from '~/server/db/kyselyDb';
import { onCommentsRemoved } from '~/server/events/points/hooks';
import { logToAxiom } from '~/server/logging/client';
import type { CommentTargetType } from '~/server/schema/commentv3.schema';
import {
  afterCommentsV3Deleted,
  bulkClearCommentV3TosViolation,
  bulkSetCommentV3TosViolation,
  deleteCommentsV3,
  v3WriteCommentIds,
} from '~/server/services/commentv3/moderation.service';
import { getV3WriteComment, prismaRunner } from '~/server/services/commentv3/write.service';

export async function getJudgeCommentForImage({
  imageId,
  judgeUserId,
}: {
  imageId: number;
  judgeUserId: number;
}) {
  const result = await dbRead.$queryRaw<[{ content: string }?]>`
    SELECT c.content
    FROM "CommentV3" c
    WHERE c."entityType" = 'image' AND c."entityId" = ${imageId} AND c."parentId" IS NULL
      AND c."userId" = ${judgeUserId} AND c."deletedAt" IS NULL
    ORDER BY c."createdAt" ASC
    LIMIT 1
  `;
  return result[0]?.content ?? null;
}

/**
 * Resolve the owner (creator) userId of the entity a comment thread hangs off of, so callers
 * can tell whether the current viewer is looking at engagement on their OWN content. Returns
 * null for entity types we can't cheaply resolve — callers treat that as "not the owner",
 * which keeps the anti-harassment `blockedByUsers` exclusion in place (the safe default).
 */
export async function getThreadEntityOwnerId({
  entityType,
  entityId,
}: {
  entityType: CommentTargetType;
  entityId: number;
}): Promise<number | null> {
  const findUserId = async (row: Promise<{ userId: number | null } | null>) =>
    (await row)?.userId ?? null;

  switch (entityType) {
    case 'image':
      return findUserId(
        dbRead.image.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'post':
      return findUserId(
        dbRead.post.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'model':
      return findUserId(
        dbRead.model.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'article':
      return findUserId(
        dbRead.article.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'bounty':
      return findUserId(
        dbRead.bounty.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'bountyEntry':
      return findUserId(
        dbRead.bountyEntry.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'review':
      return findUserId(
        dbRead.resourceReview.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'comment': {
      // CommentV3 holds every comment, including those on surfaces that no longer write CommentV2.
      const row = await kyselyRead
        .selectFrom('CommentV3')
        .select('userId')
        .where('id', '=', entityId)
        .executeTakeFirst();
      return row?.userId ?? null;
    }
    case 'challenge': {
      const row = await dbRead.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true },
      });
      return row?.createdById ?? null;
    }
    case 'crucible':
      return findUserId(
        dbRead.crucible.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'storyline':
      return findUserId(
        dbRead.storyline.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'model3d':
      return findUserId(
        dbRead.model3D.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    // `entityId` is the serialId. Stays user_id: `ownerOfThreadContent` grants hide/pin on it.
    case 'appListing':
      return findUserId(
        dbRead.appListing.findUnique({ where: { serialId: entityId }, select: { userId: true } })
      );
    case 'comicChapter': {
      const row = await dbRead.comicChapter.findUnique({
        where: { id: entityId },
        select: { project: { select: { userId: true } } },
      });
      return row?.project?.userId ?? null;
    }
    default:
      return null;
  }
}

/**
 * Whether `userId` owns the entity this comment thread hangs off of. Skips the lookup unless a
 * viewer is present AND has a non-empty blocked-by list — dropping `blockedByUsers` only
 * matters (and only for the owner) in that case, so the extra query stays off the hot path for
 * everyone else.
 */
export async function isViewerContentOwner({
  entityType,
  entityId,
  userId,
  blockedByUsers,
}: {
  entityType: CommentTargetType;
  entityId: number;
  userId?: number;
  blockedByUsers: number[];
}): Promise<boolean> {
  if (!userId || !blockedByUsers.length) return false;
  const ownerId = await getThreadEntityOwnerId({ entityType, entityId });
  return ownerId === userId;
}

/**
 * Whether a member gets the comment as missing: gone, or hidden for ToS. Read on the primary, so a
 * delete just made counts. A comment on a surface that writes CommentV3 has no
 * CommentV2 row.
 */
export const isCommentGoneForMembers = async (commentId: number) => {
  const row = await dbWrite.commentV2.findUnique({
    where: { id: commentId },
    select: { tosViolation: true },
  });
  if (!row) {
    const v3 = await getV3WriteComment(prismaRunner(dbWrite), commentId);
    return !v3 || v3.tosViolation;
  }
  return row.tosViolation;
};

/**
 * Deletes CommentV2 comments in the caller's transaction. Deleting one sets its reply thread's link
 * null rather than deleting the replies.
 */
export async function deleteCommentsV2(tx: Prisma.TransactionClient, ids: number[]) {
  if (ids.length === 0) return [];
  return tx.$queryRaw<{ userId: number; threadId: number }[]>`
    DELETE FROM "CommentV2" c WHERE c.id = ANY(${ids}::int[]) RETURNING c."userId", c."threadId"
  `;
}

export function afterCommentsV2Deleted(deleted: Awaited<ReturnType<typeof deleteCommentsV2>>) {
  void onCommentsRemoved(deleted);
}

/**
 * The moderator bulk delete, in one transaction. A comment on a surface that writes CommentV3 is
 * deleted there, CommentV3 first as every write on those surfaces locks it.
 */
export async function bulkDeleteCommentsV2({ ids }: { ids: number[] }) {
  const { v2, v3 } = await dbWrite.$transaction(async (tx) => {
    const v3Ids = await v3WriteCommentIds(ids, tx);
    const v3 = await deleteCommentsV3(tx, v3Ids);
    const v2 = await deleteCommentsV2(
      tx,
      ids.filter((id) => !v3Ids.includes(id))
    );
    return { v2, v3 };
  });
  afterCommentsV2Deleted(v2);
  afterCommentsV3Deleted(v3);
  return { deleted: v2.length + v3.length };
}

/**
 * Mirror of the legacy `setTosViolationHandler` flow for CommentV2:
 * 1) Set `tosViolation = true` — the reads here filter it for non-moderators, which is what takes the
 *    comment off the page. `hidden` does not: it only swaps the comment for a placeholder any
 *    viewer can reveal.
 * 2) Mark CommentV2Report rows with reason=TOSViolation as Actioned
 * 3) Reward reporters via reportAcceptedReward
 * 4) Send 'tos-violation' notification to comment owner
 */
export async function bulkSetCommentV2TosViolation({
  ids: requested,
  actor,
}: {
  ids: number[];
  actor: { id: number; ip?: string };
}) {
  if (requested.length === 0) return { count: 0, notified: 0, rewardedReports: 0 };
  // A comment on a surface that writes CommentV3 is flagged there, where its reports are linked too.
  const v3Ids = await v3WriteCommentIds(requested);
  const v3 = await bulkSetCommentV3TosViolation({ ids: v3Ids, actor });
  const ids = requested.filter((id) => !v3Ids.includes(id));
  if (ids.length === 0) return v3;

  const { reportAcceptedReward } = await import('~/server/rewards');
  const { createNotification } = await import('~/server/services/notification.service');
  const { NotificationCategory } = await import('~/server/common/enums');
  const enums = await import('~/shared/utils/prisma/enums');

  let rewardedReports = v3.rewardedReports;
  let notified = v3.notified;
  // Rows written, not ids submitted. A row already hidden counts: its reports are actioned on this
  // pass.
  let count = v3.count;

  for (const id of ids) {
    // An already-hidden comment still has its reports actioned, but its author is not told again.
    const wasHidden = (
      await dbWrite.commentV2.findUnique({ where: { id }, select: { tosViolation: true } })
    )?.tosViolation;
    const updated = await dbWrite.commentV2
      .update({
        where: { id },
        data: { tosViolation: true },
        select: { id: true, userId: true },
      })
      .catch(() => null);
    if (!updated) continue;
    count += 1;

    const reports = await dbWrite.$queryRaw<{ id: number; userId: number }[]>`
      UPDATE "Report" r SET
        status = ${enums.ReportStatus.Actioned}::"ReportStatus",
        "statusSetAt" = now(),
        "statusSetBy" = ${actor.id}
      FROM "CommentV2Report" c
      WHERE c."reportId" = r.id
        AND c."commentV2Id" = ${id}
        AND r.reason = ${enums.ReportReason.TOSViolation}::"ReportReason"
        AND r.status <> ${enums.ReportStatus.Actioned}::"ReportStatus"
      RETURNING id, "userId"
    `;
    rewardedReports += reports.length;

    await Promise.allSettled(
      reports.map((report) =>
        reportAcceptedReward.apply({ userId: report.userId, reportId: report.id }, { ip: actor.ip })
      )
    );

    if (wasHidden) continue;
    await createNotification({
      userId: updated.userId,
      type: 'tos-violation',
      category: NotificationCategory.System,
      key: `tos-violation:commentv2:${crypto.randomUUID()}`,
      details: { modelName: '', entity: 'comment' },
    })
      .then(() => {
        notified += 1;
      })
      .catch(() => undefined);
  }

  return { count, notified, rewardedReports };
}

/**
 * The reverse of `bulkSetCommentV2TosViolation`, and the reason it exists: setting `tosViolation` was a
 * one-way door. Nothing in the main app or the moderator spoke cleared it, there is no comment
 * equivalent of `restoreImages`, and a ban purge can set it across a whole account in one click. So a
 * false positive had no route back at all.
 *
 * Mirrors the forward flow in two of its four steps and deliberately NOT in the other two:
 *
 * 1) `tosViolation = false` — puts the comment back on the page for everyone.
 * 2) Its actioned `TOSViolation` reports go back to `Pending`, which is what the forward action closed.
 *    A report is reopened rather than dismissed: the flag being wrong does not make the report wrong,
 *    and a moderator still has to rule on it.
 *
 * 🔴 3) Rewards are NOT reversed. `reportAcceptedReward` has already paid Buzz to the reporters, and
 *    there is no claw-back — nor should there be, since reporting in good faith is the behaviour being
 *    paid for. Re-actioning later does not double-pay: the reward is keyed on `reportId`.
 * 🔴 4) No notification. The forward action tells the owner their comment broke the rules; there is no
 *    "never mind" equivalent, and inventing one would tell an author their comment was removed at the
 *    moment it is being restored.
 */
export async function bulkClearCommentV2TosViolation({ ids: requested }: { ids: number[] }) {
  if (requested.length === 0) return { count: 0, reopenedReports: 0, failed: 0 };
  const v3Ids = await v3WriteCommentIds(requested);
  const v3 = await bulkClearCommentV3TosViolation({ ids: v3Ids });
  const ids = requested.filter((id) => !v3Ids.includes(id));
  if (ids.length === 0) return v3;

  let reopenedReports = v3.reopenedReports;
  // Rows actually cleared, NOT ids submitted — a comment already unflagged must not be counted, or the
  // caller reports a restore that restored nothing.
  let count = v3.count;
  let failed = v3.failed;

  for (const id of ids) {
    const outcome = await clearTosOrFail(id);
    if (outcome?.failed) failed += 1;
    if (!outcome?.cleared) continue;
    count += 1;
    reopenedReports += outcome.reopened;
  }

  return { count, reopenedReports, failed };
}

/**
 * Clears the ToS flag on the flagged comment `id`, and reopens the reports the flag actioned in the
 * same statement, so a clear never lands without them. Null when there is no such flagged comment.
 */
export async function clearTos(id: number) {
  const { ReportReason, ReportStatus } = await import('~/shared/utils/prisma/enums');
  const [row] = await dbWrite.$queryRaw<{ cleared: boolean; reopened: number }[]>`
    WITH target AS (
      SELECT c.id FROM "CommentV2" c WHERE c.id = ${id} AND c."tosViolation"
    ), cleared AS (
      UPDATE "CommentV2" c SET "tosViolation" = false, "updatedAt" = now()
      FROM target t WHERE c.id = t.id AND c."tosViolation"
      RETURNING c.id
    ), reopened AS (
      -- Only Actioned: a report someone Dismissed was not closed by this flag.
      UPDATE "Report" r SET status = ${ReportStatus.Pending}::"ReportStatus"
      FROM "CommentV2Report" link
      WHERE link."reportId" = r.id
        AND link."commentV2Id" IN (SELECT id FROM cleared)
        AND r.reason = ${ReportReason.TOSViolation}::"ReportReason"
        AND r.status = ${ReportStatus.Actioned}::"ReportStatus"
      RETURNING r.id
    )
    SELECT EXISTS (SELECT 1 FROM cleared) AS cleared,
      (SELECT count(*) FROM reopened)::int AS reopened
    FROM target t
  `;
  return row ?? null;
}

/**
 * `clearTos`, where a statement that fails leaves the comment hidden and is reported as `failed`:
 * the rest of the batch still runs and reports what it did.
 */
export async function clearTosOrFail(id: number) {
  try {
    const row = await clearTos(id);
    return row && { ...row, failed: false };
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'comment-tos-restore',
      message: 'Clearing a ToS flag failed; the comment stays hidden',
      details: { table: 'CommentV2', id, error: (e as Error)?.message },
    }).catch(() => undefined);
    return { cleared: false, reopened: 0, failed: true };
  }
}

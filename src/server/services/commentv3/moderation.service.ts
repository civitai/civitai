import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { onTopicCommentsRemoved } from '~/server/events/points/hooks';
import {
  deleteComments,
  prismaRunner,
  setCommentFlags,
  v3SurfaceCommentIds,
  v3WriteSurfaceSql,
} from '~/server/services/commentv3/write.service';
import { accountHoldSql, logHoldRetained } from '~/server/services/legal-hold.service';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';

/**
 * Moderator actions on comments of the surfaces that write CommentV3 directly (`isV3WriteSurface`).
 * The v2 twins in `commentsv2.service.ts` act on the old tables.
 */

/** Of `ids`, the comments on surfaces that write CommentV3 directly. */
export async function v3WriteCommentIds(ids: number[], db: Prisma.TransactionClient = dbWrite) {
  if (!ids.length) return [];
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT id FROM "CommentV3"
    WHERE id = ANY(${ids}::int[]) AND ${Prisma.raw(v3WriteSurfaceSql('"entityType"'))}
  `;
  return rows.map((r) => r.id);
}

/**
 * Removes comments as ToS violations: the flag takes them off the page, their ToS reports are
 * actioned and the reporters rewarded, and each author is told. Counts rows actually flagged.
 */
export async function bulkSetCommentV3TosViolation({
  ids,
  actor,
}: {
  ids: number[];
  actor: { id: number; ip?: string };
}) {
  const flagged = await dbWrite.$transaction((tx) =>
    setCommentFlags(prismaRunner(tx), ids, { tosViolation: true })
  );
  if (!flagged.length) return { count: 0, notified: 0, rewardedReports: 0 };
  // Loaded on use: both modules import back into the comment services.
  const { reportAcceptedReward } = await import('~/server/rewards');
  const { createNotification } = await import('~/server/services/notification.service');
  let rewardedReports = 0;
  let notified = 0;
  for (const { id, userId } of flagged) {
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
  return { count: flagged.length, notified, rewardedReports };
}

/**
 * Restores comments removed as ToS violations and reopens the ToS reports that removal actioned.
 * No reward claw-back and no notification, as for the v2 restore.
 */
export async function bulkClearCommentV3TosViolation({ ids }: { ids: number[] }) {
  const cleared = await dbWrite.$transaction((tx) =>
    setCommentFlags(prismaRunner(tx), ids, { tosViolation: false })
  );
  let reopenedReports = 0;
  if (cleared.length) {
    const reports = await dbWrite.$queryRaw<{ id: number }[]>`
      UPDATE "Report" r SET status = ${ReportStatus.Pending}::"ReportStatus"
      FROM "CommentV3Report" c
      WHERE c."reportId" = r.id
        AND c."commentId" = ANY(${cleared.map((c) => c.id)}::int[])
        AND r.reason = ${ReportReason.TOSViolation}::"ReportReason"
        AND r.status = ${ReportStatus.Actioned}::"ReportStatus"
      RETURNING r.id
    `;
    reopenedReports = reports.length;
  }
  return { count: cleared.length, reopenedReports };
}

/**
 * The CommentV3 half of the moderator bulk delete, in the caller's transaction. A comment whose
 * author is held, or with a held author anywhere below it, is removed as a ToS violation instead
 * of deleted, as `deleteCommentsV2UnlessHeld` does.
 */
export async function deleteCommentsV3UnlessHeld(
  tx: Prisma.TransactionClient,
  ids: number[],
  markerView: boolean
) {
  if (!ids.length) return { deleted: [], retained: [] };
  // Below a comment means its subtree and, past the depth cap, the replies that answer it through
  // `replyToId` from beside it, with everything below those in turn. The recursion walks only those
  // clamped replies, within the candidates' threads.
  const held = await tx.$queryRaw<{ id: number; userId: number }[]>`
    WITH RECURSIVE clamped AS MATERIALIZED (
      SELECT d.path AS answered, r.path FROM "CommentV3" r
      JOIN "CommentV3" d ON d.id = r."replyToId"
      WHERE r."replyToId" IS NOT NULL
        AND r."rootId" IN (SELECT c."rootId" FROM "CommentV3" c WHERE c.id = ANY(${ids}::int[]))
    ),
    reach (cand, path) AS (
      SELECT c.id, c.path FROM "CommentV3" c
      WHERE c.id = ANY(${ids}::int[]) AND c."deletedAt" IS NULL
      UNION
      SELECT reach.cand, k.path FROM reach
      JOIN clamped k ON k.answered <@ reach.path AND NOT k.path <@ reach.path
    )
    SELECT c.id, c."userId" FROM "CommentV3" c
    WHERE c.id = ANY(${ids}::int[]) AND c."deletedAt" IS NULL
      AND EXISTS (
        -- Aggregated first: as a plain subquery the planner walks the whole user index instead of
        -- the path index.
        SELECT 1 FROM (
          SELECT DISTINCT u AS "userId"
          FROM unnest((
            SELECT array_agg(d."userId") FROM reach JOIN "CommentV3" d ON d.path <@ reach.path
            WHERE reach.cand = c.id
          )) u
        ) a
        WHERE ${accountHoldSql(Prisma.sql`a."userId"`, markerView)}
      )
  `;
  const heldIds = new Set(held.map((h) => h.id));
  const deleted = await deleteComments(
    prismaRunner(tx),
    ids.filter((id) => !heldIds.has(id))
  );
  await setCommentFlags(prismaRunner(tx), [...heldIds], { tosViolation: true });
  // Every held comment is kept, including one already flagged, which the update does not return.
  return { deleted, retained: held };
}

export async function afterCommentsV3Deleted({
  deleted,
  retained,
}: Awaited<ReturnType<typeof deleteCommentsV3UnlessHeld>>) {
  if (retained.length)
    await logHoldRetained(
      'commentV3.bulkDelete',
      retained.map((r) => r.userId)
    );
  void onTopicCommentsRemoved(deleted);
}

/**
 * Flags a user's live comments on CommentV3-write surfaces as ToS violations (the ban path), keeping
 * their CommentV2 rows in step. The ban's own CommentV2 update leaves these out, so each row is
 * locked CommentV3 first, as every write on these surfaces does.
 */
export async function setUserCommentsV3Tos(userId: number) {
  const ids = await v3SurfaceCommentIds(prismaRunner(dbWrite), userId, 'NOT "tosViolation"');
  if (ids.length)
    await dbWrite.$transaction((tx) =>
      setCommentFlags(prismaRunner(tx), ids, { tosViolation: true })
    );
}

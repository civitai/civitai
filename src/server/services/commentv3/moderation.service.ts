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
import { logToAxiom } from '~/server/logging/client';
import {
  accountHoldSql,
  holdMarkerViewExists,
  isLegalHoldAbort,
  logHoldRetained,
} from '~/server/services/legal-hold.service';
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
 * actioned and the reporters rewarded, and each author is told. Counts the live comments it was
 * given: one already hidden still has its reports actioned, but its author is not told again, since
 * it may be one they deleted that a hold kept.
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
 * No reward claw-back and no notification, as for the v2 restore. A comment a moderator's delete
 * would keep (its author, or anyone below it, is held) stays hidden, and so does one its author
 * deleted while a hold kept it: restoring that would republish it.
 */
export async function bulkClearCommentV3TosViolation({ ids }: { ids: number[] }) {
  const none = { count: 0, reopenedReports: 0, retainedHidden: 0, failed: 0 };
  if (!ids.length) return none;
  const markerView = await holdMarkerViewExists();
  try {
    const { cleared, held, reopenedReports } = await dbWrite.$transaction(async (tx) => {
      const candidates = (
        await tx.$queryRaw<{ id: number }[]>`
          SELECT c.id FROM "CommentV3" c
          WHERE c.id = ANY(${ids}::int[]) AND c."tosViolation" AND c."deletedAt" IS NULL
            AND NOT c."removedByAuthor"
            AND NOT EXISTS (
              SELECT 1 FROM "CommentV2" v
              WHERE v.id = c.id AND (v.metadata ->> 'removedByAuthor')::boolean IS TRUE
            )
          FOR UPDATE`
      ).map((r) => r.id);
      const held = await heldCommentsV3(tx, candidates, markerView);
      const heldIds = new Set(held.map((h) => h.id));
      const cleared = await setCommentFlags(
        prismaRunner(tx),
        candidates.filter((id) => !heldIds.has(id)),
        { tosViolation: false }
      );
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
      return { cleared, held, reopenedReports: reopened.length };
    });
    if (held.length)
      await logHoldRetained(
        'commentV3.restoreFromTos',
        held.map((h) => h.userId)
      );
    return { count: cleared.length, reopenedReports, retainedHidden: held.length, failed: 0 };
  } catch (e) {
    // A hold that cannot be read keeps every comment hidden.
    if (isLegalHoldAbort(e)) return { ...none, retainedHidden: ids.length };
    logToAxiom({
      type: 'error',
      name: 'comment-tos-restore',
      message: 'Clearing a ToS flag failed; the comments stay hidden',
      details: { table: 'CommentV3', ids, error: (e as Error)?.message },
    }).catch(() => undefined);
    return { ...none, failed: ids.length };
  }
}

/**
 * Of the live comments `ids`, those a moderator's delete keeps: their author, or anyone below them,
 * is held. Below a comment means its subtree and, past the depth cap, the replies that answer it
 * through `replyToId` from beside it, with everything below those in turn. The recursion walks only
 * those clamped replies, within the candidates' threads.
 */
export async function heldCommentsV3(
  tx: Prisma.TransactionClient,
  ids: number[],
  markerView: boolean
) {
  if (!ids.length) return [];
  return tx.$queryRaw<{ id: number; userId: number }[]>`
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
}

/**
 * Deletes comments in the caller's transaction, keeping each one `heldCommentsV3` names as a ToS
 * violation instead, as `deleteCommentsV2UnlessHeld` does. One its author removed is marked, so a
 * moderator's ToS restore cannot republish it.
 */
export async function deleteCommentsV3UnlessHeld(
  tx: Prisma.TransactionClient,
  ids: number[],
  markerView: boolean,
  { byAuthor = false } = {}
) {
  if (!ids.length) return { deleted: [], retained: [] };
  const held = await heldCommentsV3(tx, ids, markerView);
  const heldIds = [...new Set(held.map((h) => h.id))];
  const deleted = await deleteComments(
    prismaRunner(tx),
    ids.filter((id) => !heldIds.includes(id))
  );
  await setCommentFlags(prismaRunner(tx), heldIds, { tosViolation: true });
  if (byAuthor && heldIds.length) {
    await tx.$executeRaw`
      UPDATE "CommentV3" SET "removedByAuthor" = true WHERE id = ANY(${heldIds}::int[])`;
    // On the CommentV2 twin as well, which outlives a delete of the article and is what a rollback
    // restores from.
    await tx.$executeRaw`
      UPDATE "CommentV2"
      SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"removedByAuthor": true}'::jsonb
      WHERE id = ANY(${heldIds}::int[])`;
  }
  // Every held comment is kept, including one already flagged, which the update does not return.
  return { deleted, retained: held };
}

/**
 * Whether the article `articleId` (an int SQL expression) has a live comment by a held author that
 * exists only in CommentV3. Deleting the article deletes it: a CommentV3 row cannot be detached from
 * its article as a CommentV2 thread is, so the article is kept instead.
 */
export function heldCommentV3OnArticleSql(articleId: Prisma.Sql, markerView: boolean) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "CommentV3" ac
    WHERE ac."entityType" = 'article' AND ac."entityId" = ${articleId} AND ac."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "CommentV2" v WHERE v.id = ac.id)
      AND ${accountHoldSql(Prisma.raw('ac."userId"'), markerView)}
  )`;
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

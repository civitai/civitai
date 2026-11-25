import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { onTopicCommentsRemoved } from '~/server/events/points/hooks';
import {
  type CommentGoneCause,
  deleteComments,
  prismaRunner,
  setCommentFlags,
} from '~/server/services/commentv3/write.service';
import { logToAxiom } from '~/server/logging/client';
import { TRPCError } from '@trpc/server';
import { commentV3CsamHold, hasOpenCommentReport } from '~/server/services/commentv3/review-hold';
import { lockCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { constants } from '~/server/common/constants';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { FP_AUTO_HIDE_REPORT_COMMENT } from '@civitai/db-queries/feature-page-comments';

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
  // Under the rows' lock (setCommentFlags takes it): a clear waits for this commit, so it sees
  // the reports actioned here.
  const { flagged, already, reports } = await dbWrite.$transaction(async (tx) => {
    const flagged = await setCommentFlags(prismaRunner(tx), ids, { tosViolation: true });
    const already = ids.length
      ? await tx.$queryRaw<{ id: number; userId: number }[]>`
          SELECT id, "userId" FROM "CommentV3"
          WHERE id = ANY(${ids}::int[]) AND "tosViolation" AND "deletedAt" IS NULL
            AND id <> ALL(${flagged.map((f) => f.id)}::int[])`
      : [];
    const removed = [...flagged, ...already].map((c) => c.id);
    // Through CommentV3Report, which also holds the mirrored links of a comment's older reports.
    const reports = removed.length
      ? await tx.$queryRaw<{ id: number; userId: number }[]>`
          UPDATE "Report" r SET
            status = ${ReportStatus.Actioned}::"ReportStatus",
            "statusSetAt" = now(),
            "statusSetBy" = ${actor.id}
          FROM "CommentV3Report" c
          WHERE c."reportId" = r.id
            AND c."commentId" = ANY(${removed}::int[])
            AND r.reason = ${ReportReason.TOSViolation}::"ReportReason"
            AND r.status <> ${ReportStatus.Actioned}::"ReportStatus"
          RETURNING r.id, r."userId"`
      : [];
    return { flagged, already, reports };
  });
  if (!flagged.length && !already.length) return { count: 0, notified: 0, rewardedReports: 0 };
  // Loaded on use: both modules import back into the comment services.
  const { reportAcceptedReward } = await import('~/server/rewards');
  const { createNotification } = await import('~/server/services/notification.service');
  await Promise.allSettled(
    reports.map((report) =>
      reportAcceptedReward.apply({ userId: report.userId, reportId: report.id }, { ip: actor.ip })
    )
  );
  let notified = 0;
  for (const { userId } of flagged) {
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
  return { count: flagged.length + already.length, notified, rewardedReports: reports.length };
}

/** The ToS clear's writes in the caller's transaction: rows locked in id order, then cleared. */
export async function clearCommentV3TosViolationIn(tx: Prisma.TransactionClient, ids: number[]) {
  const rows = await tx.$queryRaw<{ id: number; fp: boolean }[]>`
    SELECT c.id, c."entityType"::text = 'featurePage' AS fp FROM "CommentV3" c
    WHERE c.id = ANY(${ids}::int[]) AND c."tosViolation" AND c."deletedAt" IS NULL
    ORDER BY c.id FOR UPDATE`;
  const candidates = rows.map((r) => r.id);
  const cleared = await setCommentFlags(prismaRunner(tx), candidates, {
    tosViolation: false,
  });
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
  // Feature Pages comments stay removed: setCommentFlags clears none of them.
  return { cleared, reopenedReports: reopened.length, held: rows.filter((r) => r.fp).length };
}

/**
 * Restores comments removed as ToS violations and reopens the ToS reports that removal actioned.
 * No reward claw-back and no notification, as for the v2 restore.
 */
export async function bulkClearCommentV3TosViolation({ ids }: { ids: number[] }) {
  const none = { count: 0, reopenedReports: 0, held: 0, failed: 0 };
  if (!ids.length) return none;
  try {
    const { cleared, reopenedReports, held } = await dbWrite.$transaction((tx) =>
      clearCommentV3TosViolationIn(tx, ids)
    );
    return { count: cleared.length, reopenedReports, held, failed: 0 };
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'comment-tos-restore',
      message: 'Clearing a ToS flag failed; the comments stay hidden',
      details: { table: 'CommentV3', ids, error: (e as Error)?.message },
    });
    return { ...none, failed: ids.length };
  }
}

/**
 * Deletes comments in the caller's transaction; one with replies stays as a placeholder for them.
 * The author's own delete is deleteOwnCommentV3.
 */
export function deleteCommentsV3(
  tx: Prisma.TransactionClient,
  ids: number[],
  cause?: Exclude<CommentGoneCause, 'author'>
) {
  return deleteComments(prismaRunner(tx), ids, cause);
}

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

type FileReport = (input: {
  userId: number;
  isModerator: boolean;
  id: number;
  type: ReportEntity;
  reason: ReportReason;
  details: Record<string, unknown>;
  foldIntoPendingOnly: boolean;
}) => Promise<{ id: number } | null | undefined>;

/**
 * A Feature Pages comment is shown at once and hidden if its scan flags it (scam or csam), with a
 * system report in the existing queue, filed or folded on every call, a retry included. Any other
 * comment is left to the site's own rules. A text version a moderator already lifted the scan's hide
 * for is left as it is: a repeated scan of it changes nothing.
 */
export async function hideFlaggedFpComment(
  commentId: number,
  deps: {
    createReport?: FileReport;
    db?: Pick<typeof dbWrite, '$queryRawUnsafe' | '$transaction'>;
    /** The text the scan judged, by `textScanTextHash`. */
    textHash?: string;
    currentTextHash?: typeof currentFpTextHash;
  } = {}
) {
  const client = deps.db ?? dbWrite;
  // Compared as text: this runs for every flagged comment, before the featurePage label exists too.
  const { rows } = await prismaRunner(client as never).query<{
    entityType: string;
    lifted: boolean;
  }>(
    `SELECT c."entityType"::text AS "entityType",
       COALESCE(m."liftGrantedVersion" = m.version, false) AS lifted
     FROM "CommentV3" c LEFT JOIN "FeaturePageCommentMirror" m ON m."commentId" = c.id
     WHERE c.id = $1`,
    [commentId]
  );
  if (rows[0]?.entityType !== 'featurePage' || rows[0].lifted) return false;

  const createReport =
    deps.createReport ??
    ((await import('~/server/services/report.service')).createReport as FileReport);
  // The report commits before the hide, so the author's delete is refused from the moment it is
  // hidden. A failed report never holds the hide back: hidden, then thrown for the retry to file.
  let failure: unknown;
  let reportId: number | null = null;
  try {
    const report = await createReport({
      userId: constants.system.user.id,
      isModerator: true,
      id: commentId,
      type: ReportEntity.CommentV3,
      reason: ReportReason.AdminAttention,
      details: { reason: 'Other', comment: FP_AUTO_HIDE_REPORT_COMMENT },
      foldIntoPendingOnly: true,
    });
    reportId = report?.id ?? null;
  } catch (e) {
    failure = e;
  }
  // Whether the scan judged the comment's current text: only then is the hide bound to its version.
  // Unknown (the read failed) hides it bound to no version, then throws for the retry to bind.
  let judgedCurrent: boolean | undefined;
  if (deps.textHash !== undefined)
    try {
      judgedCurrent =
        (await (deps.currentTextHash ?? currentFpTextHash)(commentId)) === deps.textHash;
    } catch (e) {
      judgedCurrent = false;
      failure ??= e;
    }
  const hid = await client.$transaction((tx) =>
    hideAsScan(prismaRunner(tx), commentId, reportId, judgedCurrent)
  );
  if (failure) throw failure;
  return hid;
}

async function currentFpTextHash(commentId: number) {
  const subject = (await getTextScanProfile('CommentV3')?.load([commentId]))?.get(commentId);
  return subject && textScanTextHash(subject);
}

/**
 * Hides as the scan and records the hide, its report and, when the scan judged the current text, its
 * text version on the mirror row. Any other hide clears that record in setCommentFlags; a retry while
 * the scan's hide still stands records it again. With no report or no version, no dismissal lifts it.
 * Returns false, writing nothing, once a moderator has lifted this version.
 */
async function hideAsScan(
  db: ReturnType<typeof prismaRunner>,
  commentId: number,
  reportId: number | null,
  judgedCurrent: boolean | undefined
) {
  // Locked, then read in a statement of its own, so a lift committed meanwhile is seen.
  await db.query(`SELECT id FROM "CommentV3" WHERE id = $1 FOR UPDATE`, [commentId]);
  const { rows } = await db.query<{ lifted: boolean; scanHiddenAt: string | null }>(
    `SELECT COALESCE(m."liftGrantedVersion" = m.version, false) AS lifted,
       CASE WHEN c.hidden AND c."hiddenAt" = m."scanHiddenAt" THEN m."scanHiddenAt"::text END
         AS "scanHiddenAt"
     FROM "CommentV3" c LEFT JOIN "FeaturePageCommentMirror" m ON m."commentId" = c.id
     WHERE c.id = $1`,
    [commentId]
  );
  if (rows[0]?.lifted) return false;
  const changed = await setCommentFlags(db, [commentId], { hidden: true });
  if (changed.length)
    await db.query(
      `UPDATE "FeaturePageCommentMirror" m SET "scanHiddenAt" = c."hiddenAt",
         "scanHiddenVersion" = CASE WHEN $3::boolean IS FALSE THEN NULL ELSE m.version END,
         "scanHideReportId" = $2
       FROM "CommentV3" c WHERE m."commentId" = $1 AND c.id = m."commentId"`,
      [commentId, reportId, judgedCurrent ?? null]
    );
  else if (rows[0]?.scanHiddenAt)
    await db.query(
      `UPDATE "FeaturePageCommentMirror" SET "scanHiddenAt" = $2::timestamptz,
         "scanHideReportId" = $3,
         "scanHiddenVersion" = CASE WHEN $4::boolean THEN version ELSE "scanHiddenVersion" END
       WHERE "commentId" = $1`,
      [commentId, rows[0].scanHiddenAt, reportId, judgedCurrent === true]
    );
  return true;
}

const fpDeleteRefused = () =>
  new TRPCError({ code: 'FORBIDDEN', message: 'This comment is under review.' });

/**
 * The author's own delete, a moderator's included. A Feature Pages comment that is ToS-removed,
 * reported or held is kept as evidence and the delete refused. Read under the hold decision's lock,
 * then the row's, as a hold, a report and a ToS removal each wait on one of them.
 */
export async function deleteOwnCommentV3(
  tx: Prisma.TransactionClient,
  comment: { id: number; entityType: string }
) {
  const db = prismaRunner(tx);
  if (comment.entityType === 'featurePage') {
    await lockCsamHold(tx, 'CommentV3', comment.id);
    const { rows } = await db.query<{ tosViolation: boolean }>(
      `SELECT "tosViolation" FROM "CommentV3" WHERE id = $1 AND "deletedAt" IS NULL FOR UPDATE`,
      [comment.id]
    );
    if (rows[0]) {
      if (rows[0].tosViolation || (await hasOpenCommentReport(db, comment.id)))
        throw fpDeleteRefused();
      const hold = await commentV3CsamHold(comment.id, tx);
      if (hold === 'unverified')
        throw new TRPCError({ code: 'CONFLICT', message: 'This comment is being checked.' });
      if (hold !== 'clear') throw fpDeleteRefused();
    }
  }
  return deleteComments(db, [comment.id], 'author');
}

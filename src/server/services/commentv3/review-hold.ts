import { csamQueueHeldText } from '@civitai/shared/held-url';
import { dbWrite } from '~/server/db/client';
import type { Prisma } from '@prisma/client';
import { prismaRunner, type SqlRunner } from '~/server/services/commentv3/write.service';
import { type CsamHoldReader, csamHoldState } from '~/server/services/text-scan/csam-hold-state';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';

/**
 * A comment's csam hold: held whenever the csam queue holds it (a Pending or Confirmed hold, or a
 * csam verdict not dismissed, the rule the mirror's SQL reads), otherwise read against the scan of
 * its current text. Pass the caller's transaction to read all of it on that transaction.
 */
export async function commentV3CsamHold(
  commentId: number,
  // primary: decides whether the comment may be shown or edited, right after a verdict may land.
  tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'> & CsamHoldReader = dbWrite
) {
  const { rows } = await prismaRunner(tx).query<{ held: boolean }>(
    `SELECT ${csamQueueHeldText('CommentV3', String(Math.trunc(commentId)))} AS held`
  );
  if (rows[0]?.held) return 'held' as const;
  const profile = getTextScanProfile('CommentV3');
  return csamHoldState(
    'CommentV3',
    commentId,
    async (id) => (profile ? (await profile.load([id])).get(id) : undefined),
    tx
  );
}

/**
 * Whether a report on the comment is still waiting for a moderator. Locks the comment's reports, so
 * call it with the comment row locked: a reopen or a fold waits for the caller, or is read by it.
 */
export async function hasOpenCommentReport(db: SqlRunner, commentId: number) {
  const { rows } = await db.query<{ status: string }>(
    `SELECT r.status::text AS status FROM "CommentV3Report" cr JOIN "Report" r ON r.id = cr."reportId"
     WHERE cr."commentId" = $1 ORDER BY r.id FOR UPDATE OF r`,
    [commentId]
  );
  return rows.some((r) => r.status === 'Pending' || r.status === 'Processing');
}

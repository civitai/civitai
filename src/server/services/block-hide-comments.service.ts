import { seededThreadChainCte } from '~/server/common/thread-chain';
import { dbWrite } from '~/server/db/client';
import { queryWithTimeout } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';

/**
 * The SQL twin of `ownerOfThreadContent` in block-check.service: one row per owner-bearing
 * `Thread` column, in the same precedence. A parity test holds it to `threadContentSelect`.
 */
export const THREAD_CONTENT_OWNERS = [
  { column: 'imageId', table: '"Image"', owner: '"userId"', key: 'id' },
  { column: 'postId', table: '"Post"', owner: '"userId"', key: 'id' },
  { column: 'articleId', table: '"Article"', owner: '"userId"', key: 'id' },
  { column: 'modelId', table: '"Model"', owner: '"userId"', key: 'id' },
  { column: 'reviewId', table: '"ResourceReview"', owner: '"userId"', key: 'id' },
  { column: 'bountyId', table: '"Bounty"', owner: '"userId"', key: 'id' },
  { column: 'bountyEntryId', table: '"BountyEntry"', owner: '"userId"', key: 'id' },
  { column: 'questionId', table: '"Question"', owner: '"userId"', key: 'id' },
  { column: 'answerId', table: '"Answer"', owner: '"userId"', key: 'id' },
  { column: 'model3dId', table: '"Model3D"', owner: '"userId"', key: 'id' },
  { column: 'model3dReviewId', table: '"Model3DReview"', owner: '"userId"', key: 'id' },
  { column: 'comicProjectId', table: '"ComicProject"', owner: '"userId"', key: 'id' },
  { column: 'challengeId', table: '"Challenge"', owner: '"createdById"', key: 'id' },
  { column: 'appListingId', table: 'app_listings', owner: 'user_id', key: 'serial_id' },
] as const;

// Measured on the prod replica 2026-09-23: 2.9s for a 30k-comment author, and p99.9 of authors
// have under 1,700 comments. The ceiling and timeout bound a pathological target, not a real one.
export const BLOCK_HIDE_READ_TIMEOUT_MS = 5_000;
export const BLOCK_HIDE_MAX_COMMENTS = 10_000;
export const BLOCK_HIDE_BATCH_SIZE = 1_000;

const threadOwnerSql = (alias: string) =>
  `CASE ${THREAD_CONTENT_OWNERS.map(
    ({ column, table, owner, key }) =>
      `WHEN ${alias}."${column}" IS NOT NULL THEN (SELECT o.${owner} FROM ${table} o WHERE o.${key} = ${alias}."${column}")`
  ).join(' ')} END`;

export const blockHideCandidatesSql = `${seededThreadChainCte(
  `SELECT c.id "seedId", c."threadId" FROM "CommentV2" c WHERE c."userId" = $1 AND c.hidden IS NOT TRUE`
)},
top AS (
  SELECT DISTINCT ON (sc."seedId") sc."seedId", sc."id" "threadId"
  FROM seeded_chain sc
  ORDER BY sc."seedId", sc."depth" DESC
)
SELECT top."seedId" "id"
FROM top
JOIN "Thread" t ON t.id = top."threadId"
WHERE ${threadOwnerSql('t')} = $2
ORDER BY top."seedId"
LIMIT $3`;

export type BlockHideCommentsResult =
  | { status: 'hidden'; count: number; capped: boolean }
  | { status: 'failed'; count: number };

/**
 * Hides every CommentV2 by `blockedUserId` whose stored thread chain ends on content `ownerId`
 * owns. Never throws: it runs after the block has committed, and the block must stand whatever
 * happens here.
 */
export async function hideBlockedUserCommentsOnOwnContent({
  ownerId,
  blockedUserId,
}: {
  ownerId: number;
  blockedUserId: number;
}): Promise<BlockHideCommentsResult> {
  let count = 0;
  try {
    const { rows } = await queryWithTimeout<{ id: number }>(
      pgDbRead,
      BLOCK_HIDE_READ_TIMEOUT_MS,
      blockHideCandidatesSql,
      [blockedUserId, ownerId, BLOCK_HIDE_MAX_COMMENTS]
    );
    const ids = rows.map((r) => r.id);

    for (let i = 0; i < ids.length; i += BLOCK_HIDE_BATCH_SIZE) {
      const { count: updated } = await dbWrite.commentV2.updateMany({
        where: {
          id: { in: ids.slice(i, i + BLOCK_HIDE_BATCH_SIZE) },
          userId: blockedUserId,
        },
        data: { hidden: true },
      });
      count += updated;
    }

    return { status: 'hidden', count, capped: ids.length >= BLOCK_HIDE_MAX_COMMENTS };
  } catch (error) {
    await logToAxiom({
      name: 'block-hide-comments',
      type: 'error',
      message: 'bulk comment hide after block failed; the block stands',
      ownerId,
      blockedUserId,
      error: (error as Error).message,
    }).catch(() => null);
    return { status: 'failed', count };
  }
}

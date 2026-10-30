import { seededThreadChainCte } from '~/server/common/thread-chain';
import { dbWrite } from '~/server/db/client';
import { queryWithTimeout } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { constants } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import {
  hasV3SurfaceTwinSql,
  prismaRunner,
  setCommentFlags,
} from '~/server/services/commentv3/write.service';

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
  { column: 'crucibleId', table: '"Crucible"', owner: '"userId"', key: 'id' },
  { column: 'storylineId', table: '"Storyline"', owner: '"userId"', key: 'id' },
] as const;

// The read resolves an owner for EVERY visible comment the author has before the LIMIT applies, so
// the timeout is what bounds it; the ceiling bounds only the writes. Measured on the prod replica
// 2026-09-23: 3.6s cold for a 21k-comment author, 0.3s cold at p99.9 (about 1,700 comments).
export const BLOCK_HIDE_READ_TIMEOUT_MS = 5_000;
export const BLOCK_HIDE_MAX_COMMENTS = 10_000;
export const BLOCK_HIDE_BATCH_SIZE = 1_000;

const threadOwnerSql = (alias: string) =>
  `CASE ${THREAD_CONTENT_OWNERS.map(
    ({ column, table, owner, key }) =>
      `WHEN ${alias}."${column}" IS NOT NULL THEN (SELECT o.${owner} FROM ${table} o WHERE o.${key} = ${alias}."${column}")`
  ).join(' ')} END`;

export const blockHideCandidatesSql = `${seededThreadChainCte(
  `SELECT c.id "seedId", c."threadId" FROM "CommentV2" c
   WHERE c."userId" = $1 AND c.hidden IS NOT TRUE AND NOT ${hasV3SurfaceTwinSql('c')}`
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

/**
 * The CommentV3 twin, for the surfaces that write there directly: a comment there names its section,
 * so its owner is one lookup by entity type. A surface with no `THREAD_CONTENT_OWNERS` row under
 * `<entityType>Id` resolves no owner and hides nothing, which a test guards against.
 */
export const v3SectionOwnerSql = (alias: string) =>
  `CASE ${constants.comments.v3WriteSurfaces
    .flatMap((type) => {
      const o = THREAD_CONTENT_OWNERS.find((x) => x.column === `${type}Id`);
      return o
        ? [
            `WHEN ${alias}."entityType" = '${type}' THEN (SELECT o.${o.owner} FROM ${o.table} o WHERE o.${o.key} = ${alias}."entityId")`,
          ]
        : [];
    })
    .join(' ')} END`;

export const blockHideV3CandidatesSql = `SELECT c.id FROM "CommentV3" c
WHERE c."userId" = $1 AND NOT c.hidden AND c."deletedAt" IS NULL AND ${v3SectionOwnerSql('c')} = $2
ORDER BY c.id
LIMIT $3`;

export type BlockHideCommentsResult =
  | { status: 'hidden'; count: number; capped: boolean }
  | { status: 'failed'; count: number }
  | { status: 'skipped' };

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
    // Comments on a CommentV3-write surface, including those written before it flipped, which the
    // CommentV2 read leaves out; within what is left of the one ceiling.
    const v3Limit = BLOCK_HIDE_MAX_COMMENTS - ids.length;
    const v3Ids =
      v3Limit > 0
        ? (
            await queryWithTimeout<{ id: number }>(
              pgDbRead,
              BLOCK_HIDE_READ_TIMEOUT_MS,
              blockHideV3CandidatesSql,
              [blockedUserId, ownerId, v3Limit]
            )
          ).rows.map((r) => r.id)
        : [];

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

    // CommentV3 first, with the CommentV2 row in step: the lock order of every write there.
    for (let i = 0; i < v3Ids.length; i += BLOCK_HIDE_BATCH_SIZE) {
      const batch = v3Ids.slice(i, i + BLOCK_HIDE_BATCH_SIZE);
      const updated = await dbWrite.$transaction((tx) =>
        setCommentFlags(prismaRunner(tx), batch, { hidden: true })
      );
      count += updated.length;
    }

    return {
      status: 'hidden',
      count,
      capped: ids.length + v3Ids.length >= BLOCK_HIDE_MAX_COMMENTS,
    };
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

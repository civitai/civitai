import { dbWrite } from '~/server/db/client';
import { queryWithTimeout } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';
import type { CommentEntityType } from '~/shared/utils/prisma/enums';
import { prismaRunner, setCommentFlags } from '~/server/services/commentv3/write.service';

/** The ids of the sections of each type that `owner` owns. */
export const SECTION_OWNERS: Record<CommentEntityType, (owner: string) => string> = {
  image: (o) => `SELECT id FROM "Image" WHERE "userId" = ${o}`,
  post: (o) => `SELECT id FROM "Post" WHERE "userId" = ${o}`,
  article: (o) => `SELECT id FROM "Article" WHERE "userId" = ${o}`,
  model: (o) => `SELECT id FROM "Model" WHERE "userId" = ${o}`,
  review: (o) => `SELECT id FROM "ResourceReview" WHERE "userId" = ${o}`,
  bounty: (o) => `SELECT id FROM "Bounty" WHERE "userId" = ${o}`,
  bountyEntry: (o) => `SELECT id FROM "BountyEntry" WHERE "userId" = ${o}`,
  model3d: (o) => `SELECT id FROM "Model3D" WHERE "userId" = ${o}`,
  model3dReview: (o) => `SELECT id FROM "Model3DReview" WHERE "userId" = ${o}`,
  challenge: (o) => `SELECT id FROM "Challenge" WHERE "createdById" = ${o}`,
  // A listing's comments are keyed by its serial id.
  appListing: (o) => `SELECT serial_id FROM app_listings WHERE user_id = ${o}`,
  crucible: (o) => `SELECT id FROM "Crucible" WHERE "userId" = ${o}`,
  storyline: (o) => `SELECT id FROM "Storyline" WHERE "userId" = ${o}`,
  postText: (o) =>
    `SELECT t.id FROM "PostText" t JOIN "Post" p ON p.id = t."postId" WHERE p."userId" = ${o}`,
  comicChapter: (o) =>
    `SELECT ch.id FROM "ComicChapter" ch JOIN "ComicProject" p ON p.id = ch."projectId" WHERE p."userId" = ${o}`,
};

// A join from both ends: the planner can walk the blocked user's comments (`commentv3_user`) or the
// owner's sections (`commentv3_entity`), whichever is smaller. The timeout bounds the read, the
// ceiling the writes.
export const BLOCK_HIDE_READ_TIMEOUT_MS = 5_000;
export const BLOCK_HIDE_MAX_COMMENTS = 10_000;
export const BLOCK_HIDE_BATCH_SIZE = 1_000;

/**
 * Types whose enum value a later hand-applied migration adds: casting them before it lands would
 * fail every block. No comment can exist on them until then.
 */
export const SECTION_TYPES_AWAITING_ENUM: readonly CommentEntityType[] = ['postText'];

export const blockHideCandidatesSql = `WITH owned (t, id) AS (
${Object.entries(SECTION_OWNERS)
  .filter(([type]) => !SECTION_TYPES_AWAITING_ENUM.includes(type as CommentEntityType))
  .map(
    ([type, owned]) => `  SELECT '${type}'::"CommentEntityType", x.id FROM (${owned('$2')}) x (id)`
  )
  .join('\n  UNION ALL\n')}
)
SELECT c.id FROM owned o
JOIN "CommentV3" c ON c."entityType" = o.t AND c."entityId" = o.id
WHERE c."userId" = $1 AND NOT c.hidden AND c."deletedAt" IS NULL
ORDER BY c.id
LIMIT $3`;

export type BlockHideCommentsResult =
  | { status: 'hidden'; count: number; capped: boolean }
  | { status: 'failed'; count: number }
  | { status: 'skipped' };

/**
 * Hides every comment by `blockedUserId` on a section `ownerId` owns. Never throws: it runs after
 * the block has committed, and the block must stand whatever happens here.
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
      const batch = ids.slice(i, i + BLOCK_HIDE_BATCH_SIZE);
      const updated = await dbWrite.$transaction((tx) =>
        setCommentFlags(prismaRunner(tx), batch, { hidden: true })
      );
      count += updated.length;
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

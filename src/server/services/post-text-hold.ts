import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

// A leaf: post, user and job deletes import it, so it imports nothing of theirs.

/**
 * Whether the post `postId` holds held text: `post_text_held` (20270108093000_post_text), which
 * the delete trigger on "PostText" also asks. Held text, and its post, can't be deleted until the
 * hold is released.
 */
export const postHoldsHeldTextSql = (postId: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "PostText" ht
  WHERE ht."postId" = ${postId} AND post_text_held(ht."csamHeld", ht."postId", ht."userId")
)`;

/** The posts among these holding held text, or holding these texts when they are held. */
export async function heldPostTextPostIds({
  postIds,
  textIds,
}: {
  postIds?: number[];
  textIds?: number[];
}) {
  const where = postIds?.length
    ? Prisma.sql`t."postId" IN (${Prisma.join(postIds)})`
    : textIds?.length
    ? Prisma.sql`t.id IN (${Prisma.join(textIds)})`
    : null;
  if (!where) return [];
  const rows = await dbWrite.$queryRaw<{ postId: number }[]>`
    SELECT DISTINCT t."postId" FROM "PostText" t
    WHERE ${where} AND post_text_held(t."csamHeld", t."postId", t."userId")
  `;
  return rows.map((row) => row.postId);
}

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { OWNER_CONTENT_KEPT } from '~/server/services/legal-hold.service';

// A leaf: post, user and job deletes import it, so it imports nothing of theirs.

/**
 * Whether the post `postId` holds held text: `post_text_held` (20270108093000_post_text), which
 * the delete trigger on "PostText" also asks. Held text, and its post, can't be deleted until the
 * hold is released.
 */
export const postHoldsHeldTextSql = (postId: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "PostText" ht
  WHERE ht."postId" = ${postId} AND post_text_held(ht.id, ht."csamHeld", ht."postId", ht."userId")
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
    WHERE ${where} AND post_text_held(t.id, t."csamHeld", t."postId", t."userId")
  `;
  return rows.map((row) => row.postId);
}

/**
 * Writes a text item's content unless it is held at the moment of the write, so a hold landing
 * after the caller's check still refuses the edit. Reset `nsfwLevel` to 0 with a change of words.
 */
export const unheldPostTextUpdateSql = (id: number, content: string, resetLevel: boolean) =>
  Prisma.sql`UPDATE "PostText" t
    SET content = ${content}, ${Prisma.raw(
    resetLevel ? '"nsfwLevel" = 0, ' : ''
  )}"updatedAt" = now()
    WHERE t.id = ${id} AND NOT post_text_held(t.id, t."csamHeld", t."postId", t."userId")`;

/** The refusal of a change to held text: an owner is never told why (`OWNER_CONTENT_KEPT`). */
export const heldTextError = (isModerator: boolean | undefined, what: string) =>
  new TRPCError({
    code: 'FORBIDDEN',
    message: isModerator
      ? `${what} is held for review and can't change until the hold is released`
      : OWNER_CONTENT_KEPT,
  });

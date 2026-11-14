import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { getPostDetail } from '~/server/services/post.service';
import { isPostTextShownToViewer } from '~/server/services/post-text.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { storylineReaderLevel } from '~/server/utils/storyline-reader-level';
import type { SessionUser } from '~/types/session';

/**
 * The post as `post.get` serves it, or NOT_FOUND unless the viewer may see it: `getPostDetail`'s
 * visibility plus the owner's block of a non-moderator viewer.
 */
export async function assertPostVisibleToViewer({
  id,
  user,
}: GetByIdInput & { user?: SessionUser }) {
  const post = await getPostDetail({ id, user });
  if (!post) throw throwNotFoundError();
  if (user && !user.isModerator) {
    const blocked = await amIBlockedByUser({ userId: user.id, targetUserId: post.user.id });
    if (blocked) throw throwNotFoundError();
  }
  return post;
}

/**
 * NOT_FOUND unless `post.get` would serve this text to the viewer: the flag, the post's gate, then
 * the row rule `getPostTextsForViewer` applies. A text's comment thread is readable exactly there.
 */
export async function assertPostTextVisible(
  textId: number,
  ctx: Pick<Context, 'user' | 'features' | 'req'>
) {
  if (!ctx.features?.storylineText) throw throwNotFoundError('Text not found');
  const text = await dbRead.postText.findUnique({
    where: { id: textId },
    select: { postId: true, refused: true, csamHeld: true, nsfwLevel: true },
  });
  if (!text) throw throwNotFoundError('Text not found');
  const post = await assertPostVisibleToViewer({ id: text.postId, user: ctx.user });
  const seesAll = !!ctx.user && (ctx.user.id === post.user.id || !!ctx.user.isModerator);
  if (
    !isPostTextShownToViewer(text, {
      browsingLevel: storylineReaderLevel(ctx, undefined),
      seesAll,
    })
  )
    throw throwNotFoundError('Text not found');
  return { postId: text.postId };
}

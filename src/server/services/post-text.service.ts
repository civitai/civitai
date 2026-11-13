import { dbRead, dbWrite } from '~/server/db/client';
import { heldPostTextPostIds, heldTextError } from '~/server/services/post-text-hold';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { updatePostNsfwLevels } from '~/server/services/nsfwLevels.service';
import {
  assertChapterPostAuthor,
  isImageCaptionShown,
} from '~/server/services/storyline-caption.service';
import { scanEntityInBackground } from '~/server/services/text-scan/submit';
import {
  throwBadRequestError,
  throwAuthorizationError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { STORYLINE_TEXT_MAX_LENGTH, STORYLINE_TEXT_MAX_PER_POST } from '~/shared/utils/storyline';
import { getHighestBrowsingLevelBit } from '~/shared/constants/browsingLevel.constants';
import { removeTags } from '~/utils/string-helpers';

/**
 * Adds an empty text item to a chapter post at `index`, in `Image.index`'s number space: the index
 * of the item it follows, so no image row is rewritten (ties sort images first, then texts by id).
 */
export async function addPostText({
  postId,
  index,
  userId,
}: {
  postId: number;
  index: number;
  userId: number;
}) {
  const post = await dbWrite.post.findUnique({ where: { id: postId }, select: { userId: true } });
  if (!post) throw throwNotFoundError('Post not found');
  await assertChapterPostAuthor({
    postId,
    postUserId: post.userId,
    userId,
    what: 'add text to it',
  });
  const count = await dbWrite.postText.count({ where: { postId } });
  if (count >= STORYLINE_TEXT_MAX_PER_POST)
    throw throwBadRequestError(`A post holds at most ${STORYLINE_TEXT_MAX_PER_POST} text items`);
  return dbWrite.postText.create({
    data: { postId, userId, index, content: '' },
    select: { id: true, postId: true, index: true, content: true },
  });
}

async function getOwnText(id: number, userId: number, isModerator?: boolean) {
  const text = await dbWrite.postText.findUnique({
    where: { id },
    select: {
      id: true,
      postId: true,
      content: true,
      post: { select: { userId: true } },
    },
  });
  if (!text) throw throwNotFoundError('Text not found');
  if (text.post.userId !== userId && !isModerator)
    throw throwAuthorizationError('Only the post author can change its text');
  return text;
}

/**
 * Saves a text item's content. A change to its words resets its rating to 0 in the same write, so
 * readers see none of it until its own scan lands (unlike a caption, which keeps its old rating
 * meanwhile); a markup-only change keeps the rating.
 */
export async function setPostText({
  id,
  content,
  userId,
  isModerator,
}: {
  id: number;
  content: string;
  userId: number;
  isModerator?: boolean;
}) {
  const text = await getOwnText(id, userId);
  if ((await heldPostTextPostIds({ textIds: [id] })).length)
    throw heldTextError(isModerator, 'This text');
  await assertChapterPostAuthor({
    postId: text.postId,
    postUserId: text.post.userId,
    userId,
    what: 'change its text',
  });
  const html = content.trim();
  const plain = removeTags(html).trim();
  if (plain.length > STORYLINE_TEXT_MAX_LENGTH)
    throw throwBadRequestError(`Text is limited to ${STORYLINE_TEXT_MAX_LENGTH} characters`);
  if (text.content === html) return { id, content: html };
  // Before the markup-only path: links live in the markup, and only the blocklist checks them.
  if (html) await throwOnBlockedUserContent(html, { isModerator, surface: 'storyline-text' });
  // The scan reads the plain text, so a markup-only edit keeps its rating: a rescan would be
  // skipped as unchanged and the reset level would never be lifted.
  if (removeTags(text.content).trim() === plain) {
    await dbWrite.postText.update({ where: { id }, data: { content: html } });
    return { id, content: html };
  }

  await dbWrite.postText.update({ where: { id }, data: { content: html, nsfwLevel: 0 } });
  if (plain) scanEntityInBackground({ entityType: 'PostText', entityId: id });
  // The cleared level no longer rates the post.
  await updatePostNsfwLevels([text.postId]);
  return { id, content: html };
}

/** Deletes a text item and its thread (by cascade), and recomputes the post's level without it. */
export async function deletePostText({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId: number;
  isModerator?: boolean;
}) {
  const text = await getOwnText(id, userId, isModerator);
  if ((await heldPostTextPostIds({ textIds: [id] })).length)
    throw heldTextError(isModerator, 'This text');
  await dbWrite.postText.delete({ where: { id } });
  await updatePostNsfwLevels([text.postId]);
  return { id };
}

const readableTextWhere = { refused: false, csamHeld: false, nsfwLevel: { not: 0 } } as const;

/**
 * The text items a reader is shown on these chapter posts, without content: which slides exist.
 * The caller has already applied the chapter gates; a chapter whose images are all hidden from the
 * reader still shows its texts.
 */
export async function getStorylineTextStubs({
  postIds,
  browsingLevel,
  maxNsfwLevel,
}: {
  postIds: number[];
  browsingLevel: number;
  maxNsfwLevel: number;
}) {
  if (!postIds.length) return [];
  const rows = await dbRead.postText.findMany({
    where: { postId: { in: postIds }, ...readableTextWhere },
    select: { id: true, postId: true, index: true, nsfwLevel: true, refused: true },
  });
  return rows
    .filter((row) => isImageCaptionShown(row, { browsingLevel, maxNsfwLevel, failClosed: true }))
    .map(({ id, postId, index, nsfwLevel }) => ({ id, postId, index, nsfwLevel }));
}

/**
 * A post's text items as `post.get` serves them, for a viewer the caller has already let see the
 * post. Its author and moderators get every row; anyone else only scanned, unrefused, unheld text
 * within `browsingLevel` (no storyline ceiling: `post.get` is not storyline-scoped).
 */
export async function getPostTextsForViewer({
  postId,
  browsingLevel,
  seesAll,
}: {
  postId: number;
  browsingLevel: number;
  seesAll: boolean;
}) {
  const rows = await dbRead.postText.findMany({
    where: { postId, ...(seesAll ? {} : readableTextWhere) },
    select: { id: true, index: true, content: true, nsfwLevel: true, refused: true },
  });
  return rows
    .filter(
      (row) =>
        seesAll ||
        isImageCaptionShown(row, {
          browsingLevel,
          maxNsfwLevel: getHighestBrowsingLevelBit(browsingLevel),
          failClosed: true,
        })
    )
    .map(({ id, index, content, nsfwLevel }) => ({ id, index, content, nsfwLevel }));
}

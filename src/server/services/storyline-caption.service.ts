import { dbRead, dbWrite } from '~/server/db/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { scanEntityInBackground } from '~/server/services/text-scan/submit';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import { getHighestBrowsingLevelBit } from '~/shared/constants/browsingLevel.constants';

/**
 * Sets the caption the post's author wrote on one image of a storyline chapter. Empty text
 * deletes it. An edit keeps the old text's refusal and rating until its own scan settles them.
 */
export async function setStorylineImageCaption({
  imageId,
  content,
  userId,
  isModerator,
}: {
  imageId: number;
  content: string;
  userId: number;
  isModerator?: boolean;
}) {
  const image = await dbWrite.image.findUnique({
    where: { id: imageId },
    select: { postId: true, post: { select: { userId: true } } },
  });
  if (!image?.postId || !image.post) throw throwNotFoundError('Image not found');
  if (image.post.userId !== userId)
    throw throwAuthorizationError('Only the post author can caption its images');
  const chapter = await dbWrite.storylineChapter.findFirst({
    where: { postId: image.postId, removedAt: null },
    select: { id: true },
  });
  if (!chapter) throw throwNotFoundError('Captions are only for storyline chapters');

  const text = content.trim();
  if (!text) {
    await dbWrite.imageCaption.deleteMany({ where: { imageId } });
    return null;
  }

  const current = await dbWrite.imageCaption.findUnique({
    where: { imageId },
    select: { content: true },
  });
  if (current?.content === text) return { imageId, content: text };

  await throwOnBlockedUserContent(text, { isModerator, surface: 'storyline-caption' });
  await dbWrite.imageCaption.upsert({
    where: { imageId },
    create: { imageId, userId, content: text },
    update: { content: text },
  });
  scanEntityInBackground({ entityType: 'ImageCaption', entityId: imageId });
  return { imageId, content: text };
}

/** An unscanned caption (nsfwLevel 0) is shown to every reader. */
export function isImageCaptionShown(
  caption: { refused: boolean; nsfwLevel: number },
  { browsingLevel, maxNsfwLevel }: { browsingLevel: number; maxNsfwLevel: number }
) {
  if (caption.refused) return false;
  if (!caption.nsfwLevel) return true;
  return (
    (caption.nsfwLevel & browsingLevel) !== 0 &&
    getHighestBrowsingLevelBit(caption.nsfwLevel) <= maxNsfwLevel
  );
}

/**
 * The captions a reader is shown on the images of these chapter posts, by image id. An image
 * filter here must match `storylineImageVisible` (storyline.service.ts): a caption of an image the
 * reader is not shown must not reach them either.
 */
export async function getStorylineImageCaptions({
  postIds,
  browsingLevel,
  maxNsfwLevel,
  viewerId,
  hiddenImageIds,
  hiddenTagIds,
}: {
  postIds: number[];
  browsingLevel: number;
  maxNsfwLevel: number;
  viewerId: number | undefined;
  hiddenImageIds: number[];
  hiddenTagIds: number[];
}) {
  const captions = new Map<number, string>();
  if (!postIds.length) return captions;
  const rows = await dbRead.imageCaption.findMany({
    where: {
      refused: false,
      image: {
        postId: { in: postIds },
        id: { notIn: hiddenImageIds },
        ingestion: 'Scanned',
        tosViolation: false,
        needsReview: null,
        acceptableMinor: false,
        minor: false,
        poi: false,
        nsfwLevel: { not: 0 },
        OR: [
          { tags: { none: { tagId: { in: hiddenTagIds }, disabled: false } } },
          ...(viewerId != null ? [{ userId: viewerId }] : []),
        ],
      },
    },
    select: {
      imageId: true,
      content: true,
      refused: true,
      nsfwLevel: true,
      image: { select: { nsfwLevel: true } },
    },
  });
  for (const row of rows)
    if (
      (row.image.nsfwLevel & browsingLevel) !== 0 &&
      getHighestBrowsingLevelBit(row.image.nsfwLevel) <= maxNsfwLevel &&
      isImageCaptionShown(row, { browsingLevel, maxNsfwLevel })
    )
      captions.set(row.imageId, row.content);
  return captions;
}

import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

export type MovePostRow = {
  id: number;
  userId: number;
  publishedAt: Date | null;
  tosViolation: boolean;
  isContest: boolean;
};

export type MoveImageRow = {
  id: number;
  userId: number;
  postId: number | null;
  tosViolation: boolean;
  ingestion: ImageIngestionStatus;
};

export type ImageMoveRefusal =
  | { kind: 'not-found'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'bad-request'; message: string };

function isLive(post: MovePostRow, now: Date): post is MovePostRow & { publishedAt: Date } {
  return !!post.publishedAt && post.publishedAt <= now;
}

/**
 * Why a move must be refused, or null when it is allowed. `target` is null for "move to a new
 * post", which is created with the source's `publishedAt`.
 *
 * `Image.sortAt` is `GREATEST(post.publishedAt, scannedAt, createdAt)` (`set_image_sort_at`), so
 * requiring the target to be live and published no later than the source is what stops a move
 * from lifting an image back to the top of the Newest feeds.
 */
export function getImageMoveRefusal({
  userId,
  imageIds,
  source,
  target,
  images,
  targetImageCount,
  now = new Date(),
}: {
  userId: number;
  imageIds: number[];
  source: MovePostRow | undefined;
  target: MovePostRow | null | undefined;
  images: MoveImageRow[];
  targetImageCount: number;
  now?: Date;
}): ImageMoveRefusal | null {
  if (!source) return { kind: 'not-found', message: 'Source post not found' };
  if (target === undefined) return { kind: 'not-found', message: 'Target post not found' };
  if (target && target.id === source.id)
    return { kind: 'bad-request', message: 'Images are already in this post' };

  if (source.userId !== userId || (target && target.userId !== userId))
    return { kind: 'unauthorized', message: 'You can only move images between your own posts' };
  if (images.length !== imageIds.length || images.some((i) => i.userId !== userId))
    return { kind: 'unauthorized', message: 'You can only move your own images' };
  if (images.some((i) => i.postId !== source.id))
    return { kind: 'bad-request', message: 'Every image must belong to the source post' };

  if (source.isContest || target?.isContest)
    return { kind: 'bad-request', message: 'Images in contest posts cannot be moved' };
  if (source.tosViolation || target?.tosViolation)
    return { kind: 'bad-request', message: 'This post cannot be changed' };
  if (images.some((i) => i.tosViolation || i.ingestion === ImageIngestionStatus.Blocked))
    return { kind: 'bad-request', message: 'Blocked images cannot be moved' };

  if (!isLive(source, now))
    return { kind: 'bad-request', message: 'Images can only be moved out of a published post' };
  if (target) {
    if (!isLive(target, now))
      return {
        kind: 'bad-request',
        message: 'Images can only be moved into a published post',
      };
    if (target.publishedAt > source.publishedAt)
      return {
        kind: 'bad-request',
        message: 'Images can only be moved into a post published at the same time or earlier',
      };
  }

  if (targetImageCount + images.length > POST_IMAGE_LIMIT)
    return {
      kind: 'bad-request',
      message: `A post can hold at most ${POST_IMAGE_LIMIT} images`,
    };

  return null;
}

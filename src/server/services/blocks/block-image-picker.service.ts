import { dbRead } from '~/server/db/client';
import type { GetBlockPickablePostedImagesInput } from '~/server/schema/blocks/block-image-picker.schema';
import {
  postedPickableSelect,
  postedPickableWhere,
  projectPostedPickableImage,
  type PostedPickableImage,
} from '~/server/services/blocks/block-image-picker.logic';
import { isDefined } from '~/utils/type-guards';

/** One page of the caller's own posted images an app may be handed, newest first. */
export async function getBlockPickablePostedImages({
  userId,
  limit,
  cursor,
}: GetBlockPickablePostedImagesInput & { userId: number }): Promise<{
  items: PostedPickableImage[];
  nextCursor?: number;
}> {
  const rows = await dbRead.image.findMany({
    select: postedPickableSelect,
    where: postedPickableWhere(userId),
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: { id: 'desc' },
  });

  const nextCursor = rows.length > limit ? rows.pop()?.id : undefined;
  return { items: rows.map(projectPostedPickableImage).filter(isDefined), nextCursor };
}

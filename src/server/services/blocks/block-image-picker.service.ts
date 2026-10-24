import { dbRead } from '~/server/db/client';
import type { GetBlockPickablePostedImagesInput } from '~/server/schema/blocks/block-image-picker.schema';
import {
  postedPickableSelect,
  postedPickableWhere,
  projectPostedPickableImage,
  type PostedPickableImage,
} from '~/server/services/blocks/block-image-picker.logic';
import { isDefined } from '~/utils/type-guards';

/**
 * The newest image id created at or before `date`, across all images, or `null` when none was.
 * Ordered by `createdAt` so the `createdAt` index answers it without touching the table.
 */
async function newestImageIdAtOrBefore(date: Date): Promise<number | null> {
  const row = await dbRead.image.findFirst({
    where: { createdAt: { lte: date } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * One page of the caller's own posted images an app may be handed, newest first. A page can come
 * back short: a row with no usable rendition is dropped after the query.
 *
 * `toDate` ("jump to date") starts the list at an older point by bounding the id, not the date:
 * the date is resolved to the newest id created by then, and the page is the usual id-ordered
 * scan below that id. A `createdAt` filter on the page query instead makes the planner walk the
 * viewer's newer rows one by one and discard them. The jump is approximate: ids follow creation
 * order closely but not exactly, so an image near the boundary can land on either side of it.
 */
export async function getBlockPickablePostedImages({
  userId,
  browsingLevel,
  limit,
  cursor,
  toDate,
  publicOnly,
}: GetBlockPickablePostedImagesInput & { userId: number; browsingLevel: number }): Promise<{
  items: PostedPickableImage[];
  nextCursor?: number;
}> {
  let maxId: number | undefined;
  if (toDate) {
    const bound = await newestImageIdAtOrBefore(toDate);
    // No image existed yet at that date, so none of the viewer's can be listed.
    if (bound === null) return { items: [] };
    maxId = bound;
  }

  const rows = await dbRead.image.findMany({
    select: postedPickableSelect,
    where: {
      ...postedPickableWhere(userId, browsingLevel, { publicOnly }),
      ...(maxId !== undefined ? { id: { lte: maxId } } : {}),
    },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: { id: 'desc' },
  });

  const nextCursor = rows.length > limit ? rows.pop()?.id : undefined;
  return { items: rows.map(projectPostedPickableImage).filter(isDefined), nextCursor };
}

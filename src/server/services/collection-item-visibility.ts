import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  publishedArticleSql,
  publishedModel3dSql,
  publishedModelSql,
  publishedPostSql,
} from '~/server/services/collection-cover-visibility';
import { assertImagesVisibleToViewer } from '~/server/services/image-visibility.service';
import { getHiddenModelIds } from '~/server/services/model-visibility.service';
import { BlockedByUsers } from '~/server/services/user-preferences.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';

export type CollectionItemKey = 'imageId' | 'postId' | 'articleId' | 'modelId' | 'model3dId';

/**
 * Per item type, the table and what someone who doesn't own the item needs: the states a
 * collection's item covers require (collectionItemCoversSql), so what can be added can be shown.
 */
const itemTables: Record<
  Exclude<CollectionItemKey, 'imageId'>,
  { from: Prisma.Sql; alias: Prisma.Sql; visible: Prisma.Sql }
> = {
  postId: { from: Prisma.sql`"Post" p`, alias: Prisma.sql`p`, visible: publishedPostSql },
  articleId: { from: Prisma.sql`"Article" a`, alias: Prisma.sql`a`, visible: publishedArticleSql },
  modelId: { from: Prisma.sql`"Model" m`, alias: Prisma.sql`m`, visible: publishedModelSql },
  model3dId: {
    from: Prisma.sql`"Model3D" m3`,
    alias: Prisma.sql`m3`,
    visible: publishedModel3dSql,
  },
};

/**
 * NOT_FOUND unless every item in `ids` exists and the viewer may see it: its owner, staff, or
 * anyone when it is in a state others can see and its owner hasn't blocked the viewer. Images use
 * the image rule (assertImagesVisibleToViewer). Any id the replica doesn't return is read again
 * from the primary, so something created or published moments ago still counts.
 */
export async function assertCollectionItemsVisibleToViewer({
  itemKey,
  ids,
  userId,
  isModerator,
}: {
  itemKey: CollectionItemKey;
  ids: number[];
  userId?: number;
  isModerator?: boolean;
}) {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return;
  if (itemKey === 'imageId')
    return assertImagesVisibleToViewer({ ids: wanted, userId, isModerator });

  const { from, alias, visible } = itemTables[itemKey];
  const viewable = isModerator
    ? Prisma.sql`TRUE`
    : userId
    ? Prisma.sql`(${alias}."userId" = ${userId} OR ${visible})`
    : visible;
  const read = (db: typeof dbRead, idList: number[]) =>
    db.$queryRaw<{ id: number; userId: number }[]>`
      SELECT ${alias}.id, ${alias}."userId" FROM ${from}
      WHERE ${alias}.id IN (${Prisma.join(idList)}) AND ${viewable}
    `;

  const rows = await read(dbRead, wanted);
  const found = new Set(rows.map((r) => r.id));
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) rows.push(...(await read(dbWrite, missing)));

  let shown = rows;
  if (!isModerator && userId) {
    const optedOut = new Set((await BlockedByUsers.getCached({ userId })).map((u) => u.id));
    shown = shown.filter((r) => r.userId === userId || !optedOut.has(r.userId));
  }
  if (!isModerator && itemKey === 'modelId') {
    const hidden = await getHiddenModelIds(
      shown.map((r) => r.id),
      { id: userId }
    );
    shown = shown.filter((r) => !hidden.has(r.id));
  }

  const shownIds = new Set(shown.map((r) => r.id));
  if (wanted.some((id) => !shownIds.has(id))) throw throwNotFoundError('Item not found');
}

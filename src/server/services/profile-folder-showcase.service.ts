import { sql } from 'kysely';
import { kyselyWrite } from '~/server/db/kyselyDb';
import type { SetItemShowcaseInput } from '~/server/schema/profile-folders.schema';
import { profileFolderLimits } from '~/server/schema/profile-folders.schema';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { CollectionMode } from '~/shared/utils/prisma/enums';

/**
 * Showcase or un-showcase one item of the caller's own folder. The folder row is locked first, so
 * two writes cannot both take the last of its showcase slots.
 */
export async function setItemShowcase({
  userId,
  collectionItemId,
  showcased,
}: SetItemShowcaseInput & { userId: number }) {
  return kyselyWrite.transaction().execute(async (tx) => {
    const item = await tx
      .selectFrom('CollectionItem as ci')
      .innerJoin('Collection as c', 'c.id', 'ci.collectionId')
      .select(['ci.id', 'ci.collectionId', 'ci.showcasedAt', 'c.userId', 'c.mode'])
      .where('ci.id', '=', collectionItemId)
      .executeTakeFirst();
    if (!item || item.mode !== CollectionMode.Folder || item.userId !== userId)
      throw throwNotFoundError('Item not found in your folders');

    if (!showcased) {
      await tx
        .updateTable('CollectionItem')
        .set({ showcasedAt: null })
        .where('id', '=', item.id)
        .execute();
      return { showcased: false };
    }
    if (item.showcasedAt) return { showcased: true };

    await sql`SELECT 1 FROM "Collection" WHERE id = ${item.collectionId} FOR UPDATE`.execute(tx);
    const { count } = await tx
      .selectFrom('CollectionItem')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('collectionId', '=', item.collectionId)
      .where('showcasedAt', 'is not', null)
      .executeTakeFirstOrThrow();
    if (Number(count) >= profileFolderLimits.showcase)
      throw throwBadRequestError(
        `A folder can showcase up to ${profileFolderLimits.showcase} items`
      );

    await tx
      .updateTable('CollectionItem')
      .set({ showcasedAt: new Date() })
      .where('id', '=', item.id)
      .execute();
    return { showcased: true };
  });
}

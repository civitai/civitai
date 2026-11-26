import type { Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';

/**
 * Records a player's "Not sure" on a queue yes/no question, once per player and question, so confusing questions can be
 * counted per question. Best effort like the skip it rides on: false when nothing was stored, never a throw.
 */
export async function recordUnsure(
  db: Kysely<DB>,
  { playerId, itemId, now }: { playerId: number; itemId: number; now: Date }
): Promise<boolean> {
  try {
    const result = await db
      .insertInto('KnightsUnsure')
      .columns(['playerId', 'itemId', 'questionKey', 'imageId', 'createdAt'])
      .expression((eb) =>
        eb
          .selectFrom('KnightsQueueItem as i')
          .select([
            eb.val(playerId).as('playerId'),
            'i.id',
            'i.questionKey',
            'i.imageId',
            eb.val(utc(now)).as('createdAt'),
          ])
          .where('i.id', '=', itemId)
          .where('i.status', '=', 'Open')
      )
      .onConflict((oc) => oc.columns(['playerId', 'itemId']).doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  } catch (error) {
    console.error('knights: could not record a Not sure', { playerId, itemId, error });
    return false;
  }
}

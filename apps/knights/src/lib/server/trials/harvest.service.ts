import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { HARVEST } from './config';
import { poolFor } from './plan';
import { utc } from './utc';

const NSFW_LEVEL_QUESTION = 'knights.image.nsfwLevel';
const RATING_LEVELS = [1, 2, 4, 8, 16];
const RULING_ACTIVITIES = ['setNsfwLevel', 'setNsfwLevelKono'];
const DAY_MS = 86_400_000;

export type HarvestResult = { scanned: number; added: number; retired: number };

/**
 * Takes new moderator rating rulings into the Trials and hidden-check pools. Reads `ModActivity`
 * past a cursor and keeps an image only while that ruling is still what holds it.
 */
export async function harvestRulings(
  db: Kysely<DB>,
  { now }: { now: Date }
): Promise<HarvestResult> {
  const cutoff = new Date(now.getTime() - HARVEST.maxRulingAgeDays * DAY_MS);
  const cursor = await db
    .selectFrom('KnightsHarvestCursor')
    .select('lastActivityId')
    .where('name', '=', HARVEST.cursorName)
    .executeTakeFirst();
  let lastActivityId = cursor?.lastActivityId ?? 0;
  let scanned = 0;
  let added = 0;

  for (let batch = 0; batch < HARVEST.maxBatches; batch++) {
    const activities = await db
      .selectFrom('ModActivity')
      .select('id')
      .where('id', '>', lastActivityId)
      .where('activity', '=', 'setNsfwLevel')
      .where('entityType', '=', 'image')
      .where('entityId', 'is not', null)
      .where('userId', 'is not', null)
      .where('createdAt', '>=', utc(cutoff))
      .orderBy('id', 'asc')
      .limit(HARVEST.batchSize)
      .execute();
    if (activities.length === 0) break;

    scanned += activities.length;
    const ids = activities.map((a) => a.id);
    const holding = await db
      .selectFrom('ModActivity as a')
      .innerJoin('Image as img', 'img.id', 'a.entityId')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .select(['a.id as activityId', 'img.id as imageId', 'img.nsfwLevel as level'])
      .where('a.id', 'in', ids)
      .where('img.type', '=', 'image')
      .where('img.nsfwLevel', 'in', RATING_LEVELS)
      .where('img.nsfwLevelLocked', '=', true)
      .where(
        sql<boolean>`"img"."metadata"->>'nsfwLevelReason' IS DISTINCT FROM ${KNIGHTS_VOTE_NSFW_LEVEL_REASON}`
      )
      .where('img.ingestion', '!=', 'Blocked')
      .where('img.blockedFor', 'is', null)
      .where('p.publishedAt', 'is not', null)
      .where('p.publishedAt', '<', utc(now))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('ModActivity as later')
              .select(sql<number>`1`.as('one'))
              .whereRef('later.entityId', '=', 'a.entityId')
              .whereRef('later.id', '>', 'a.id')
              .where('later.entityType', '=', 'image')
              .where('later.activity', 'in', RULING_ACTIVITIES)
          )
        )
      )
      .execute();

    if (holding.length > 0) {
      const inserted = await db
        .insertInto('KnightsReferenceImage')
        .values(
          holding.map((row) => ({
            imageId: row.imageId,
            questionKey: NSFW_LEVEL_QUESTION,
            pool: poolFor(row.imageId, HARVEST.hiddenCheckShare),
            answer: String(row.level),
            source: 'harvested',
            modActivityId: row.activityId,
            harvestedAt: utc(now),
            updatedAt: utc(now),
          }))
        )
        .onConflict((oc) => oc.column('imageId').doNothing())
        .returning('id')
        .execute();
      added += inserted.length;
    }

    lastActivityId = ids[ids.length - 1];
    if (activities.length < HARVEST.batchSize) break;
  }

  if (scanned > 0) {
    await db
      .insertInto('KnightsHarvestCursor')
      .values({ name: HARVEST.cursorName, lastActivityId, updatedAt: utc(now) })
      .onConflict((oc) => oc.column('name').doUpdateSet({ lastActivityId, updatedAt: utc(now) }))
      .execute();
  }

  const retired = await retireStale(db, now);
  return { scanned, added, retired };
}

async function retireStale(db: Kysely<DB>, now: Date): Promise<number> {
  const agedOut = new Date(now.getTime() - HARVEST.freshMaxAgeDays * DAY_MS);
  const result = await db
    .updateTable('KnightsReferenceImage as r')
    .set({ status: 'retired', updatedAt: utc(now) })
    .where('r.status', '=', 'active')
    .where('r.source', '!=', 'core')
    .where((eb) =>
      eb.or([
        eb('r.harvestedAt', '<', utc(agedOut)),
        eb.not(
          eb.exists(
            eb
              .selectFrom('Image as img')
              .select(sql<number>`1`.as('one'))
              .whereRef('img.id', '=', 'r.imageId')
              .whereRef(sql`"img"."nsfwLevel"::text`, '=', 'r.answer')
              .where('img.nsfwLevelLocked', '=', true)
              .where('img.ingestion', '!=', 'Blocked')
              .where('img.blockedFor', 'is', null)
          )
        ),
      ])
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

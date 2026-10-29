import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { validNsfwLevels } from '@civitai/shared';
import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  KNIGHTS_VOTE_NSFW_LEVEL_REASON,
} from '@civitai/shared/new-order';
import { servableImage } from '../servable-image';
import { HARVEST, type HarvestConfig } from './config';
import { poolFor } from './plan';

const MODERATOR_RULING_ACTIVITY = 'setNsfwLevel';
/** Any of these after a ruling means the image was rated again, so the ruling no longer stands. */
const RERATING_ACTIVITIES = [MODERATOR_RULING_ACTIVITY, 'setNsfwLevelKono'];
const DAY_MS = 86_400_000;

export type HarvestResult = { scanned: number; added: number; retired: number };

/** Idempotent; safe to re-run. */
export async function harvestRulings(
  db: Kysely<DB>,
  { now, config = HARVEST }: { now: Date; config?: HarvestConfig }
): Promise<HarvestResult> {
  const cutoff = new Date(now.getTime() - config.maxRulingAgeDays * DAY_MS);
  const cursor = await db
    .selectFrom('KnightsHarvestCursor')
    .select('lastActivityId')
    .where('name', '=', config.cursorName)
    .executeTakeFirst();
  let lastActivityId = cursor?.lastActivityId ?? 0;
  let scanned = 0;
  let added = 0;

  for (let batch = 0; batch < config.maxBatches; batch++) {
    const activities = await db
      .selectFrom('ModActivity')
      .select('id')
      .where('id', '>', lastActivityId)
      .where('activity', '=', MODERATOR_RULING_ACTIVITY)
      .where('entityType', '=', 'image')
      .where('entityId', 'is not', null)
      .where('userId', 'is not', null)
      .where('createdAt', '>=', utc(cutoff))
      .orderBy('id', 'asc')
      .limit(config.batchSize)
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
      .where(servableImage)
      .where('img.nsfwLevel', 'in', [...validNsfwLevels])
      .where('img.nsfwLevelLocked', '=', true)
      .where(
        sql<boolean>`"img"."metadata"->>'nsfwLevelReason' IS DISTINCT FROM ${KNIGHTS_VOTE_NSFW_LEVEL_REASON}`
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('ModActivity as later')
              .select(sql<number>`1`.as('one'))
              .whereRef('later.entityId', '=', 'a.entityId')
              .whereRef('later.id', '>', 'a.id')
              .where('later.entityType', '=', 'image')
              .where('later.activity', 'in', RERATING_ACTIVITIES)
          )
        )
      )
      .execute();

    if (holding.length > 0) {
      const inserted = await db
        .insertInto('KnightsReferenceImage')
        .values(
          holding.map((row) => {
            const pool = poolFor(row.imageId, config.hiddenCheckShare);
            return {
              imageId: row.imageId,
              questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
              pool,
              status: config.spotCheck && pool === 'trials' ? 'pending' : 'active',
              answer: String(row.level),
              source: 'harvested',
              modActivityId: row.activityId,
              harvestedAt: utc(now),
              updatedAt: utc(now),
            };
          })
        )
        .onConflict((oc) => oc.column('imageId').doNothing())
        .returning('id')
        .execute();
      added += inserted.length;
    }

    lastActivityId = ids[ids.length - 1];
    if (activities.length < config.batchSize) break;
  }

  if (scanned > 0) {
    await db
      .insertInto('KnightsHarvestCursor')
      .values({ name: config.cursorName, lastActivityId, updatedAt: utc(now) })
      .onConflict((oc) => oc.column('name').doUpdateSet({ lastActivityId, updatedAt: utc(now) }))
      .execute();
  }

  const retired = await retireStale(db, now, config);
  return { scanned, added, retired };
}

async function retireStale(db: Kysely<DB>, now: Date, config: HarvestConfig): Promise<number> {
  const agedOut = new Date(now.getTime() - config.freshMaxAgeDays * DAY_MS);
  const result = await db
    .updateTable('KnightsReferenceImage as r')
    .set({ status: 'retired', updatedAt: utc(now) })
    .where('r.status', 'in', ['active', 'pending'])
    .where('r.source', '!=', 'core')
    .where((eb) =>
      eb.or([
        eb('r.harvestedAt', '<', utc(agedOut)),
        eb.not(
          eb.exists(
            eb
              .selectFrom('Image as img')
              .innerJoin('Post as p', 'p.id', 'img.postId')
              .select(sql<number>`1`.as('one'))
              .whereRef('img.id', '=', 'r.imageId')
              .whereRef(sql`"img"."nsfwLevel"::text`, '=', 'r.answer')
              .where('img.nsfwLevelLocked', '=', true)
              .where(servableImage)
          )
        ),
      ])
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

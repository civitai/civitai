import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { validNsfwLevels } from '@civitai/shared';
import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  KNIGHTS_VOTE_NSFW_LEVEL_REASON,
} from '@civitai/shared/new-order';
import {
  readWithoutJit,
  REFERENCE_POOL,
  REFERENCE_SOURCE,
  REFERENCE_STATUS,
} from '@civitai/db/knights';
import { servableImage, servableImageForSweeps } from '../image-gate';
import { HARVEST, type HarvestConfig, type HarvestSettings } from './config';
import { takeAgreementIntake } from './agreement-intake.service';
import { poolFor } from './pool';
import { reviewProbation, type ProbationReview } from './probation.service';

export const MODERATOR_RULING_ACTIVITY = 'setNsfwLevel';
/** Any of these after a ruling means the image was rated again, so the ruling no longer stands. */
const RERATING_ACTIVITIES = [MODERATOR_RULING_ACTIVITY, 'setNsfwLevelKono'];
const DAY_MS = 86_400_000;
/** The lock reason the moderator image queue records (apps/moderator image-queue.ts); not used as a grading reference. */
export const MODERATOR_QUEUE_RATING_REASON = 'Moderator queue rating';

export type HarvestResult = {
  scanned: number;
  added: number;
  retired: number;
  /** Rulings past the cursor that were already older than the window, e.g. after a long pause; never harvested. */
  skippedStale: number;
};

/**
 * The harvest job. While paused it takes in no rulings or agreement verdicts and the cursor holds where it was, but
 * references whose ruling no longer stands are still retired and probation is still reviewed. Agreement verdicts are
 * taken in only while probation checks are served (`probationShare` above 0): each one claims its image for good.
 */
export async function runHarvestJob(
  db: Kysely<DB>,
  {
    now,
    settings,
    probationShare = 0,
  }: { now: Date; settings: HarvestSettings; probationShare?: number }
): Promise<
  | (HarvestResult & { probation: ProbationReview; agreementAdded: number })
  | { paused: true; retired: number; probation: ProbationReview }
> {
  if (settings.paused) {
    const retired = await retireStale(db, now, HARVEST);
    return { paused: true, retired, probation: await reviewProbation(db, { now }) };
  }
  const harvest = await harvestRulings(db, {
    now,
    config: { ...HARVEST, hiddenCheckShare: settings.hiddenCheckShare },
  });
  // Reviewed before the intake, so a level whose references were just retired refills in the same run.
  const probation = await reviewProbation(db, { now });
  const { added } = probationShare > 0 ? await takeAgreementIntake(db, { now }) : { added: 0 };
  return { ...harvest, probation, agreementAdded: added };
}

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
  // Rulings past the cursor that aged out (e.g. during a pause) can never be harvested: count them once and move past.
  const stale = cursor
    ? await staleSinceCursor(db, lastActivityId, cutoff)
    : { n: 0, lastId: null };
  const skippedStale = stale.n;
  if (stale.lastId !== null) lastActivityId = stale.lastId;

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
    const holding = await readWithoutJit(db, (trx) =>
      trx
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
        .where(
          sql<boolean>`"img"."metadata"->>'nsfwLevelReason' IS DISTINCT FROM ${MODERATOR_QUEUE_RATING_REASON}`
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
        .execute()
    );

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
              status:
                config.spotCheck && pool === REFERENCE_POOL.trials
                  ? REFERENCE_STATUS.pending
                  : REFERENCE_STATUS.active,
              answer: String(row.level),
              source: REFERENCE_SOURCE.harvested,
              modActivityId: row.activityId,
              harvestedAt: utc(now),
              updatedAt: utc(now),
            };
          })
        )
        // A ruling replaces an agreement reference that has graded no answer: the id is reused, so graded votes would
        // read the ruling as their answer. A grade still in flight can slip past the counter check.
        .onConflict((oc) =>
          oc
            .column('imageId')
            .doUpdateSet((eb) => ({
              pool: eb.ref('excluded.pool'),
              status: eb.ref('excluded.status'),
              answer: eb.ref('excluded.answer'),
              source: eb.ref('excluded.source'),
              modActivityId: eb.ref('excluded.modActivityId'),
              harvestedAt: eb.ref('excluded.harvestedAt'),
              updatedAt: eb.ref('excluded.updatedAt'),
            }))
            .where('KnightsReferenceImage.source', '=', REFERENCE_SOURCE.agreement)
            .where('KnightsReferenceImage.answers', '=', 0)
        )
        .returning('id')
        .execute();
      added += inserted.length;
    }

    lastActivityId = ids[ids.length - 1];
    if (activities.length < config.batchSize) break;
  }

  if (scanned > 0 || skippedStale > 0) {
    await db
      .insertInto('KnightsHarvestCursor')
      .values({ name: config.cursorName, lastActivityId, updatedAt: utc(now) })
      .onConflict((oc) => oc.column('name').doUpdateSet({ lastActivityId, updatedAt: utc(now) }))
      .execute();
  }

  const retired = await retireStale(db, now, config);
  return { scanned, added, retired, skippedStale };
}

async function staleSinceCursor(db: Kysely<DB>, lastActivityId: number, cutoff: Date) {
  const row = await db
    .selectFrom('ModActivity')
    .select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max<number | null>('id').as('lastId')])
    .where('id', '>', lastActivityId)
    .where('activity', '=', MODERATOR_RULING_ACTIVITY)
    .where('entityType', '=', 'image')
    .where('entityId', 'is not', null)
    .where('userId', 'is not', null)
    .where('createdAt', '<', utc(cutoff))
    .executeTakeFirstOrThrow();
  return { n: Number(row.n), lastId: row.lastId };
}

const LIVE_STATUSES = [
  REFERENCE_STATUS.active,
  REFERENCE_STATUS.pending,
  REFERENCE_STATUS.probation,
];

/**
 * Retires the fresh items past their age, then every live non-core item whose image no longer stands at its answer.
 * The image check runs on `retireGateChunk` reference ids at a time: under an OR with the age test, the planner hashed
 * every Image and Post through the gate instead of probing each reference's image.
 */
async function retireStale(db: Kysely<DB>, now: Date, config: HarvestConfig): Promise<number> {
  const agedOut = new Date(now.getTime() - config.freshMaxAgeDays * DAY_MS);
  const retire = (trx: Kysely<DB>) =>
    trx
      .updateTable('KnightsReferenceImage')
      .set({ status: REFERENCE_STATUS.retired, updatedAt: utc(now) })
      .where('status', 'in', LIVE_STATUSES);
  // A mod-confirmed check has no TTL: it leaves by the pool cap, Knights' failures, or its image moving off its level.
  const aged = await retire(db)
    .where('source', 'not in', [REFERENCE_SOURCE.core, REFERENCE_SOURCE.inquisitor])
    .where('harvestedAt', '<', utc(agedOut))
    .executeTakeFirst();
  let retired = Number(aged.numUpdatedRows);

  const live = await db
    .selectFrom('KnightsReferenceImage')
    .select('id')
    .where('status', 'in', LIVE_STATUSES)
    .where('source', '!=', REFERENCE_SOURCE.core)
    .orderBy('id')
    .execute();
  for (let at = 0; at < live.length; at += config.retireGateChunk) {
    const chunk = live.slice(at, at + config.retireGateChunk).map((r) => r.id);
    const standing = await readWithoutJit(db, (trx) =>
      trx
        .selectFrom('KnightsReferenceImage as r')
        .innerJoin('Image as img', 'img.id', 'r.imageId')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select('r.id')
        .where('r.id', '=', sql<number>`any(${chunk}::int[])`)
        .whereRef(sql`"img"."nsfwLevel"::text`, '=', 'r.answer')
        .where('img.nsfwLevelLocked', '=', true)
        .where(servableImageForSweeps)
        .execute()
    );
    const stands = new Set(standing.map((r) => r.id));
    const gone = chunk.filter((id) => !stands.has(id));
    if (gone.length === 0) continue;
    const result = await retire(db)
      .where('id', '=', sql<number>`any(${gone}::int[])`)
      .executeTakeFirst();
    retired += Number(result.numUpdatedRows);
  }
  return retired;
}

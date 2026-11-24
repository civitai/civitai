import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import {
  readWithoutJit,
  REFERENCE_POOL,
  REFERENCE_SOURCE,
  REFERENCE_STATUS,
  servableImage,
} from '@civitai/db/knights';
import { BUCKET_LEVELS } from '../queue/feed';
import { MODERATOR_RULING_ACTIVITY } from './harvest.service';

const DAY_MS = 86_400_000;

export const AGREEMENT_INTAKE = {
  /** Distinct players who must all have given the settled answer at the Knight stage. */
  minPlayers: 3,
  /** Live (probation or active) agreement references kept per level bucket. */
  probationPerLevel: 40,
  /** Only items settled this recently are read. */
  maxAgeDays: 14,
};

const LIVE = [REFERENCE_STATUS.probation, REFERENCE_STATUS.active];
/** PG, PG-13 and R: verdicts at X or XXX wait for a moderator-ruled anchor. An image under-rated to R still arrives as R. */
const INTAKE_LEVELS = BUCKET_LEVELS.slice(0, 3);

/**
 * Takes unanimous Knight-stage verdicts in as probation hidden checks, newest first, filling each level bucket up to
 * `probationPerLevel` live agreement references; a level with too few verdicts stays short. A verdict qualifies while
 * it was written back, no moderator re-rated the image after it, and the image is still servable and locked at that
 * level. Images that already have a reference are skipped. Idempotent.
 */
export async function takeAgreementIntake(
  db: Kysely<DB>,
  { now, config = AGREEMENT_INTAKE }: { now: Date; config?: typeof AGREEMENT_INTAKE }
): Promise<{ added: number }> {
  const live = new Map(
    (
      await db
        .selectFrom('KnightsReferenceImage')
        .select(['answer', (eb) => eb.fn.countAll<string>().as('n')])
        .where('pool', '=', REFERENCE_POOL.hiddenCheck)
        .where('source', '=', REFERENCE_SOURCE.agreement)
        .where('status', 'in', LIVE)
        .groupBy('answer')
        .execute()
    ).map((row) => [row.answer, Number(row.n)])
  );
  const since = new Date(now.getTime() - config.maxAgeDays * DAY_MS);

  let added = 0;
  for (const level of INTAKE_LEVELS) {
    const need = config.probationPerLevel - (live.get(String(level)) ?? 0);
    if (need <= 0) continue;

    const candidates = await readWithoutJit(db, (trx) =>
      trx
        .selectFrom('KnightsQueueItem as i')
        .innerJoin('Image as img', 'img.id', 'i.imageId')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select(['i.imageId'])
        .where('i.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
        .where('i.minRank', '=', 'Knight')
        // Written back to the image: a resolved item still awaiting its write-back may yet be rerouted.
        .where('i.status', '=', 'Resolved')
        .where('i.appliedAt', 'is not', null)
        .where('i.resolvedValue', '=', String(level))
        .where('i.resolvedAt', '>=', utc(since))
        .where(servableImage)
        .where('img.nsfwLevel', '=', level)
        .where('img.nsfwLevelLocked', '=', true)
        .where((eb) =>
          eb.and([
            eb.not(
              eb.exists(
                eb
                  .selectFrom('ModActivity as m')
                  .select(sql<number>`1`.as('one'))
                  .whereRef('m.entityId', '=', 'i.imageId')
                  .where('m.entityType', '=', 'image')
                  // Not `setNsfwLevelKono`: that is Knights' own write-back of this verdict, always after resolvedAt.
                  .where('m.activity', '=', MODERATOR_RULING_ACTIVITY)
                  .whereRef('m.createdAt', '>', 'i.resolvedAt')
              )
            ),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('KnightsReferenceImage as r')
                  .select(sql<number>`1`.as('one'))
                  .whereRef('r.imageId', '=', 'i.imageId')
              )
            ),
            // Unanimous: no vote at the stage, held or not, gave another answer ...
            eb.not(
              eb.exists(
                eb
                  .selectFrom('KnightsVote as v')
                  .select(sql<number>`1`.as('one'))
                  .whereRef('v.itemId', '=', 'i.id')
                  .where('v.stage', '=', 'Knight')
                  .whereRef('v.answer', '!=', 'i.resolvedValue')
              )
            ),
            // ... and enough distinct players carried weight.
            eb(
              eb
                .selectFrom('KnightsVote as v')
                .select(sql<number>`count(DISTINCT "v"."playerId")`.as('n'))
                .whereRef('v.itemId', '=', 'i.id')
                .where('v.stage', '=', 'Knight')
                .where('v.weight', '>', 0),
              '>=',
              config.minPlayers
            ),
          ])
        )
        .orderBy('i.resolvedAt', 'desc')
        .limit(need)
        .execute()
    );

    const imageIds = [...new Set(candidates.map((c) => c.imageId))];
    if (imageIds.length === 0) continue;
    const inserted = await db
      .insertInto('KnightsReferenceImage')
      .values(
        imageIds.map((imageId) => ({
          imageId,
          questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
          pool: REFERENCE_POOL.hiddenCheck,
          status: REFERENCE_STATUS.probation,
          answer: String(level),
          source: REFERENCE_SOURCE.agreement,
          harvestedAt: utc(now),
          updatedAt: utc(now),
        }))
      )
      .onConflict((oc) => oc.column('imageId').doNothing())
      .returning('id')
      .execute();
    added += inserted.length;
  }
  return { added };
}

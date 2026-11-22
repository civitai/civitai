import type { Kysely, Transaction } from 'kysely';
import { servableImage, servableImageForSweeps } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import { YESNO_AUDIENCE, YESNO_CONSENSUS_VOTES, YESNO_KEY_PREFIX } from './keys';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Open yes/no questions for players whose image the public feeds would show. Both the feed and the vote start from here, so
 * they cannot disagree. `forSweeps` uses `servableImageForSweeps`, for the sweep, which must not close over a rule that only hides.
 */
export function playableItems(db: Executor, { forSweeps = false } = {}) {
  return db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('i.status', '=', 'Open')
    .where('i.audience', '=', YESNO_AUDIENCE.players)
    .where('q.active', '=', true)
    .where(forSweeps ? servableImageForSweeps : servableImage);
}

/** How many answers a yes/no question waits for, as the axis questions say now (the fewest, when they differ). */
export async function judgesNeeded(db: Executor): Promise<number> {
  const row = await db
    .selectFrom('KnightsQuestion')
    .select((eb) => eb.fn.min('votesToResolve').as('needed'))
    .where('kind', '=', 'bool')
    .where('active', '=', true)
    .where('key', 'like', `${YESNO_KEY_PREFIX}%`)
    .executeTakeFirst();
  return row?.needed ?? YESNO_CONSENSUS_VOTES;
}

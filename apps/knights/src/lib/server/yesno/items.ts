import type { Kysely, Transaction } from 'kysely';
import { MOD_TAG_REVIEW_SOURCE } from '@civitai/db/knights';
import { modReviewEligibleImage, servableImageForSweeps, yesNoServableImage } from '../image-gate';
import type { DB } from '@civitai/db-schema/kysely';
import { YESNO_AUDIENCE, YESNO_CONSENSUS_VOTES, YESNO_KEY_PREFIX } from './keys';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Open yes/no questions for players whose image the public feeds would show and players have not pulled (`yesNoServableImage`).
 * Both the feed and the vote start from here, so they cannot disagree. `forSweeps` uses `servableImageForSweeps`, for the sweep,
 * which must not close over a rule that only hides: a pull only hides, until a moderator keeps or removes the question.
 * Tag review items (`tagReview`) are a set of their own: their image must also be eligible for a moderator review queue
 * (`modReviewEligibleImage`), so the reads behind that check run only where those items are asked for.
 */
export function playableItems(
  db: Executor,
  { forSweeps = false, tagReview = false }: { forSweeps?: boolean; tagReview?: boolean } = {}
) {
  const base = db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('i.status', '=', 'Open')
    .where('i.audience', '=', YESNO_AUDIENCE.players)
    .where('q.active', '=', true)
    .where(forSweeps ? servableImageForSweeps : yesNoServableImage);
  return tagReview
    ? base.where('i.source', '=', MOD_TAG_REVIEW_SOURCE).where(modReviewEligibleImage)
    : base.where('i.source', '<>', MOD_TAG_REVIEW_SOURCE);
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

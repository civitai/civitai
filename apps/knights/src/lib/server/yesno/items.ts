import type { Kysely, Transaction } from 'kysely';
import { servableImage } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import { YESNO_AUDIENCE } from './keys';

type Executor = Kysely<DB> | Transaction<DB>;

/** Open yes/no questions for players whose image the public feeds would show. Both the feed and the vote start from here, so they cannot disagree. */
export function playableItems(db: Executor) {
  return db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('i.status', '=', 'Open')
    .where('i.audience', '=', YESNO_AUDIENCE.players)
    .where('q.active', '=', true)
    .where(servableImage);
}

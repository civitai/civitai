import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { slotOf, unit } from '../hidden/hidden.service';
import { stagesWorkedBy } from '../queue/ranks';
import { isRank } from '../ranks';
import { headingOf } from './headings';
import { playableItems } from './items';
import { YESNO_KEY_PREFIX } from './keys';

type Executor = Kysely<DB> | Transaction<DB>;

/** The only thing a player is given about a yes/no question: its words, its image, and a banner when a new stretch begins. */
export type YesNoOffer = {
  itemId: number;
  prompt: string;
  imageKey: string;
  width: number | null;
  height: number | null;
  banner: { heading: string } | null;
};

function unanswered(db: Executor, userId: number, axis: string, stages: string[]) {
  return (
    playableItems(db)
      .where('i.questionKey', '=', axis)
      .where('i.minRank', 'in', stages)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsVote as v')
              .select(sql<number>`1`.as('one'))
              .whereRef('v.itemId', '=', 'i.id')
              .where('v.playerId', '=', userId)
          )
        )
      )
      .where((eb) =>
        // The same words about the same image under another id are the same question.
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsVote as v')
              .innerJoin('KnightsQueueItem as o', 'o.id', 'v.itemId')
              .select(sql<number>`1`.as('one'))
              .where('v.playerId', '=', userId)
              .whereRef('o.imageId', '=', 'i.imageId')
              .whereRef('o.prompt', '=', 'i.prompt')
          )
        )
      )
      .select(['i.id', 'i.prompt', 'img.url as imageKey', 'img.width', 'img.height'])
      // Questions already under way first, so they reach their consensus and stop being asked.
      .orderBy('i.voteCount', 'desc')
      .orderBy('i.priority', 'asc')
      .orderBy('i.id', 'asc')
      .limit(1)
  );
}

/** The player's latest yes/no axis and how many in a row they have answered on it. */
async function currentStretch(db: Executor, userId: number, stretch: number) {
  const recent = await db
    .selectFrom('KnightsVote as v')
    .innerJoin('KnightsQueueItem as i', 'i.id', 'v.itemId')
    .select('v.questionKey')
    .where('v.playerId', '=', userId)
    .where('i.audience', 'is not', null)
    .orderBy('v.createdAt', 'desc')
    .limit(stretch)
    .execute();
  const axis = recent[0]?.questionKey ?? null;
  let run = 0;
  while (run < recent.length && recent[run].questionKey === axis) run++;
  return { axis, run };
}

/**
 * The yes/no question for this feed slot, or null for a rating. The roll is fixed per player until they answer something, so reloading
 * the page does not change it. A stretch is `stretch` questions of one axis; the next axis starts with a banner. `force` skips the roll
 * (used when there is no rating to show).
 */
export async function pickYesNo(
  db: Executor,
  input: {
    userId: number;
    rank: string;
    secret: string;
    share: number;
    stretch: number;
    force?: boolean;
  }
): Promise<YesNoOffer | null> {
  if (!isRank(input.rank)) return null;
  const stages = stagesWorkedBy(input.rank);
  if (stages.length === 0) return null;

  if (!input.force) {
    if (input.share <= 0) return null;
    const digest = createHash('sha256')
      .update(`${input.secret}:yesno:${input.userId}:${await slotOf(db, input.userId)}`)
      .digest();
    if (unit(digest, 0) >= input.share) return null;
  }

  const axes = (
    await db
      .selectFrom('KnightsQuestion')
      .select('key')
      .where('kind', '=', 'bool')
      .where('active', '=', true)
      .where('key', 'like', `${YESNO_KEY_PREFIX}%`)
      .orderBy('key', 'asc')
      .execute()
  ).map((q) => q.key);
  if (axes.length === 0) return null;

  const { axis: current, run } = await currentStretch(db, input.userId, input.stretch);
  const at = current ? axes.indexOf(current) : -1;
  // Stay on the axis for the rest of its stretch, then try the others in turn, wrapping back to it last.
  const order = [
    ...(current && run < input.stretch && at !== -1 ? [current] : []),
    ...axes.slice(at + 1),
    ...axes.slice(0, at + 1),
  ];

  for (const axis of order) {
    const found = await unanswered(db, input.userId, axis, stages).executeTakeFirst();
    if (!found) continue;
    return {
      itemId: found.id,
      prompt: found.prompt ?? '',
      imageKey: found.imageKey,
      width: found.width,
      height: found.height,
      banner: axis === current ? null : { heading: headingOf(axis, YESNO_KEY_PREFIX) },
    };
  }
  return null;
}

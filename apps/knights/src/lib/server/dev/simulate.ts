import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { applyPendingResolutions, castVote, type QueueDeps } from '../queue/queue.service';
import { settleFinalItems } from '../progression/progression';
import { isFinalItem } from '../queue/item-state';
import { canVote } from '../queue/ranks';

/** Safety stop: an item cannot need more votes than this across all its stages. */
const MAX_SIMULATED_VOTES = 40;
const CANDIDATES_PER_ROUND = 50;

export type SimulatableItem = {
  id: number;
  imageKey: string;
  prompt: string;
  options: { value: string; label: string }[];
  stage: string;
  votes: number;
  votedByMe: boolean;
};

export async function listSimulatableItems(
  db: Kysely<DB>,
  callerId: number,
  limit = 20
): Promise<SimulatableItem[]> {
  const rows = await db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .select(['i.id', 'i.minRank', 'q.prompt', 'q.options', 'img.url as imageKey'])
    .select((eb) => [
      eb
        .selectFrom('KnightsVote as v')
        .select((v) => v.fn.countAll<string>().as('n'))
        .whereRef('v.itemId', '=', 'i.id')
        .as('votes'),
      eb
        .exists(
          eb
            .selectFrom('KnightsVote as mine')
            .select('mine.itemId')
            .whereRef('mine.itemId', '=', 'i.id')
            .where('mine.playerId', '=', callerId)
        )
        .as('votedByMe'),
    ])
    .where('i.status', '=', 'Open')
    .orderBy('votedByMe', 'desc')
    .orderBy('i.id', 'asc')
    .limit(limit)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    imageKey: r.imageKey,
    prompt: r.prompt,
    options: r.options as SimulatableItem['options'],
    stage: r.minRank,
    votes: Number(r.votes),
    votedByMe: Boolean(r.votedByMe),
  }));
}

export type SimulationResult = {
  itemId: number;
  cast: number;
  itemStatus: string | null;
  settled: boolean;
};

/** Casts votes through the normal castVote until the item leaves Open, then runs the tick job's write-back and payout. */
export async function simulateOtherVoters(
  db: Kysely<DB>,
  input: { callerId: number; itemId: number; answer: string },
  deps: QueueDeps
): Promise<SimulationResult> {
  let cast = 0;
  const skipped = new Set<number>();
  while (cast < MAX_SIMULATED_VOTES) {
    const item = await db
      .selectFrom('KnightsQueueItem')
      .select(['status', 'minRank'])
      .where('id', '=', input.itemId)
      .executeTakeFirst();
    if (!item || item.status !== 'Open') break;

    const candidates = await db
      .selectFrom('NewOrderPlayer as p')
      .select(['p.userId', 'p.rankType'])
      .where('p.userId', '!=', input.callerId)
      .where('p.rankType', '!=', 'Acolyte')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsVote as v')
              .select('v.playerId')
              .where('v.itemId', '=', input.itemId)
              .whereRef('v.playerId', '=', 'p.userId')
          )
        )
      )
      .orderBy('p.userId', 'asc')
      .limit(CANDIDATES_PER_ROUND)
      .execute();
    const voter = candidates.find(
      (c) => !skipped.has(c.userId) && canVote(c.rankType, item.minRank)
    );
    if (!voter) break;

    const result = await castVote(
      db,
      { userId: voter.userId, itemId: input.itemId, answer: input.answer },
      deps
    );
    if (result.status === 'rejected') {
      skipped.add(voter.userId);
      continue;
    }
    cast++;
  }

  await applyPendingResolutions(db, deps);
  await settleFinalItems(db, { now: deps.now(), mirror: deps.mirrorXp });

  const after = await db
    .selectFrom('KnightsQueueItem')
    .select(['status', 'appliedAt'])
    .where('id', '=', input.itemId)
    .executeTakeFirst();
  return {
    itemId: input.itemId,
    cast,
    itemStatus: after?.status ?? null,
    settled: after ? isFinalItem(after) : false,
  };
}

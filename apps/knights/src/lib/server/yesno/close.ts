import type { Kysely, Transaction } from 'kysely';
import { gradeKnightsVotes } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import type { XpDelta } from '../progression/legacy-exp';
import { settleItemVotes } from '../progression/progression';
import { lockItemVoters } from '../queue/queue.service';

export type Closing =
  | { kind: 'consensus'; value: 'yes' | 'no'; by: number }
  | { kind: 'none'; reason: 'no-consensus' | 'unplayable' | 'stale' | 'retired' };

/**
 * Closes a question and grades its votes the way a rating item's are: against a consensus the majority answer is `correct` and the
 * rest `failed`; any other close leaves them `inconclusive`. They are then paid by `settleItemVotes`, the path a rating vote takes, so
 * bulk XP, gold, accuracy, fervor, rank and smite work-off are the same. Returns the XP to mirror once the transaction commits.
 * The caller holds the item row lock and has locked the voters' player rows in id order (`lockItemVoters`).
 */
export async function closeYesNoItem(
  trx: Transaction<DB>,
  itemId: number,
  closing: Closing,
  now: Date
): Promise<XpDelta[]> {
  await trx
    .updateTable('KnightsQueueItem')
    .set(
      closing.kind === 'consensus'
        ? {
            status: 'Consensus',
            resolvedValue: closing.value,
            resolvedAt: utc(now),
            resolvedBy: closing.by,
            updatedAt: utc(now),
          }
        : { status: 'Closed', reason: closing.reason, resolvedAt: utc(now), updatedAt: utc(now) }
    )
    .where('id', '=', itemId)
    .execute();
  if (closing.kind === 'consensus') {
    await gradeKnightsVotes(trx, itemId, closing.value);
  } else {
    await trx
      .updateTable('KnightsVote')
      .set({ verdict: 'inconclusive' })
      .where('itemId', '=', itemId)
      .where('verdict', '=', 'pending')
      .execute();
  }
  return (await settleItemVotes(trx, itemId, now)).xp;
}

/**
 * Closes an open question outside a vote (the sweep, a retired import row). Lock order is the vote's: the item row, then the
 * voters' player rows in id order. Returns null when the question was no longer open, else the XP to mirror.
 */
export async function closeOpenYesNoItem(
  db: Kysely<DB>,
  itemId: number,
  reason: Extract<Closing, { kind: 'none' }>['reason'],
  now: Date
): Promise<XpDelta[] | null> {
  return db.transaction().execute(async (trx) => {
    const locked = await trx
      .selectFrom('KnightsQueueItem')
      .select('status')
      .where('id', '=', itemId)
      .where('audience', 'is not', null)
      .forUpdate()
      .executeTakeFirst();
    if (!locked || locked.status !== 'Open') return null;
    await lockItemVoters(trx, itemId);
    return closeYesNoItem(trx, itemId, { kind: 'none', reason }, now);
  });
}

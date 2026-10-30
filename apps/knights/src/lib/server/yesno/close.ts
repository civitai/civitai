import type { Kysely, Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { lockItemVoters } from '../queue/queue.service';
import { settleYesNoVotes } from './settle';

export type Closing =
  | { kind: 'consensus'; value: 'yes' | 'no'; by: number }
  | { kind: 'none'; reason: 'no-consensus' | 'unplayable' | 'stale' | 'retired' };

/**
 * Closes a question and pays its votes: a consensus grades them against the majority, any other close drops their gold.
 * The caller holds the item row lock and has locked the voters' player rows in id order (`lockItemVoters`).
 */
export async function closeYesNoItem(
  trx: Transaction<DB>,
  itemId: number,
  closing: Closing,
  now: Date
): Promise<void> {
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
  await trx
    .updateTable('KnightsVote')
    .set(
      closing.kind === 'consensus'
        ? {
            verdict: (eb) =>
              eb.case().when('answer', '=', closing.value).then('matched').else('unmatched').end(),
          }
        : { verdict: 'inconclusive' }
    )
    .where('itemId', '=', itemId)
    .where('verdict', '=', 'pending')
    .execute();
  await settleYesNoVotes(trx, itemId, now);
}

/**
 * Closes an open question outside a vote (the sweep, a retired import row). Lock order is the vote's: the item row, then the
 * voters' player rows in id order. Returns false when the question was no longer open.
 */
export async function closeOpenYesNoItem(
  db: Kysely<DB>,
  itemId: number,
  reason: Extract<Closing, { kind: 'none' }>['reason'],
  now: Date
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const locked = await trx
      .selectFrom('KnightsQueueItem')
      .select('status')
      .where('id', '=', itemId)
      .where('audience', 'is not', null)
      .forUpdate()
      .executeTakeFirst();
    if (!locked || locked.status !== 'Open') return false;
    await lockItemVoters(trx, itemId);
    await closeYesNoItem(trx, itemId, { kind: 'none', reason }, now);
    return true;
  });
}

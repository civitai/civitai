import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { closeOpenYesNoItem } from './close';
import { playableItems } from './items';

export type SweepResult = { unplayable: number; stale: number; failed: number };

/**
 * Closes answered questions that can no longer reach a consensus on their own, with no outcome: their answers' gold is dropped and
 * labels already written stay. A question is closed when its image is no longer shown, its axis is switched off, or nobody has answered
 * it for `maxAgeDays`. Questions nobody has answered hold no gold and are left alone, so a large import is not retired for being waited on.
 * Only players' questions are swept: a moderator's question belongs to its own queue.
 */
export async function closeStrandedYesNo(
  db: Kysely<DB>,
  { now, maxAgeDays, limit = 200 }: { now: Date; maxAgeDays: number; limit?: number }
): Promise<SweepResult> {
  const answered = await db
    .selectFrom('KnightsQueueItem')
    .select(['id', 'updatedAt'])
    .where('status', '=', 'Open')
    .where('audience', '=', 'players')
    .where('voteCount', '>', 0)
    .orderBy('id', 'asc')
    .limit(5000)
    .execute();
  if (answered.length === 0) return { unplayable: 0, stale: 0, failed: 0 };

  const playable = new Set(
    (
      await playableItems(db)
        .select('i.id')
        .where(
          'i.id',
          'in',
          answered.map((a) => a.id)
        )
        .execute()
    ).map((r) => r.id)
  );
  const staleBefore = now.getTime() - maxAgeDays * 86_400_000;

  const result: SweepResult = { unplayable: 0, stale: 0, failed: 0 };
  let closed = 0;
  for (const item of answered) {
    if (closed >= limit) break;
    const reason = !playable.has(item.id)
      ? 'unplayable'
      : item.updatedAt.getTime() < staleBefore
      ? 'stale'
      : null;
    if (!reason) continue;
    try {
      if (await closeOpenYesNoItem(db, item.id, reason, now)) {
        result[reason]++;
        closed++;
      }
    } catch (error) {
      result.failed++;
      console.error('knights: could not close a stranded yes/no question, it will be retried', {
        itemId: item.id,
        error,
      });
    }
  }
  return result;
}

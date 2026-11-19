import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { mirrorXp, type XpMirror } from '../progression/legacy-exp';
import { closeOpenYesNoItem } from './close';
import { playableItems } from './items';

export type SweepResult = { unplayable: number; stale: number; failed: number };

/**
 * Closes answered questions that can no longer reach a consensus on their own, with no outcome (their votes are `inconclusive`, as a
 * rating item closed without a verdict leaves them): gold dropped, XP stays, labels already written stay. A question is closed when its
 * image is no longer shown, its axis is switched off, or nobody has answered it for `maxAgeDays`. Questions nobody has answered hold
 * nothing and are left alone, so a large import is not retired for being waited on. Only players' questions are swept.
 *
 * It walks every answered open question in id order, a page at a time, within a time budget. A question that cannot be closed is
 * counted and stepped over, so a few of them cannot hold back the rest; the closes in one run are capped by `limit`.
 */
export async function closeStrandedYesNo(
  db: Kysely<DB>,
  {
    now,
    maxAgeDays,
    limit = 200,
    pageSize = 500,
    budgetMs = 20_000,
    mirror,
  }: {
    now: Date;
    maxAgeDays: number;
    limit?: number;
    pageSize?: number;
    budgetMs?: number;
    mirror?: XpMirror;
  }
): Promise<SweepResult> {
  const staleBefore = now.getTime() - maxAgeDays * 86_400_000;
  const deadline = Date.now() + budgetMs;
  const result: SweepResult = { unplayable: 0, stale: 0, failed: 0 };
  let closed = 0;
  let after = 0;

  while (closed < limit && Date.now() < deadline) {
    const page = await db
      .selectFrom('KnightsQueueItem')
      .select(['id', 'updatedAt'])
      .where('status', '=', 'Open')
      .where('audience', '=', 'players')
      .where('voteCount', '>', 0)
      .where('id', '>', after)
      .orderBy('id', 'asc')
      .limit(pageSize)
      .execute();
    if (page.length === 0) break;
    after = page[page.length - 1].id;

    const playable = new Set(
      (
        await playableItems(db)
          .select('i.id')
          .where(
            'i.id',
            'in',
            page.map((p) => p.id)
          )
          .execute()
      ).map((r) => r.id)
    );

    for (const item of page) {
      if (closed >= limit) break;
      const reason = !playable.has(item.id)
        ? 'unplayable'
        : item.updatedAt.getTime() < staleBefore
        ? 'stale'
        : null;
      if (!reason) continue;
      try {
        const xp = await closeOpenYesNoItem(db, item.id, reason, now);
        if (xp) {
          result[reason]++;
          closed++;
          await mirrorXp(mirror, xp);
        }
      } catch (error) {
        result.failed++;
        console.error('knights: could not close a stranded yes/no question, it will be retried', {
          itemId: item.id,
          error,
        });
      }
    }
  }
  return result;
}

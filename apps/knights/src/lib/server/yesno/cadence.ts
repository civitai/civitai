import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import type { ItemRef } from '../feed-token';
import { unit } from '../hidden/hidden.service';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * The feed's rhythm for Knights and above: a gap of ratings (5, 8 or 10), then a burst of yes/no questions (1 to 5), each
 * length rolled anew.
 */
export const BURSTS = { gaps: [5, 8, 10], burst: { min: 1, max: 5 } } as const;

/** One thing the player was served, oldest first: a yes/no question or not (a rating or a hidden check), and a stable key. */
export type Served = { yesno: boolean; key: string };

/** Enough history to see the longest run (a gap of 10) and the item that ended the run before it. */
const HISTORY = Math.max(...BURSTS.gaps, BURSTS.burst.max) + 1;

/**
 * Whether the next slot is a yes/no question. Each gap and burst length is rolled from the item that ended the run before it, so
 * the same history always gives the same answer: a reload or the page's look-ahead never re-rolls.
 */
export function burstDue(served: Served[], roll: (key: string) => number): boolean {
  const last = served.at(-1);
  let run = 0;
  while (run < served.length && served[served.length - 1 - run].yesno === (last?.yesno ?? false))
    run++;
  const before = served[served.length - 1 - run]?.key ?? 'start';

  if (last?.yesno) {
    const { min, max } = BURSTS.burst;
    const length = min + Math.floor(roll(`burst:${before}`) * (max - min + 1));
    return run < length;
  }
  const gap = BURSTS.gaps[Math.floor(roll(`gap:${before}`) * BURSTS.gaps.length)];
  return run >= gap;
}

export const burstRoller =
  (secret: string, userId: number) =>
  (key: string): number =>
    unit(createHash('sha256').update(`${secret}:burst:${userId}:${key}`).digest(), 0);

const keyOf = (ref: ItemRef) =>
  ref.kind === 'yesno' ? `y${ref.id}` : `r${ref.kind === 'hidden' ? -ref.id : ref.id}`;

/**
 * The player's recent votes, then the items already handed out ahead of them (oldest first) that have no vote yet. A hidden
 * check sits in the ledger under the negative of its reference id, so it keys the same either way.
 */
export async function servedHistory(
  db: Executor,
  userId: number,
  ahead: ItemRef[] = []
): Promise<Served[]> {
  const rows = await db
    .selectFrom('KnightsVote as v')
    .leftJoin('KnightsQueueItem as i', 'i.id', 'v.itemId')
    .select(['v.itemId', sql<boolean>`i."audience" IS NOT NULL`.as('yesno')])
    .where('v.playerId', '=', userId)
    .orderBy('v.createdAt', 'desc')
    .limit(HISTORY)
    .execute();
  const voted: Served[] = rows
    .reverse()
    .map((row) => ({ yesno: row.yesno, key: `${row.yesno ? 'y' : 'r'}${row.itemId}` }));
  const recorded = new Set(voted.map((s) => s.key));
  const pending = ahead
    .map((ref) => ({ yesno: ref.kind === 'yesno', key: keyOf(ref) }))
    .filter((s) => !recorded.has(s.key));
  return [...voted, ...pending];
}

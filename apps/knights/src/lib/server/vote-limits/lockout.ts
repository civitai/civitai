import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { voteLockUntil, type VoteLimit } from '../queue/vote-rate';
import type { VoteGate } from './gate';

type LockoutDeps = {
  gate: Pick<VoteGate, 'cooldownUntil' | 'freeze'>;
  limits: { load: () => Promise<readonly VoteLimit[]> };
};

/**
 * When a player may vote again, or null: the latest of the Redis cooldown, what the ledger says and `floor` (the end a
 * vote refusal was given). The play page, the feed and every pace refusal answer this, so they show one countdown.
 *
 * It writes: an end past the running cooldown is frozen into it (`gate.freeze`), so the countdown never moves later during
 * a pause, however many refused votes arrive. A frozen end is fixed both ways: raising the limits does not release a
 * player already paused (as a running Redis cooldown never did); new limits apply to pauses that have not started.
 */
export async function voteLockout(
  db: Kysely<DB>,
  userId: number,
  now: Date,
  { gate, limits }: LockoutDeps,
  floor: Date | null = null
): Promise<Date | null> {
  const [cooldown, ledger] = await Promise.all([
    gate.cooldownUntil(userId, now),
    limits.load().then((live) => voteLockUntil(db, userId, now, live)),
  ]);
  const end = [ledger, floor].reduce<Date | null>(
    (latest, next) => (next && (!latest || next.getTime() > latest.getTime()) ? next : latest),
    cooldown
  );
  if (!end || (cooldown && end.getTime() <= cooldown.getTime())) return end;
  return gate.freeze(userId, now, end);
}

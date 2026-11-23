import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { voteLock, type VoteLimit } from '../queue/vote-rate';
import type { Pause, VoteGate } from './gate';

type LockoutDeps = {
  gate: Pick<VoteGate, 'cooldown' | 'freeze'>;
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
  deps: LockoutDeps,
  floor: Date | null = null
): Promise<Date | null> {
  return (
    (await votePause(db, userId, now, deps, floor && { until: floor, windowSeconds: null }))
      ?.until ?? null
  );
}

/**
 * `voteLockout` with the window that set the end, for copy that names the limit. `floor` is the pause a refusal gave,
 * with its window when the refusal knew it.
 */
export async function votePause(
  db: Kysely<DB>,
  userId: number,
  now: Date,
  { gate, limits }: LockoutDeps,
  floor: Pause | null = null
): Promise<Pause | null> {
  const [cooldown, ledger] = await Promise.all([
    gate.cooldown(userId, now),
    limits.load().then((live) => voteLock(db, userId, now, live)),
  ]);
  const later = (latest: Pause | null, next: Pause | null) =>
    next && (!latest || next.until.getTime() > latest.until.getTime()) ? next : latest;
  const end = [ledger, floor].reduce<Pause | null>(later, cooldown);
  if (!end || (cooldown && end.until.getTime() <= cooldown.until.getTime())) return end;
  return gate.freeze(userId, now, end);
}

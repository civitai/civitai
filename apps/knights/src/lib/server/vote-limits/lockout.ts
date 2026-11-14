import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { voteLockUntil, type VoteLimit } from '../queue/vote-rate';
import type { VoteGate } from './gate';

type LockoutDeps = {
  gate: Pick<VoteGate, 'cooldownUntil'>;
  limits: { load: () => Promise<readonly VoteLimit[]> };
};

/**
 * When a player may vote again, or null: the later of the Redis cooldown and what the ledger says. The play page and the
 * feed show this, so the countdown matches the one the vote refusal gave.
 */
export async function voteLockout(
  db: Kysely<DB>,
  userId: number,
  now: Date,
  { gate, limits }: LockoutDeps
): Promise<Date | null> {
  const [cooldown, ledger] = await Promise.all([
    gate.cooldownUntil(userId, now),
    limits.load().then((live) => voteLockUntil(db, userId, now, live)),
  ]);
  return cooldown && ledger ? (cooldown > ledger ? cooldown : ledger) : cooldown ?? ledger;
}

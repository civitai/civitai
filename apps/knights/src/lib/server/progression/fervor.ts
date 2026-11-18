import { sql, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { PROGRESSION } from './config';
import type { Ledger } from './rating';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Correct votes × accuracy² × the display scale. Volume is uncapped, so grinding keeps paying; squaring accuracy makes
 * careful judging beat guessing fast. Accuracy is floored so a poor streak does not zero fervor.
 */
export function calculateFervor({ correct, graded }: Ledger): number {
  if (graded <= 0) return 0;
  if (correct / graded < PROGRESSION.fervorAccuracyFloor) {
    const floor = PROGRESSION.fervorAccuracyFloor;
    // Rounded before flooring so a product a hair under a whole number is not cut a point short.
    return Math.floor(Math.round(correct * PROGRESSION.fervorScale * floor * floor * 1e6) / 1e6);
  }
  // correct × scale × (correct / graded)², done as one integer division: the float product of the squared ratio can
  // land just under the exact value and floor to one less. BigInt keeps it exact at any volume.
  const c = BigInt(correct);
  return Number((c * c * c * BigInt(PROGRESSION.fervorScale)) / BigInt(graded) ** 2n);
}

const DAY_MS = 86_400_000;

/** Fervor counts votes cast in this window, as the original game's board does; `createdAt` also prunes the monthly partitions. */
export const fervorSince = (now: Date): Date =>
  new Date(now.getTime() - PROGRESSION.fervorWindowDays * DAY_MS);

/**
 * Graded, settled votes cast in the window, excluding inconclusive ones and anything before the player's `startAt`.
 * Fervor is never stored: `NewOrderPlayer.fervor` belongs to the original game's daily job.
 */
export async function fervorLedgerOf(db: Executor, playerId: number, now: Date): Promise<Ledger> {
  const totals = await db
    .selectFrom('KnightsVote as v')
    .innerJoin('NewOrderPlayer as p', 'p.userId', 'v.playerId')
    .select([
      sql<string>`count(*)`.as('graded'),
      sql<string>`count(*) filter (where v.verdict = 'correct')`.as('correct'),
    ])
    .where('v.playerId', '=', playerId)
    .where('v.createdAt', '>=', utc(fervorSince(now)))
    .where('v.settledAt', 'is not', null)
    .where('v.verdict', 'in', ['correct', 'failed'])
    .where(sql<boolean>`v."createdAt" >= p."startAt"`)
    .executeTakeFirstOrThrow();
  return { correct: Number(totals.correct), graded: Number(totals.graded) };
}

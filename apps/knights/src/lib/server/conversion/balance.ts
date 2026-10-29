import { sql, type Kysely, type SqlBool } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { CONVERSION } from './config';

/** A player is held while a payout block is set or the account is banned; all of their gold is frozen. */
export const heldSql = (playerColumn: string) =>
  sql<SqlBool>`(EXISTS (SELECT 1 FROM "NewOrderPlayer" hp WHERE hp."userId" = ${sql.ref(
    playerColumn
  )} AND hp."payoutBlockedAt" IS NOT NULL) OR EXISTS (SELECT 1 FROM "User" hu WHERE hu."id" = ${sql.ref(
    playerColumn
  )} AND hu."bannedAt" IS NOT NULL))`;

export type GoldBalance = {
  /** Gold from votes not yet graded. */
  pending: number;
  /** Earned, but no detection run has cleared it yet. */
  awaitingDetection: number;
  /** Cleared by detection and free to convert. */
  convertible: number;
  /** Everything earned and not yet converted, while the player is held. */
  frozen: number;
  /** Lifetime gold converted to Buzz. */
  converted: number;
  held: boolean;
  goldPerBuzz: number;
  minBuzz: number;
  /** Whole Buzz a conversion would pay right now; 0 below the minimum. */
  buzzOnConvert: number;
};

type Row = { goldPending: number; goldEarned: number; goldCleared: number; goldConverted: number };

export function balanceOf(row: Row, held: boolean): GoldBalance {
  const unconverted = Math.max(0, row.goldEarned - row.goldConverted);
  const convertible = held ? 0 : Math.max(0, row.goldCleared - row.goldConverted);
  const buzz = Math.floor(convertible / CONVERSION.goldPerBuzz);
  return {
    pending: row.goldPending,
    awaitingDetection: held ? 0 : unconverted - convertible,
    convertible,
    frozen: held ? unconverted : 0,
    converted: row.goldConverted,
    held,
    goldPerBuzz: CONVERSION.goldPerBuzz,
    minBuzz: CONVERSION.minBuzz,
    buzzOnConvert: buzz >= CONVERSION.minBuzz ? buzz : 0,
  };
}

export async function getGoldBalance(db: Kysely<DB>, playerId: number): Promise<GoldBalance> {
  const row = await db
    .selectFrom('NewOrderPlayer as p')
    .select([
      'p.goldPending',
      'p.goldEarned',
      'p.goldCleared',
      'p.goldConverted',
      heldSql('p.userId').as('held'),
    ])
    .where('p.userId', '=', playerId)
    .executeTakeFirst();
  return balanceOf(
    row ?? { goldPending: 0, goldEarned: 0, goldCleared: 0, goldConverted: 0 },
    Boolean(row?.held)
  );
}

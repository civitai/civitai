import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { CONVERSION } from './config';
import { heldSql } from './held';

export type GoldBalance = {
  pending: number;
  convertible: number;
  /** Everything earned and not yet converted, while the player is held. */
  frozen: number;
  /** Gold held by a pending Buzz conversion or an unconfirmed membership purchase. */
  onItsWay: number;
  /** Gold Buzz has paid for. */
  converted: number;
  /** Gold spent in the shop on cosmetics and membership. */
  spent: number;
  held: boolean;
  goldPerBuzz: number;
  minBuzz: number;
  /** Whole Buzz a conversion would pay right now; 0 below the minimum. */
  buzzOnConvert: number;
};

type Row = {
  goldPending: number;
  goldEarned: number;
  goldConverted: number;
  goldReserved: number;
  goldSpent: number;
};

/** What a player can spend or convert right now (before the hold check): earned gold not yet converted, reserved or spent. */
export const spendableOf = ({
  goldEarned,
  goldConverted,
}: {
  goldEarned: number;
  goldConverted: number;
}) => Math.max(0, goldEarned - goldConverted);

/** `goldConverted` counts reservations too, so convertible and frozen already exclude gold that is on its way. */
export function balanceOf(row: Row, held: boolean): GoldBalance {
  const unconverted = spendableOf(row);
  const convertible = held ? 0 : unconverted;
  const buzz = Math.floor(convertible / CONVERSION.goldPerBuzz);
  return {
    pending: row.goldPending,
    convertible,
    frozen: held ? unconverted : 0,
    onItsWay: row.goldReserved,
    converted: row.goldConverted - row.goldReserved - row.goldSpent,
    spent: row.goldSpent,
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
      'p.goldConverted',
      sql<number>`((SELECT COALESCE(sum(c."gold"), 0) FROM "KnightsGoldConversion" c WHERE c."playerId" = p."userId" AND c."status" = 'pending')
        + (SELECT COALESCE(sum(s."gold"), 0) FROM "KnightsShopPurchase" s WHERE s."playerId" = p."userId" AND s."status" = 'pending' AND s."kind" <> 'buzz_pack'))::int`.as(
        'goldReserved'
      ),
      sql<number>`(SELECT COALESCE(sum(s."gold"), 0) FROM "KnightsShopPurchase" s WHERE s."playerId" = p."userId" AND s."status" = 'granted' AND s."kind" <> 'buzz_pack')::int`.as(
        'goldSpent'
      ),
      heldSql('p.userId').as('held'),
    ])
    .where('p.userId', '=', playerId)
    .executeTakeFirst();
  return balanceOf(
    row ?? { goldPending: 0, goldEarned: 0, goldConverted: 0, goldReserved: 0, goldSpent: 0 },
    Boolean(row?.held)
  );
}

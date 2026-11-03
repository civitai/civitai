import { clickhouse } from '~/server/clickhouse/client';
import { clickhouseTransactionTypePredicate } from '~/server/clickhouse/transaction-type';
import { TransactionType } from '~/shared/constants/buzz.constants';

/**
 * Rings of accounts buying one creator's paid access with Blue Buzz.
 *
 * A ring is one creator with at least `minBuyers` distinct Blue Buzz buyers of their paid access in
 * the window, counting only buyers who sent at least `minSharePct` percent of their own Blue Buzz
 * paid-access spend in that window to this creator. A buyer who also buys elsewhere is not counted,
 * so a creator with many ordinary buyers is not a ring.
 */

/** The producer key. Opaque — it groups runs on the board, so renaming it orphans this detector's
 *  history. */
export const BLUE_PAID_ACCESS_DETECTOR = 'blue-buzz-paid-access';

/**
 * 🔴 EQUAL TO THE JOB'S CADENCE, AND PINNED TO IT BY `__tests__/job-wiring.test.ts`. The run does not
 * dedupe against earlier runs: it files a ring only when one of its buyers bought in the last
 * interval, so a ring is filed again only on a day it is still buying. A faster cron would file one
 * day's activity more than once; a slower one would skip days.
 */
export const RUN_INTERVAL_HOURS = 24;

/** A ceiling on rows read back. Hitting it is logged, because the rings past it go unread. */
export const PAIR_CEILING = 200_000;

export type RingThresholds = { windowDays: number; minBuyers: number; minSharePct: number };

/** One buyer's Blue Buzz paid-access purchases from one creator in the window. */
export type BuyerPair = {
  creatorId: number;
  buyerId: number;
  /** Blue Buzz this buyer paid this creator for access. */
  spent: number;
  /** Blue Buzz this buyer paid for access from every creator. */
  buyerTotal: number;
  purchases: number;
  versions: number;
  firstAt: Date;
  lastAt: Date;
};

export type RingBuyer = BuyerPair & { sharePct: number };

export type Ring = {
  creatorId: number;
  /** Concentrated buyers, the ones reported. */
  buyers: RingBuyer[];
  /** Every distinct Blue Buzz buyer of this creator's access in the window. */
  allBuyers: number;
  spent: number;
  purchases: number;
  firstAt: Date;
  lastAt: Date;
};

/** `$query` is the only method used, so the port is stated rather than importing the whole client
 *  type — and it is what a test substitutes. */
export type DetectionClickhouse = { $query: <T extends object>(sql: string) => Promise<T[]> };

const clickhouseDateTime = (at: Date) =>
  `toDateTime('${at.toISOString().slice(0, 19).replace('T', ' ')}', 'UTC')`;

/**
 * Per (creator, buyer) totals, with each buyer's total across all creators. Only creators with at
 * least `minBuyers` distinct buyers are read back: a creator below that cannot be a ring whatever
 * the shares are.
 */
export function buyerPairsSql({ since, minBuyers }: { since: Date; minBuyers: number }) {
  return `
    WITH purchases AS (
      SELECT toInt64(fromAccountId) AS buyer, toInt64(toAccountId) AS creator,
        toInt64(amount) AS amount, date,
        splitByChar('-', externalTransactionId)[3] AS versionId
      FROM buzzTransactions
      WHERE date >= ${clickhouseDateTime(since)}
        AND ${clickhouseTransactionTypePredicate(TransactionType.Purchase)}
        AND fromAccountType = 'blue'
        AND (externalTransactionId LIKE 'early-access-%'
             OR externalTransactionId LIKE 'permanent-access-%')
        AND fromAccountId > 0 AND toAccountId > 0 AND fromAccountId != toAccountId
    )
    SELECT p.creator AS creatorId, p.buyer AS buyerId, p.spent AS spent, t.total AS buyerTotal,
      p.purchases AS purchases, p.versions AS versions, p.firstAt AS firstAt, p.lastAt AS lastAt
    FROM (
      SELECT creator, buyer, sum(amount) AS spent, count() AS purchases,
        uniqExact(versionId) AS versions,
        toUnixTimestamp(min(date)) AS firstAt, toUnixTimestamp(max(date)) AS lastAt
      FROM purchases
      WHERE creator IN (
        SELECT creator FROM purchases GROUP BY creator HAVING uniqExact(buyer) >= ${Math.trunc(
          minBuyers
        )}
      )
      GROUP BY creator, buyer
    ) AS p
    INNER JOIN (SELECT buyer, sum(amount) AS total FROM purchases GROUP BY buyer) AS t
      ON t.buyer = p.buyer
    LIMIT ${PAIR_CEILING}
  `;
}

export async function findBuyerPairs(
  ch: DetectionClickhouse,
  params: { since: Date; minBuyers: number }
): Promise<BuyerPair[]> {
  const rows = await ch.$query<Record<keyof BuyerPair, string | number>>(buyerPairsSql(params));
  return rows.map((r) => ({
    creatorId: Number(r.creatorId),
    buyerId: Number(r.buyerId),
    spent: Number(r.spent),
    buyerTotal: Number(r.buyerTotal),
    purchases: Number(r.purchases),
    versions: Number(r.versions),
    firstAt: new Date(Number(r.firstAt) * 1000),
    lastAt: new Date(Number(r.lastAt) * 1000),
  }));
}

/** The ring rule over the pairs, largest ring first. `activeSince` drops rings none of whose
 *  buyers bought after it. */
export function findRings(
  pairs: BuyerPair[],
  {
    minBuyers,
    minSharePct,
    activeSince,
  }: Omit<RingThresholds, 'windowDays'> & { activeSince: Date }
): Ring[] {
  const byCreator = new Map<number, BuyerPair[]>();
  for (const p of pairs) byCreator.set(p.creatorId, [...(byCreator.get(p.creatorId) ?? []), p]);

  const rings: Ring[] = [];
  for (const [creatorId, creatorPairs] of byCreator) {
    const buyers = creatorPairs
      .filter((p) => p.buyerTotal > 0 && p.spent * 100 >= p.buyerTotal * minSharePct)
      .map((p) => ({ ...p, sharePct: Math.floor((p.spent / p.buyerTotal) * 100) }))
      .sort((a, b) => b.spent - a.spent || a.buyerId - b.buyerId);
    if (buyers.length < minBuyers) continue;
    const lastAt = new Date(Math.max(...buyers.map((b) => b.lastAt.getTime())));
    if (lastAt < activeSince) continue;
    rings.push({
      creatorId,
      buyers,
      allBuyers: new Set(creatorPairs.map((p) => p.buyerId)).size,
      spent: buyers.reduce((sum, b) => sum + b.spent, 0),
      purchases: buyers.reduce((sum, b) => sum + b.purchases, 0),
      firstAt: new Date(Math.min(...buyers.map((b) => b.firstAt.getTime()))),
      lastAt,
    });
  }
  return rings.sort((a, b) => b.buyers.length - a.buyers.length || a.creatorId - b.creatorId);
}

export const defaultClickhouse = (): DetectionClickhouse | null => clickhouse ?? null;

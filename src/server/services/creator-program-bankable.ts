import { clickhouse } from '~/server/clickhouse/client';
import { escapeClickhouseString } from '~/server/clickhouse/escape';
import { dbRead } from '~/server/db/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  APP_AUTHOR_FEE_DESCRIPTION,
  buzzBankTypesSql,
  BuzzType,
  GENERATION_TIP_TRANSACTION_PREFIX,
} from '~/shared/constants/buzz.constants';
import {
  BANKABLE_CUTOVER,
  EXTRACTION_FEE_DESCRIPTION,
} from '~/shared/constants/creator-program.constants';
import { PLACEMENT_LEDGER_TEXT } from '~/shared/utils/placement';
import dayjs from '~/shared/utils/dayjs';

// Ledger rows can land in ClickHouse a little after their timestamp, so a snapshot taken right at
// the cutover could miss the last pre-cutover rows and then be stored forever.
const SNAPSHOT_SETTLE_MS = 60 * 60 * 1000;
const SNAPSHOT_SETTLED_AT = new Date(BANKABLE_CUTOVER.getTime() + SNAPSHOT_SETTLE_MS);

const sqlString = (value: string) => `'${escapeClickhouseString(value)}'`;

const placementEarningDescriptionsSql = Object.values(PLACEMENT_LEDGER_TEXT)
  .flatMap((text) => [text.toOwner, text.feeToOwner, text.toSeller])
  .map(sqlString)
  .join(', ');

/**
 * Transactions that raise a creator's bankable amount. Excludes generation `compensation`, purchased
 * Buzz, and system-minted tips. Generation tips are stored as `compensation` but are bankable: the
 * generating user pays them on top of the price. Tips paid before `GENERATION_TIP_TRANSACTION_START`
 * are folded into compensation and cannot be told apart; the cutover snapshot covers them.
 *
 * App Blocks author fees are `fee` rows from before `TransactionType.AppAuthorFee` existed and
 * `unknown_28` rows after it: that is how ClickHouse stores them, not `'28'`. `appAuthorFee` is what
 * they become if the ingest learns the type's name.
 */
export const BANKABLE_EARNING_PREDICATE_SQL = `(
  type IN ('licenseFee', 'donation', 'sell', 'bounty')
  OR (type IN ('purchase', 'tip') AND fromAccountId != 0)
  OR (type = 'compensation' AND fromAccountId = 0 AND startsWith(externalTransactionId, ${sqlString(
    GENERATION_TIP_TRANSACTION_PREFIX
  )}))
  OR (type = 'fee' AND description IN (${placementEarningDescriptionsSql}))
  OR (type IN ('fee', 'unknown_28', 'appAuthorFee') AND description LIKE ${sqlString(
    `${APP_AUTHOR_FEE_DESCRIPTION}%`
  )})
)`;

/**
 * Sets the Peak Earning Month. Narrower than the bankable predicate on purpose: tips, donations,
 * sales, bounties and app/placement fees are bankable but do not set the peak.
 */
export const PEAK_EARNING_PREDICATE_SQL = `(
  type = 'licenseFee'
  OR (type = 'purchase' AND fromAccountId != 0)
)`;

/** Until the cutover generation compensation still sets the peak, so caps do not drop early. */
export const PRE_CUTOVER_PEAK_EARNING_PREDICATE_SQL = `(
  type IN ('compensation', 'licenseFee')
  OR (type = 'purchase' AND fromAccountId != 0)
)`;

const userAccountTypesSql = Object.values(BuzzType).map(sqlString).join(', ');

/** Paid from a user's own Buzz account. */
export const RECEIVED_FROM_USER_SQL = `(fromAccountId > 0 AND fromAccountType IN (${userAccountTypesSql}))`;

/**
 * Buzz sent from one user's accounts to another's, whatever the type. Blue counts too, so the
 * counterparty review does not depend on every payment path paying out in the colour it was paid
 * in.
 */
export const SENT_TO_USER_SQL = `(fromAccountType IN (${userAccountTypesSql}) AND toAccountId > 0 AND toAccountType IN (${userAccountTypesSql}))`;

/** A sale the platform pays out to the seller after charging the buyer, named in `details`. */
export const PLATFORM_PAID_SALE_SQL = `(type = 'sell' AND fromAccountId = 0 AND JSONExtractInt(details, 'purchasedBy') > 0)`;

/** A bounty award, paid by the platform out of what the bounty's supporters put in. */
export const BOUNTY_AWARD_SQL = `(type = 'bounty' AND fromAccountId = 0 AND JSONExtractString(details, 'entityType') = 'Bounty')`;

/** A supporter's part of an awarded bounty: `unitAmount` of the bounty's `total`. */
export type BountyFunder = { bountyId: number; userId: number; unitAmount: number; total: number };

export const clickhouseDateTime = (at: Date) =>
  `'${at.toISOString().slice(0, 19).replace('T', ' ')}'`;

/** Bounties awarded by the rows `where` selects. */
export function awardedBountiesSql(where: string) {
  return `
    SELECT DISTINCT JSONExtractInt(details, 'entityId') AS bountyId FROM buzzTransactions
    WHERE ${where} AND ${BOUNTY_AWARD_SQL}
  `;
}

export async function getBountyFunders(bountyIds: number[]): Promise<BountyFunder[]> {
  if (!bountyIds.length) return [];
  const rows = await dbRead.$queryRaw<{ bountyId: number; userId: number; unitAmount: number }[]>`
    SELECT "bountyId", "userId", "unitAmount" FROM "BountyBenefactor"
    WHERE "bountyId" = ANY(${bountyIds}::int[])
      AND "awardedAt" IS NOT NULL
      AND currency = 'BUZZ'
      AND "unitAmount" > 0
  `;
  const totals = new Map<number, number>();
  for (const r of rows) totals.set(r.bountyId, (totals.get(r.bountyId) ?? 0) + r.unitAmount);
  return rows.map((r) => ({ ...r, total: totals.get(r.bountyId) ?? r.unitAmount }));
}

/**
 * Bankable earnings in the rows `where` selects, per recipient and the user who paid them:
 * paid straight from a user's account, a platform-paid sale by its buyer, and a bounty award
 * split between its supporters by what each put in.
 */
export function receivedFromUsersSql(where: string, funders: BountyFunder[]) {
  const arms = [
    `SELECT toInt64(toAccountId) AS recipient,
      toInt64(if(fromAccountId = 0, JSONExtractInt(details, 'purchasedBy'), fromAccountId)) AS payer,
      toInt64(amount) AS amount
    FROM buzzTransactions
    WHERE ${where} AND ${BANKABLE_EARNING_PREDICATE_SQL}
      AND (${RECEIVED_FROM_USER_SQL} OR ${PLATFORM_PAID_SALE_SQL})`,
  ];
  if (funders.length)
    arms.push(`SELECT award.recipient, funder.userId,
      intDiv(award.amount * funder.unitAmount, funder.total)
    FROM (
      SELECT toInt64(toAccountId) AS recipient, JSONExtractInt(details, 'entityId') AS bountyId,
        toInt64(amount) AS amount
      FROM buzzTransactions
      WHERE ${where} AND ${BOUNTY_AWARD_SQL}
    ) AS award
    INNER JOIN (
      SELECT * FROM values('bountyId Int64, userId Int64, unitAmount Int64, total Int64', ${funders
        .map((f) => `(${f.bountyId}, ${f.userId}, ${f.unitAmount}, ${f.total})`)
        .join(', ')})
    ) AS funder ON funder.bountyId = award.bountyId`);

  return `
    SELECT recipient, payer, sum(amount) AS amount FROM (${arms.join(' UNION ALL ')})
    GROUP BY recipient, payer
  `;
}

export type BankableLedger = {
  /** Yellow + green balance at the cutover. */
  snapshot: number;
  /** Bankable earnings since the cutover. */
  earned: number;
  /** What the creator paid other users since the cutover, in Buzz that became bankable for them. */
  spent: number;
  /** Closed months since the cutover: banked, minus extracted, plus extraction fees. */
  consumed: number;
};

export type BankableAmount = BankableLedger & {
  /** What may still be banked this month, before the tier cap. Never negative. */
  remaining: number;
};

/**
 * A row dated past the settle point shows ingest has reached it; the clock alone would store a
 * short snapshot forever if ingest stalled.
 */
async function hasIngestSettled(now: Date, settledAt = SNAPSHOT_SETTLED_AT) {
  if (now < settledAt || !clickhouse) return false;
  const rows = await clickhouse.$query<{ settled: number }>`
    SELECT 1 AS settled FROM buzzTransactions WHERE date >= ${settledAt} LIMIT 1
  `;
  return rows.length > 0;
}

async function getCutoverSnapshot(userId: number, now: Date) {
  if (!clickhouse) return 0;

  const stored = decodeRedisString(
    await sysRedis.hGet(REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SNAPSHOT, String(userId))
  );
  const storedSnapshot = stored == null ? NaN : Number(stored);
  if (Number.isFinite(storedSnapshot)) return storedSnapshot;

  // Separate scans per column: one OR across fromAccountId and toAccountId measured ~10x slower.
  const [row] = await clickhouse.$query<{ balance: number }>`
    SELECT
      (
        SELECT sum(amount) FROM buzzTransactions
        WHERE toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql})
          AND date < ${BANKABLE_CUTOVER}
      ) - (
        SELECT sum(amount) FROM buzzTransactions
        WHERE fromAccountId = ${userId} AND fromAccountType IN (${buzzBankTypesSql})
          AND date < ${BANKABLE_CUTOVER}
      ) AS balance
  `;
  const snapshot = Math.max(0, Number(row?.balance ?? 0));

  if (await hasIngestSettled(now))
    await sysRedis.hSet(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SNAPSHOT,
      String(userId),
      String(snapshot)
    );

  return snapshot;
}

/** Awarded bounties `userId` helped fund, with their part of each. */
async function getBountiesFundedBy(userId: number) {
  const funded = await dbRead.$queryRaw<{ bountyId: number }[]>`
    SELECT "bountyId" FROM "BountyBenefactor"
    WHERE "userId" = ${userId}
      AND "awardedAt" IS NOT NULL
      AND currency = 'BUZZ'
      AND "unitAmount" > 0
  `;
  const funders = await getBountyFunders(funded.map((r) => r.bountyId));
  return funders.filter((f) => f.userId === userId);
}

/**
 * What `userId` paid other users in a window, counted where it became bankable for them:
 * paid from their own account, a platform-paid sale they bought, and their part of a bounty they
 * helped fund.
 */
export function paidToUsersSql(
  userId: number,
  funded: BountyFunder[],
  { from, to }: { from: Date; to?: Date }
) {
  const paidTo = `toAccountId > 0 AND toAccountId != ${userId} AND toAccountType IN (${buzzBankTypesSql})
    AND date >= ${clickhouseDateTime(from)}${to ? ` AND date < ${clickhouseDateTime(to)}` : ''}`;
  const arms = [
    `SELECT toInt64(amount) AS amount FROM buzzTransactions
    WHERE fromAccountId = ${userId} AND ${paidTo}
      AND ${BANKABLE_EARNING_PREDICATE_SQL} AND ${RECEIVED_FROM_USER_SQL}`,
    `SELECT toInt64(amount) AS amount FROM buzzTransactions
    WHERE ${PLATFORM_PAID_SALE_SQL} AND ${paidTo}
      AND JSONExtractInt(details, 'purchasedBy') = ${userId}`,
  ];
  if (funded.length)
    arms.push(`SELECT intDiv(award.amount * funder.unitAmount, funder.total) AS amount
    FROM (
      SELECT JSONExtractInt(details, 'entityId') AS bountyId, toInt64(amount) AS amount
      FROM buzzTransactions
      WHERE ${BOUNTY_AWARD_SQL} AND ${paidTo}
    ) AS award
    INNER JOIN (
      SELECT * FROM values('bountyId Int64, unitAmount Int64, total Int64', ${funded
        .map((f) => `(${f.bountyId}, ${f.unitAmount}, ${f.total})`)
        .join(', ')})
    ) AS funder ON funder.bountyId = award.bountyId`);

  return `SELECT sum(amount) AS spent FROM (${arms.join(' UNION ALL ')})`;
}

type SpentThrough = { through: string; spent: number };

function readSpentThrough(raw: string | null | undefined): SpentThrough | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SpentThrough>;
    const through = new Date(value?.through ?? NaN);
    return Number.isFinite(through.getTime()) && Number.isFinite(value?.spent)
      ? { through: through.toISOString(), spent: Number(value.spent) }
      : null;
  } catch {
    return null;
  }
}

/**
 * What the creator paid other users since the cutover. Scanning the whole window on every read
 * measured seconds, so the total up to the last settled UTC day is stored and only the days after
 * it are read.
 */
async function getSpent(userId: number, now: Date) {
  if (!clickhouse) return 0;
  const ch = clickhouse;
  const settled = dayjs
    .utc(now.getTime() - SNAPSHOT_SETTLE_MS)
    .startOf('day')
    .toDate();
  const through = settled > BANKABLE_CUTOVER ? settled : BANKABLE_CUTOVER;

  const [stored, funded] = await Promise.all([
    sysRedis
      .hGet(REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT, String(userId))
      .then((raw) => readSpentThrough(decodeRedisString(raw))),
    getBountiesFundedBy(userId),
  ]);
  const closed =
    stored && new Date(stored.through) <= through
      ? stored
      : { through: BANKABLE_CUTOVER.toISOString(), spent: 0 };
  const closedThrough = new Date(closed.through);

  const spentIn = async (window: { from: Date; to?: Date }) => {
    const [row] = await ch.$query<{ spent: number }>(paidToUsersSql(userId, funded, window));
    return Number(row?.spent ?? 0);
  };
  const [added, live] = await Promise.all([
    closedThrough < through ? spentIn({ from: closedThrough, to: through }) : 0,
    spentIn({ from: through }),
  ]);

  if (
    closedThrough < through &&
    (await hasIngestSettled(now, new Date(through.getTime() + SNAPSHOT_SETTLE_MS)))
  )
    await sysRedis.hSet(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT,
      String(userId),
      JSON.stringify({ through: through.toISOString(), spent: closed.spent + added })
    );

  return closed.spent + added + live;
}

/**
 * The ClickHouse half of the bankable amount, or `null` before the cutover or without ClickHouse
 * (only the tier cap applies then). This month's deposits are not in it: see `withBankedThisMonth`.
 */
export async function getBankableLedger(
  userId: number,
  now = new Date()
): Promise<BankableLedger | null> {
  if (now < BANKABLE_CUTOVER || !clickhouse) return null;

  const monthStart = dayjs.utc(now).startOf('month').toDate();
  const [snapshot, [sums], spent] = await Promise.all([
    getCutoverSnapshot(userId, now),
    clickhouse.$query<{ earned: number; consumed: number }>`
      SELECT
        (
          SELECT sum(amount) FROM buzzTransactions
          WHERE toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql})
            AND date >= ${BANKABLE_CUTOVER}
            AND ${BANKABLE_EARNING_PREDICATE_SQL}
        ) AS earned,
        (
          SELECT sumIf(amount, type = 'bank')
            + sumIf(amount, type = 'fee' AND description = ${sqlString(EXTRACTION_FEE_DESCRIPTION)})
          FROM buzzTransactions
          WHERE fromAccountId = ${userId} AND fromAccountType IN (${buzzBankTypesSql})
            AND date >= ${BANKABLE_CUTOVER} AND date < ${monthStart}
        ) - (
          SELECT sum(amount) FROM buzzTransactions
          WHERE toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql})
            AND type = 'extract'
            AND date >= ${BANKABLE_CUTOVER} AND date < ${monthStart}
        ) AS consumed
    `,
    getSpent(userId, now),
  ]);

  return {
    snapshot,
    earned: Number(sums?.earned ?? 0),
    spent,
    consumed: Number(sums?.consumed ?? 0),
  };
}

/**
 * `bankedThisMonth` comes from the Buzz service rather than ClickHouse so a deposit made seconds
 * ago is already counted; closed months are read from ClickHouse, which has caught up by then.
 */
export function withBankedThisMonth(
  ledger: BankableLedger,
  bankedThisMonth: number
): BankableAmount {
  // What the creator paid other users comes out of what they earned, never out of the snapshot.
  // Both are totals since the cutover, so paying out more than was earned carries forward.
  const remaining = Math.max(
    0,
    ledger.snapshot +
      // A ledger cached before `spent` existed has none.
      Math.max(0, ledger.earned - (ledger.spent ?? 0)) -
      ledger.consumed -
      bankedThisMonth
  );
  return { ...ledger, remaining };
}

export async function getBankableAmount(
  userId: number,
  bankedThisMonth: number,
  now = new Date()
): Promise<BankableAmount | null> {
  const ledger = await getBankableLedger(userId, now);
  return ledger && withBankedThisMonth(ledger, bankedThisMonth);
}

import { clickhouse } from '~/server/clickhouse/client';
import { escapeClickhouseString } from '~/server/clickhouse/escape';
import { clickhouseTransactionTypePredicate } from '~/server/clickhouse/transaction-type';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  APP_AUTHOR_FEE_DESCRIPTION,
  buzzBankTypesSql,
  BuzzType,
  GENERATION_TIP_TRANSACTION_PREFIX,
  TransactionType,
} from '~/shared/constants/buzz.constants';
import {
  BANKABLE_CUTOVER,
  EXTRACTION_FEE_DESCRIPTION,
} from '~/shared/constants/creator-program.constants';
import {
  SERVICE_DEAL_TRANSACTION_PREFIX,
  type ServiceDealLegName,
} from '~/shared/constants/creator-services.constants';
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

const SERVICE_RELEASE_LEG: ServiceDealLegName = 'release';

/**
 * A Creator Services release, paid by the platform to the seller out of the buyer's hold. Holds
 * and refunds share the type, so the leg is told by its id. The buyer is `details.buyerId`; a
 * release without one is not bankable, since nothing could net it against them.
 */
export const SERVICE_RELEASE_SQL = `(${clickhouseTransactionTypePredicate(
  TransactionType.ServiceEscrow
)} AND fromAccountId = 0 AND startsWith(externalTransactionId, ${sqlString(
  SERVICE_DEAL_TRANSACTION_PREFIX
)}) AND endsWith(externalTransactionId, ${sqlString(
  `-${SERVICE_RELEASE_LEG}`
)}) AND JSONExtractInt(details, 'buyerId') > 0)`;

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
  OR ${SERVICE_RELEASE_SQL}
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

/**
 * A bounty award, paid by the platform out of what the bounty's supporters put in. The award
 * names them and what each put in (`supporterIds`, `supporterAmounts`), so it is split between
 * them by that.
 */
export const BOUNTY_AWARD_SQL = `(type = 'bounty' AND fromAccountId = 0 AND JSONExtractString(details, 'entityType') = 'Bounty')`;

/**
 * One row per transaction, for totals that are stored for good: a duplicate row the table has not
 * merged away yet would stay in them. The table's sort key; FINAL measured a minute on a heavy
 * creator.
 */
const ONE_ROW_PER_TRANSACTION = 'LIMIT 1 BY date, fromAccountId, toAccountId, transactionId';

/** A bounty award's charges: who was charged (`ids`), how much (`amts`) and when (`ats`). */
const bountyAwardsSql = (where: string, dedupe = '') => `
  SELECT toInt64(toAccountId) AS recipient, toInt64(amount) AS amount,
    JSONExtract(details, 'supporterIds', 'Array(Int64)') AS ids,
    JSONExtract(details, 'supporterAmounts', 'Array(Int64)') AS amts,
    JSONExtract(details, 'supporterChargedAt', 'Array(Int64)') AS ats
  FROM buzzTransactions
  WHERE ${where} AND ${BOUNTY_AWARD_SQL}
    AND length(ids) = length(amts) AND length(ids) = length(ats) AND arraySum(amts) > 0
  ${dedupe}
`;

/** Read as UTC whatever the server's time zone. */
export const clickhouseDateTime = (at: Date) =>
  `toDateTime('${at.toISOString().slice(0, 19).replace('T', ' ')}', 'UTC')`;

/**
 * Bankable Buzz the platform paid out of what a user spent, per recipient and the user who paid
 * it: a sale or service release by its buyer, and a bounty award split between its supporters.
 */
export function platformPaidFromUsersSql(where: string) {
  return `
    SELECT toInt64(toAccountId) AS recipient, toInt64(JSONExtractInt(details, 'purchasedBy')) AS payer,
      toInt64(amount) AS amount
    FROM buzzTransactions
    WHERE ${where} AND ${PLATFORM_PAID_SALE_SQL}
    UNION ALL
    SELECT toInt64(toAccountId) AS recipient, toInt64(JSONExtractInt(details, 'buyerId')) AS payer,
      toInt64(amount) AS amount
    FROM buzzTransactions
    WHERE ${where} AND ${SERVICE_RELEASE_SQL}
    UNION ALL
    SELECT recipient, s.1 AS payer, intDiv(amount * s.2, arraySum(amts)) AS amount
    FROM (${bountyAwardsSql(where)}) ARRAY JOIN arrayZip(ids, amts) AS s
  `;
}

/** Bankable earnings in the rows `where` selects, per recipient and the user who paid them. */
export function receivedFromUsersSql(where: string) {
  return `
    SELECT recipient, payer, sum(amount) AS amount FROM (
      SELECT toInt64(toAccountId) AS recipient, toInt64(fromAccountId) AS payer,
        toInt64(amount) AS amount
      FROM buzzTransactions
      WHERE ${where} AND ${BANKABLE_EARNING_PREDICATE_SQL} AND ${RECEIVED_FROM_USER_SQL}
      UNION ALL
      ${platformPaidFromUsersSql(where)}
    )
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
 * short snapshot forever if ingest stalled. A row dated in the future proves nothing.
 */
async function hasIngestSettled(now: Date, settledAt = SNAPSHOT_SETTLED_AT) {
  if (now < settledAt || !clickhouse) return false;
  const rows = await clickhouse.$query<{ settled: number }>`
    SELECT 1 AS settled FROM buzzTransactions WHERE date >= ${settledAt} AND date <= ${now} LIMIT 1
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
        SELECT sum(amount) FROM (
          SELECT amount FROM buzzTransactions
          WHERE toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql})
            AND date < ${BANKABLE_CUTOVER}
          ${ONE_ROW_PER_TRANSACTION}
        )
      ) - (
        SELECT sum(amount) FROM (
          SELECT amount FROM buzzTransactions
          WHERE fromAccountId = ${userId} AND fromAccountType IN (${buzzBankTypesSql})
            AND date < ${BANKABLE_CUTOVER}
          ${ONE_ROW_PER_TRANSACTION}
        )
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

/**
 * What `userId` paid other users in a window, counted where it became bankable for them:
 * paid from their own account, a platform-paid sale or service they bought, and their part of a
 * bounty they helped fund.
 */
export function paidToUsersSql(userId: number, { from, to }: { from: Date; to?: Date }) {
  const paidTo = `toAccountId > 0 AND toAccountId != ${userId} AND toAccountType IN (${buzzBankTypesSql})
    AND date >= ${clickhouseDateTime(from)}${to ? ` AND date < ${clickhouseDateTime(to)}` : ''}`;
  // A closed window's total is stored.
  const dedupe = to ? ONE_ROW_PER_TRANSACTION : '';
  // A charge made before the cutover is already out of the cutover balance: a bounty contribution,
  // or the hold behind a service release.
  const cutoverSeconds = BANKABLE_CUTOVER.getTime() / 1000;
  const ownCharges = `(id, a, t) -> if(id = ${userId} AND t >= ${cutoverSeconds}, a, 0)`;
  return `
    SELECT sum(amount) AS spent FROM (
      SELECT toInt64(amount) AS amount FROM buzzTransactions
      WHERE fromAccountId = ${userId} AND ${paidTo}
        AND ${BANKABLE_EARNING_PREDICATE_SQL} AND ${RECEIVED_FROM_USER_SQL}
      ${dedupe}
      UNION ALL
      SELECT toInt64(amount) AS amount FROM buzzTransactions
      WHERE ${PLATFORM_PAID_SALE_SQL} AND ${paidTo}
        AND JSONExtractInt(details, 'purchasedBy') = ${userId}
      ${dedupe}
      UNION ALL
      SELECT toInt64(amount) AS amount FROM buzzTransactions
      WHERE ${SERVICE_RELEASE_SQL} AND ${paidTo}
        AND JSONExtractInt(details, 'buyerId') = ${userId}
        AND JSONExtractInt(details, 'heldAt') >= ${cutoverSeconds}
      ${dedupe}
      UNION ALL
      SELECT intDiv(amount * arraySum(arrayMap(${ownCharges}, ids, amts, ats)), arraySum(amts)) AS amount
      FROM (${bountyAwardsSql(paidTo, dedupe)})
      WHERE has(ids, ${userId})
    )
  `;
}

/** A day past what is stored: a row landing later than that would be left out of it for good. */
const SPENT_SETTLE_MS = 24 * 60 * 60 * 1000;

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
    .utc(now.getTime() - SPENT_SETTLE_MS)
    .startOf('day')
    .toDate();
  const through = settled > BANKABLE_CUTOVER ? settled : BANKABLE_CUTOVER;

  const stored = readSpentThrough(
    decodeRedisString(
      await sysRedis.hGet(REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT, String(userId))
    )
  );
  const closed =
    stored && new Date(stored.through) <= through
      ? stored
      : { through: BANKABLE_CUTOVER.toISOString(), spent: 0 };
  const closedThrough = new Date(closed.through);

  const spentIn = async (window: { from: Date; to?: Date }) => {
    const [row] = await ch.$query<{ spent: number }>(paidToUsersSql(userId, window));
    return Number(row?.spent ?? 0);
  };
  const [added, live] = await Promise.all([
    closedThrough < through ? spentIn({ from: closedThrough, to: through }) : 0,
    spentIn({ from: through }),
  ]);

  if (
    closedThrough < through &&
    (await hasIngestSettled(now, new Date(through.getTime() + SPENT_SETTLE_MS)))
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
  // What the creator paid other users comes out of what they earned, then out of the snapshot.
  // Both are totals since the cutover, so later earnings make up the snapshot first.
  const remaining = Math.max(
    0,
    ledger.snapshot +
      ledger.earned -
      // A ledger cached before `spent` existed has none.
      (ledger.spent ?? 0) -
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

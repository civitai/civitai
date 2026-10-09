import { clickhouse } from '~/server/clickhouse/client';
import { escapeClickhouseString } from '~/server/clickhouse/escape';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  APP_AUTHOR_FEE_DESCRIPTION,
  buzzBankTypesSql,
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

export type BankableLedger = {
  /** Yellow + green balance at the cutover. */
  snapshot: number;
  /** Bankable earnings since the cutover. */
  earned: number;
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
async function hasIngestSettled(now: Date) {
  if (now < SNAPSHOT_SETTLED_AT || !clickhouse) return false;
  const rows = await clickhouse.$query<{ settled: number }>`
    SELECT 1 AS settled FROM buzzTransactions WHERE date >= ${SNAPSHOT_SETTLED_AT} LIMIT 1
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
  const [snapshot, [sums]] = await Promise.all([
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
  ]);

  return { snapshot, earned: Number(sums?.earned ?? 0), consumed: Number(sums?.consumed ?? 0) };
}

/**
 * `bankedThisMonth` comes from the Buzz service rather than ClickHouse so a deposit made seconds
 * ago is already counted; closed months are read from ClickHouse, which has caught up by then.
 */
export function withBankedThisMonth(
  ledger: BankableLedger,
  bankedThisMonth: number
): BankableAmount {
  const remaining = Math.max(
    0,
    ledger.snapshot + ledger.earned - ledger.consumed - bankedThisMonth
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

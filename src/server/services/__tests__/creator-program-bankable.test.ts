import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { buzzBankTypesSql } from '~/shared/constants/buzz.constants';
import { BANKABLE_CUTOVER } from '~/shared/constants/creator-program.constants';
import { GENERATION_TIP_TRANSACTION_START } from '~/server/jobs/deliver-creator-compensation';
import { PLACEMENT_LEDGER_TEXT } from '~/shared/utils/placement';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockClickhouse } = vi.hoisted(() => ({
  mockClickhouse: { $query: vi.fn() },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockClickhouse }));

import {
  BANKABLE_EARNING_PREDICATE_SQL,
  generationTipsPaidSql,
  getBankableAmount,
  paidToUsersSql,
  PEAK_EARNING_PREDICATE_SQL,
  PRE_CUTOVER_PEAK_EARNING_PREDICATE_SQL,
  RECEIVED_FROM_USER_SQL,
  receivedFromUsersSql,
  SENT_TO_USER_SQL,
  SERVICE_RELEASE_SQL,
} from '~/server/services/creator-program-bankable';

const userId = 42;
const sysRedis = redisMock.sysRedis;
const afterSettle = new Date('2026-12-15T12:00:00Z');

function sqlOf(callIndex: number) {
  const [parts, ...values] = mockClickhouse.$query.mock.calls[callIndex] as [
    string[] | string,
    ...any[]
  ];
  if (typeof parts === 'string') return parts;
  return parts.reduce(
    (acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''),
    ''
  );
}

/** ClickHouse returns UInt64 sums as strings, so the fixtures do too. */
function mockLedger({
  snapshot,
  earned,
  spent = 0,
  spentToday = 0,
  consumed,
  ingestSettled = true,
}: {
  snapshot?: number;
  earned: number;
  /** Paid to other users before the start of today, then since. */
  spent?: number;
  spentToday?: number;
  consumed: number;
  ingestSettled?: boolean;
}) {
  mockClickhouse.$query.mockImplementation(async (parts: string[] | string) => {
    const sql = typeof parts === 'string' ? parts : parts.join('');
    if (sql.includes('AS balance')) return [{ balance: String(snapshot ?? 0) }];
    if (sql.includes('AS settled')) return ingestSettled ? [{ settled: 1 }] : [];
    if (sql.includes('AS consumed'))
      return [{ earned: String(earned), consumed: String(consumed) }];
    if (sql.includes('AS spent'))
      return [{ spent: String(sql.includes('AND date < ') ? spent : spentToday) }];
    throw new Error(`unexpected query: ${sql}`);
  });
}

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function issuedSqls(marker: string) {
  return mockClickhouse.$query.mock.calls
    .map((_, i) => squash(sqlOf(i)))
    .filter((s) => s.includes(marker));
}

function issuedSql(marker: string) {
  const sql = mockClickhouse.$query.mock.calls
    .map((_, i) => sqlOf(i))
    .find((s) => s.includes(marker));
  if (!sql) throw new Error(`no query containing ${marker} was issued`);
  return squash(sql);
}

beforeEach(() => {
  vi.clearAllMocks();
  sysRedis.hGet.mockResolvedValue(null);
});
afterEach(() => {
  mockClickhouse.$query.mockReset();
});

describe('BANKABLE_CUTOVER', () => {
  it('is the start of a UTC month', () => {
    const d = BANKABLE_CUTOVER;
    expect([
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ]).toEqual([1, 0, 0, 0, 0]);
  });
});

describe('getBankableAmount', () => {
  it('returns null before the cutover without querying the ledger', async () => {
    const before = new Date(BANKABLE_CUTOVER.getTime() - 1);

    expect(await getBankableAmount(userId, 0, before)).toBeNull();
    expect(mockClickhouse.$query).not.toHaveBeenCalled();
  });

  it('is snapshot + earned - consumed - banked this month', async () => {
    mockLedger({ snapshot: 100_000, earned: 50_000, consumed: 30_000 });

    const result = await getBankableAmount(userId, 20_000, afterSettle);

    expect(result).toEqual({
      snapshot: 100_000,
      earned: 50_000,
      spent: 0,
      consumed: 30_000,
      remaining: 100_000,
    });
  });

  it('subtracts what the creator paid other users from what they earned', async () => {
    mockLedger({ snapshot: 0, earned: 10_000, spent: 3_000, consumed: 0 });

    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(7_000);
  });

  // Justin, 2026-10-23: Buzz paid to other users beyond what was earned since the cutover also
  // comes out of the cutover snapshot. If you are about to shield the snapshot from it, that is a
  // product decision to take back to him, not a cleanup.
  it('takes what the creator paid other users beyond their earnings out of the cutover snapshot', async () => {
    mockLedger({ snapshot: 100_000, earned: 0, spent: 100_000, consumed: 0 });
    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(0);

    mockLedger({ snapshot: 100_000, earned: 20_000, spent: 50_000, consumed: 0 });
    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(70_000);
  });

  it('leaves the cutover snapshot whole while earnings cover what was paid', async () => {
    mockLedger({ snapshot: 100_000, earned: 30_000, spent: 20_000, consumed: 0 });

    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(110_000);
  });

  // Both are totals since the cutover, so a month of paying out more than was earned is made up
  // from later earnings first.
  it('carries paying out more than was earned against later earnings', async () => {
    mockLedger({ snapshot: 0, earned: 10_000, spent: 13_000, consumed: 0 });
    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(0);

    mockLedger({ snapshot: 0, earned: 15_000, spent: 13_000, consumed: 0 });
    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(2_000);
  });

  // The counterparty review files Buzz that returns to a creator but moves no money: this netting
  // is what keeps it out of bankable.
  it('gains nothing from Buzz paid out that comes back as earnings', async () => {
    mockLedger({ snapshot: 50_000, earned: 25_000, spent: 25_000, consumed: 0 });
    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(50_000);

    mockLedger({ snapshot: 0, earned: 25_000, spent: 25_000, consumed: 0 });
    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(0);
  });

  it('never reports a negative remaining amount', async () => {
    mockLedger({ snapshot: 10_000, earned: 0, consumed: 0 });

    const result = await getBankableAmount(userId, 25_000, afterSettle);

    expect(result?.remaining).toBe(0);
  });

  it('recomputes a stored snapshot that is not a number', async () => {
    sysRedis.hGet.mockResolvedValue('garbage');
    mockLedger({ snapshot: 50_000, earned: 0, consumed: 0 });

    const result = await getBankableAmount(userId, 0, afterSettle);

    expect(result?.snapshot).toBe(50_000);
    expect(result?.remaining).toBe(50_000);
    expect(sysRedis.hSet).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SNAPSHOT,
      String(userId),
      '50000'
    );
  });

  it('uses a stored snapshot instead of recomputing it', async () => {
    sysRedis.hGet.mockResolvedValue('70000');
    mockLedger({ snapshot: 999_999, earned: 0, consumed: 0 });

    const result = await getBankableAmount(userId, 0, afterSettle);

    expect(result?.snapshot).toBe(70_000);
    expect(sysRedis.hGet).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SNAPSHOT,
      String(userId)
    );
    expect(mockClickhouse.$query.mock.calls.map((_, i) => sqlOf(i))).not.toContainEqual(
      expect.stringContaining('AS balance')
    );
  });

  it('stores a computed snapshot once the ledger has settled', async () => {
    mockLedger({ snapshot: 123_456, earned: 0, consumed: 0 });

    await getBankableAmount(userId, 0, afterSettle);

    expect(sysRedis.hSet).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SNAPSHOT,
      String(userId),
      '123456'
    );
  });

  it('does not store a snapshot taken in the first hour after the cutover', async () => {
    mockLedger({ snapshot: 123_456, earned: 0, consumed: 0 });
    const justAfter = new Date(BANKABLE_CUTOVER.getTime() + 5 * 60 * 1000);

    const result = await getBankableAmount(userId, 0, justAfter);

    expect(result?.snapshot).toBe(123_456);
    expect(sysRedis.hSet).not.toHaveBeenCalled();
  });

  it('clamps a negative cutover balance to 0, and stores the 0', async () => {
    mockLedger({ snapshot: -5_000, earned: 2_000, consumed: 0 });

    const result = await getBankableAmount(userId, 0, afterSettle);

    expect(result).toEqual({
      snapshot: 0,
      earned: 2_000,
      spent: 0,
      consumed: 0,
      remaining: 2_000,
    });
    expect(sysRedis.hSet).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SNAPSHOT,
      String(userId),
      '0'
    );
  });

  it('does not store a snapshot while ingest has not reached the settle point', async () => {
    mockLedger({ snapshot: 123_456, earned: 0, consumed: 0, ingestSettled: false });

    const result = await getBankableAmount(userId, 0, afterSettle);

    expect(result?.snapshot).toBe(123_456);
    expect(sysRedis.hSet).not.toHaveBeenCalled();
  });

  it('checks ingest for a row dated at least an hour past the cutover and not in the future', async () => {
    mockLedger({ snapshot: 0, earned: 0, consumed: 0 });

    await getBankableAmount(userId, 0, afterSettle);

    const settledAt = new Date(BANKABLE_CUTOVER.getTime() + 60 * 60 * 1000);
    expect(issuedSql('AS settled')).toBe(
      `SELECT 1 AS settled FROM buzzTransactions WHERE date >= ${String(
        settledAt
      )} AND date <= ${String(afterSettle)} LIMIT 1`
    );
  });

  // Pinned whole: a wrong term still returns a plausible number.
  // One row per transaction: the balance is stored for good.
  it('computes the cutover balance as Buzz in minus Buzz out before the cutover, each row once', async () => {
    mockLedger({ snapshot: 0, earned: 0, consumed: 0 });

    await getBankableAmount(userId, 0, afterSettle);

    const cutover = String(BANKABLE_CUTOVER);
    expect(issuedSql('AS balance')).toBe(
      squash(`SELECT
        ( SELECT sum(amount) FROM ( SELECT amount FROM buzzTransactions
          WHERE toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql})
            AND date < ${cutover}
          LIMIT 1 BY date, fromAccountId, toAccountId, transactionId ) )
        - ( SELECT sum(amount) FROM ( SELECT amount FROM buzzTransactions
          WHERE fromAccountId = ${userId} AND fromAccountType IN (${buzzBankTypesSql})
            AND date < ${cutover}
          LIMIT 1 BY date, fromAccountId, toAccountId, transactionId ) ) AS balance`)
    );
  });

  it('computes earned and consumed from the right accounts and dates', async () => {
    mockLedger({ snapshot: 0, earned: 0, consumed: 0 });

    await getBankableAmount(userId, 0, afterSettle);

    const cutover = String(BANKABLE_CUTOVER);
    const monthStart = String(new Date('2026-12-01T00:00:00Z'));
    expect(issuedSql('AS consumed')).toBe(
      squash(`SELECT
        ( SELECT sum(amount) FROM buzzTransactions
          WHERE toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql})
            AND date >= ${cutover}
            AND ${BANKABLE_EARNING_PREDICATE_SQL} ) AS earned,
        ( SELECT sumIf(amount, type = 'bank')
            + sumIf(amount, type = 'fee' AND description = 'Extraction fee')
          FROM buzzTransactions
          WHERE fromAccountId = ${userId} AND fromAccountType IN (${buzzBankTypesSql})
            AND date >= ${cutover} AND date < ${monthStart} )
        - ( SELECT sum(amount) FROM buzzTransactions
          WHERE toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql})
            AND type = 'extract'
            AND date >= ${cutover} AND date < ${monthStart} ) AS consumed`)
    );
  });

  it('reads only the days after the stored total of what was paid, then stores the new total', async () => {
    sysRedis.hGet.mockImplementation(async (key: string) =>
      key === REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT
        ? JSON.stringify({ through: '2026-12-10T00:00:00.000Z', spent: 500, v: 2 })
        : '0'
    );
    mockLedger({ earned: 10_000, spent: 300, spentToday: 200, consumed: 0 });

    expect((await getBankableAmount(userId, 0, afterSettle))?.spent).toBe(1_000);
    expect(issuedSql("AND date < toDateTime('2026-12-14 00:00:00', 'UTC')")).toContain(
      "date >= toDateTime('2026-12-10 00:00:00', 'UTC')"
    );
    const spentReads = mockClickhouse.$query.mock.calls
      .map((_, i) => squash(sqlOf(i)))
      .filter((sql) => sql.includes('AS spent'));
    // The live read starts where the stored total ends, so no day is counted twice.
    expect(spentReads.filter((sql) => !sql.includes('AND date < '))).toEqual([
      expect.stringContaining("date >= toDateTime('2026-12-14 00:00:00', 'UTC')"),
    ]);
    // Stored only once ingest holds a row a full day past the stored total.
    expect(issuedSqls('AS settled')).toContain(
      `SELECT 1 AS settled FROM buzzTransactions WHERE date >= ${String(
        new Date('2026-12-15T00:00:00Z')
      )} AND date <= ${String(afterSettle)} LIMIT 1`
    );
    expect(sysRedis.hSet).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT,
      String(userId),
      JSON.stringify({ through: '2026-12-14T00:00:00.000Z', spent: 800, v: 2 })
    );
  });

  // A total stored before generation tips were netted lacks them for good; reading it would leave
  // every tip paid before it un-netted.
  it('rescans from the cutover when the stored total of what was paid predates generation-tip netting', async () => {
    sysRedis.hGet.mockImplementation(async (key: string) =>
      key === REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT
        ? JSON.stringify({ through: '2026-12-10T00:00:00.000Z', spent: 500 })
        : '0'
    );
    mockLedger({ earned: 10_000, spent: 300, spentToday: 200, consumed: 0 });

    expect((await getBankableAmount(userId, 0, afterSettle))?.spent).toBe(500);
    expect(issuedSql("AND date < toDateTime('2026-12-14 00:00:00', 'UTC')")).toContain(
      "date >= toDateTime('2026-11-01 00:00:00', 'UTC')"
    );
    expect(sysRedis.hSet).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT,
      String(userId),
      JSON.stringify({ through: '2026-12-14T00:00:00.000Z', spent: 300, v: 2 })
    );
  });

  it('takes generation tips the creator paid out of what remains bankable', async () => {
    mockClickhouse.$query.mockImplementation(async (parts: string[] | string) => {
      const sql = typeof parts === 'string' ? parts : parts.join('');
      if (sql.includes('AS balance')) return [{ balance: '0' }];
      if (sql.includes('AS settled')) return [{ settled: 1 }];
      if (sql.includes('AS consumed')) return [{ earned: '10000', consumed: '0' }];
      if (sql.includes('AS spent'))
        return [{ spent: sql.includes('FROM orchestration.jobs') ? '1500' : '0' }];
      throw new Error(`unexpected query: ${sql}`);
    });

    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(7_000);
  });

  it('does not store the total of what was paid while ingest has not reached it', async () => {
    mockLedger({ earned: 10_000, spent: 300, consumed: 0, ingestSettled: false });

    expect((await getBankableAmount(userId, 0, afterSettle))?.spent).toBe(300);
    expect(sysRedis.hSet).not.toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT,
      expect.anything(),
      expect.anything()
    );
  });

  it('reads closed months only for what was consumed, leaving this month to the bank account', async () => {
    mockLedger({ snapshot: 0, earned: 0, consumed: 0 });

    await getBankableAmount(userId, 0, afterSettle);

    const sql = mockClickhouse.$query.mock.calls
      .map((_, i) => sqlOf(i))
      .find((s) => s.includes('AS consumed'));
    expect(sql).toBeDefined();
    const monthStart = String(new Date('2026-12-01T00:00:00Z'));
    expect(sql!.split(`date < ${monthStart}`)).toHaveLength(3);
  });
});

describe('BANKABLE_EARNING_PREDICATE_SQL', () => {
  it('is exactly the bankable earning sources', () => {
    const placementLegs = Object.values(PLACEMENT_LEDGER_TEXT)
      .flatMap((t) => [t.toOwner, t.feeToOwner, t.toSeller])
      .map((d) => `'${d}'`)
      .join(', ');
    expect(BANKABLE_EARNING_PREDICATE_SQL).toBe(`(
  type IN ('licenseFee', 'donation', 'sell', 'bounty')
  OR (type IN ('purchase', 'tip') AND fromAccountId != 0)
  OR (type = 'compensation' AND fromAccountId = 0 AND startsWith(externalTransactionId, 'generation-tip-'))
  OR (type = 'fee' AND description IN (${placementLegs}))
  OR (type IN ('fee', 'unknown_28', 'appAuthorFee') AND description LIKE 'App author fee%')
  OR ${SERVICE_RELEASE_SQL}
)`);
  });

  // Justin, 2026-10-09: generation tips are real money the generating user pays on top of the
  // price, so Yellow and Green tips are bankable. Blue tips stay out through the bankable-account
  // filter on the earned query, not through this predicate.
  it('leaves generation compensation out, except the generation-tip transactions', () => {
    const compensationClauses = BANKABLE_EARNING_PREDICATE_SQL.split('\n').filter((line) =>
      line.includes('compensation')
    );
    expect(compensationClauses).toEqual([
      "  OR (type = 'compensation' AND fromAccountId = 0 AND startsWith(externalTransactionId, 'generation-tip-'))",
    ]);
  });

  // The generation-tip clause matches Blue tips too; only the bankable-account filter keeps them out.
  // Making Blue bankable would make every Blue generation tip bankable with it.
  it('keeps Blue out of the bankable accounts the earned query filters on', () => {
    expect(buzzBankTypesSql).toBe("'green', 'yellow'");
  });

  // Tips paid before their own transaction existed sit inside compensation and cannot be counted
  // here. That is only safe while every such date falls before the cutover, inside the snapshot.
  // If the cutover moves earlier than the tip split, those tips silently become unbankable.
  it('starts separate tip transactions no later than the bankable cutover', () => {
    expect(GENERATION_TIP_TRANSACTION_START.getTime()).toBeLessThanOrEqual(
      BANKABLE_CUTOVER.getTime()
    );
  });

  it('counts licence fees, donations, shop sales and bounties from anyone', () => {
    expect(BANKABLE_EARNING_PREDICATE_SQL).toMatch(
      /^\(\s*type IN \('licenseFee', 'donation', 'sell', 'bounty'\)\n/
    );
  });

  it('counts app author fees under both ledger types they have been stored as', () => {
    expect(BANKABLE_EARNING_PREDICATE_SQL).toMatch(
      /\n\s*OR \(type IN \('fee', 'unknown_28', 'appAuthorFee'\) AND description LIKE 'App author fee%'\)\n/
    );
  });

  it('counts paid access and tips only when a user paid them', () => {
    expect(BANKABLE_EARNING_PREDICATE_SQL).toMatch(
      /\n\s*OR \(type IN \('purchase', 'tip'\) AND fromAccountId != 0\)\n/
    );
  });

  it('counts the placement legs paid to creators and nothing else of type fee', () => {
    const feeClause = BANKABLE_EARNING_PREDICATE_SQL.match(
      /OR \(type = 'fee' AND description IN \((.*)\)\)\n/
    )?.[1];
    const expected = Object.values(PLACEMENT_LEDGER_TEXT)
      .flatMap((t) => [t.toOwner, t.feeToOwner, t.toSeller])
      .map((d) => `'${d}'`)
      .join(', ');
    expect(feeClause).toBe(expected);
  });
});

// Justin, 2026-10-24: released Creator Services earnings are bankable. Holds and refunds share the
// type and move the buyer's own Buzz, so counting them would make a refunded deal bankable.
describe('SERVICE_RELEASE_SQL', () => {
  it('counts only the escrow release leg, under every spelling of its type, with its buyer', () => {
    expect(SERVICE_RELEASE_SQL).toBe(
      "(type IN ('serviceEscrow','29','unknown_29') AND fromAccountId = 0" +
        " AND startsWith(externalTransactionId, 'creator-service-')" +
        " AND endsWith(externalTransactionId, '-release')" +
        " AND JSONExtractInt(details, 'buyerId') > 0)"
    );
  });
});

const closedWindow = { from: BANKABLE_CUTOVER, to: new Date('2026-12-01T00:00:00Z') };

describe('paidToUsersSql', () => {
  // Pinned whole: a wrong account column still returns a plausible number.
  // One row per transaction on a closed window: its total is stored for good, so a duplicate row not
  // yet merged away would stay in it. FINAL measured a minute on a heavy creator.
  it('counts payments from the creator, sales and services they bought and their part of bounties they funded, each row once', () => {
    const paidTo = `toAccountId > 0 AND toAccountId != 42 AND toAccountType IN (${buzzBankTypesSql}) AND date >= toDateTime('2026-11-01 00:00:00', 'UTC') AND date < toDateTime('2026-12-01 00:00:00', 'UTC')`;
    expect(
      squash(paidToUsersSql(42, { from: BANKABLE_CUTOVER, to: new Date('2026-12-01T00:00:00Z') }))
    ).toBe(
      squash(`SELECT sum(amount) AS spent FROM (
        SELECT toInt64(amount) AS amount FROM buzzTransactions
        WHERE fromAccountId = 42 AND ${paidTo}
          AND ${BANKABLE_EARNING_PREDICATE_SQL} AND ${RECEIVED_FROM_USER_SQL}
        LIMIT 1 BY date, fromAccountId, toAccountId, transactionId
        UNION ALL
        SELECT toInt64(amount) AS amount FROM buzzTransactions
        WHERE (type = 'sell' AND fromAccountId = 0 AND JSONExtractInt(details, 'purchasedBy') > 0) AND ${paidTo}
          AND JSONExtractInt(details, 'purchasedBy') = 42
        LIMIT 1 BY date, fromAccountId, toAccountId, transactionId
        UNION ALL
        SELECT toInt64(amount) AS amount FROM buzzTransactions
        WHERE ${SERVICE_RELEASE_SQL} AND ${paidTo}
          AND JSONExtractInt(details, 'buyerId') = 42
          AND JSONExtractInt(details, 'heldAt') >= 1793491200
        LIMIT 1 BY date, fromAccountId, toAccountId, transactionId
        UNION ALL
        SELECT intDiv(amount * arraySum(arrayMap((id, a, t) -> if(id = 42 AND t >= 1793491200, a, 0), ids, amts, ats)), arraySum(amts)) AS amount
        FROM ( SELECT toInt64(toAccountId) AS recipient, toInt64(amount) AS amount,
            JSONExtract(details, 'supporterIds', 'Array(Int64)') AS ids,
            JSONExtract(details, 'supporterAmounts', 'Array(Int64)') AS amts,
            JSONExtract(details, 'supporterChargedAt', 'Array(Int64)') AS ats
          FROM buzzTransactions
          WHERE ${paidTo} AND (type = 'bounty' AND fromAccountId = 0 AND JSONExtractString(details, 'entityType') = 'Bounty')
            AND length(ids) = length(amts) AND length(ids) = length(ats) AND arraySum(amts) > 0
          LIMIT 1 BY date, fromAccountId, toAccountId, transactionId )
        WHERE has(ids, 42)
        UNION ALL
        SELECT amount FROM (${generationTipsPaidSql(42, closedWindow)}) )`)
    );
  });

  it('reads the live window as it is', () => {
    expect(paidToUsersSql(42, { from: BANKABLE_CUTOVER })).not.toContain('LIMIT 1 BY date');
  });
});

describe('generationTipsPaidSql', () => {
  // Pinned whole: the currency gate is what keeps Blue and unknown-currency tips from lowering
  // bankable, and a wrong one still returns a plausible number.
  it('nets per-job creator tips, less workflow refunds, only on days whose generation charges were all Yellow', () => {
    const near =
      'arrayDistinct([toDate(date - INTERVAL 1 HOUR), toDate(date), toDate(date + INTERVAL 1 HOUR)])';
    const ledgerWindow = `date >= toDateTime('2026-11-01 00:00:00', 'UTC') - INTERVAL 1 HOUR AND date < toDateTime('2026-12-01 00:00:00', 'UTC') + INTERVAL 1 HOUR`;
    expect(squash(generationTipsPaidSql(42, closedWindow))).toBe(
      squash(`SELECT toInt64(floor(greatest(0, tips - refunded))) AS amount
      FROM (
        SELECT toDate(createdAt) AS day, sum(creatorsTip) AS tips
        FROM (
          SELECT jobId, createdAt, creatorsTip FROM orchestration.jobs
          WHERE userId = 42
            AND createdAt >= toDateTime('2026-11-01 00:00:00', 'UTC') AND createdAt < toDateTime('2026-12-01 00:00:00', 'UTC') AND createdAt <= now()
            AND creatorsTip > 0 AND creatorsTip < 1000000
          LIMIT 1 BY jobId
        )
        GROUP BY day
      ) AS tipped
      INNER JOIN (
        SELECT day, sum(refundedAmount) AS refunded FROM (
          SELECT arrayJoin(${near}) AS day, 1 AS isCharge, fromAccountType = 'yellow' AS yellow, toInt64(0) AS refundedAmount
          FROM buzzTransactions
          WHERE type = 'generation' AND fromAccountId = 42
            AND ${ledgerWindow}
          UNION ALL
          SELECT arrayJoin(${near}) AS day, 0 AS isCharge, 1 AS yellow, toInt64(amount) AS refundedAmount
          FROM buzzTransactions
          WHERE type = 'refund' AND toAccountId = 42
            AND JSONExtractString(details, 'workflowId') != ''
            AND ${ledgerWindow}
        )
        GROUP BY day
        HAVING max(isCharge) = 1 AND min(yellow) = 1
      ) AS yellowOnly USING (day)`)
    );
  });

  // orchestration.jobs holds corrupt rows dated 2299 with garbage tips; an open window catches them.
  it('bounds the live window at now', () => {
    expect(generationTipsPaidSql(42, { from: BANKABLE_CUTOVER })).toMatch(
      /createdAt >= toDateTime\('2026-11-01 00:00:00', 'UTC'\) AND createdAt <= now\(\)/
    );
  });

  // Jobs late on a day are charged early the next: the gate reads the charges an hour past it.
  it('reads charges an hour either side of the days whose jobs it nets, from a mid-day window too', () => {
    const sql = squash(
      generationTipsPaidSql(42, {
        from: new Date('2026-11-03T12:00:00Z'),
        to: new Date('2026-11-05T06:00:00Z'),
      })
    );
    expect(sql).toContain(
      "date >= toDateTime('2026-11-03 00:00:00', 'UTC') - INTERVAL 1 HOUR AND date < toDateTime('2026-11-06 00:00:00', 'UTC') + INTERVAL 1 HOUR"
    );
  });
});

describe('receivedFromUsersSql', () => {
  // Pinned whole: a wrong payer column or split still returns plausible pairs.
  it('attributes user payments, platform-paid sales and service releases to their buyer and bounty awards to their supporters', () => {
    expect(squash(receivedFromUsersSql('toAccountId = 1'))).toBe(
      squash(`SELECT recipient, payer, sum(amount) AS amount FROM (
        SELECT toInt64(toAccountId) AS recipient, toInt64(fromAccountId) AS payer,
          toInt64(amount) AS amount
        FROM buzzTransactions
        WHERE toAccountId = 1 AND ${BANKABLE_EARNING_PREDICATE_SQL} AND ${RECEIVED_FROM_USER_SQL}
        UNION ALL
        SELECT toInt64(toAccountId) AS recipient, toInt64(JSONExtractInt(details, 'purchasedBy')) AS payer,
          toInt64(amount) AS amount
        FROM buzzTransactions
        WHERE toAccountId = 1 AND (type = 'sell' AND fromAccountId = 0 AND JSONExtractInt(details, 'purchasedBy') > 0)
        UNION ALL
        SELECT toInt64(toAccountId) AS recipient, toInt64(JSONExtractInt(details, 'buyerId')) AS payer,
          toInt64(amount) AS amount
        FROM buzzTransactions
        WHERE toAccountId = 1 AND ${SERVICE_RELEASE_SQL}
        UNION ALL
        SELECT recipient, s.1 AS payer, intDiv(amount * s.2, arraySum(amts)) AS amount
        FROM ( SELECT toInt64(toAccountId) AS recipient, toInt64(amount) AS amount,
            JSONExtract(details, 'supporterIds', 'Array(Int64)') AS ids,
            JSONExtract(details, 'supporterAmounts', 'Array(Int64)') AS amts,
            JSONExtract(details, 'supporterChargedAt', 'Array(Int64)') AS ats
          FROM buzzTransactions
          WHERE toAccountId = 1 AND (type = 'bounty' AND fromAccountId = 0 AND JSONExtractString(details, 'entityType') = 'Bounty')
            AND length(ids) = length(amts) AND length(ids) = length(ats) AND arraySum(amts) > 0 ) ARRAY JOIN arrayZip(ids, amts) AS s
      ) GROUP BY recipient, payer`)
    );
  });
});

describe('counterparty netting clauses', () => {
  // A bank or system account is not a user who can be paid back, and bank account ids are month
  // numbers that collide with user ids, so the account types are what make the pairing sound.
  it('pairs only user Buzz accounts on both legs, Blue included', () => {
    const userTypes = "'blue', 'green', 'yellow', 'red'";
    expect(RECEIVED_FROM_USER_SQL).toBe(
      `(fromAccountId > 0 AND fromAccountType IN (${userTypes}))`
    );
    expect(SENT_TO_USER_SQL).toBe(
      `(fromAccountType IN (${userTypes}) AND toAccountId > 0 AND toAccountType IN (${userTypes}))`
    );
  });
});

describe('peak-earning predicates', () => {
  // Justin, 2026-10-27 (reverses 2026-10-09): tips received, direct and generation, set the peak.
  it('counts licence fees, user-paid early access and tips from the cutover', () => {
    expect(PEAK_EARNING_PREDICATE_SQL).toBe(`(
  type = 'licenseFee'
  OR (type = 'purchase' AND fromAccountId != 0)
  OR (type = 'tip' AND fromAccountId != 0 AND fromAccountId != toAccountId)
  OR (type = 'compensation' AND fromAccountId = 0 AND startsWith(externalTransactionId, 'generation-tip-'))
)`);
  });

  // Hand grants are made as tips from account 0; they are support credits, not earnings.
  it('counts direct tips only when a user other than the creator paid them', () => {
    const tipClauses = PEAK_EARNING_PREDICATE_SQL.split('\n').filter((l) => l.includes("'tip'"));
    expect(tipClauses).toEqual([
      "  OR (type = 'tip' AND fromAccountId != 0 AND fromAccountId != toAccountId)",
    ]);
  });

  // Generation compensation stopped setting the peak at the cutover; only its tip rows still do.
  it('leaves generation compensation out, except the generation-tip transactions', () => {
    const compensationClauses = PEAK_EARNING_PREDICATE_SQL.split('\n').filter((l) =>
      l.includes('compensation')
    );
    expect(compensationClauses).toEqual(
      BANKABLE_EARNING_PREDICATE_SQL.split('\n').filter((l) => l.includes('compensation'))
    );
  });

  it('also counts generation compensation before the cutover', () => {
    expect(PRE_CUTOVER_PEAK_EARNING_PREDICATE_SQL).toBe(`(
  type IN ('compensation', 'licenseFee')
  OR (type = 'purchase' AND fromAccountId != 0)
)`);
  });
});

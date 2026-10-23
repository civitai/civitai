import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { buzzBankTypesSql } from '~/shared/constants/buzz.constants';
import { BANKABLE_CUTOVER } from '~/shared/constants/creator-program.constants';
import { GENERATION_TIP_TRANSACTION_START } from '~/server/jobs/deliver-creator-compensation';
import { PLACEMENT_LEDGER_TEXT } from '~/shared/utils/placement';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockClickhouse, mockDbRead } = vi.hoisted(() => ({
  mockClickhouse: { $query: vi.fn() },
  mockDbRead: { $queryRaw: vi.fn() },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockClickhouse }));
vi.mock('~/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dbRead: mockDbRead,
}));

import {
  BANKABLE_EARNING_PREDICATE_SQL,
  getBankableAmount,
  getBountyFunders,
  PEAK_EARNING_PREDICATE_SQL,
  PRE_CUTOVER_PEAK_EARNING_PREDICATE_SQL,
  RECEIVED_FROM_USER_SQL,
  receivedFromUsersSql,
  SENT_TO_USER_SQL,
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

/**
 * ClickHouse returns UInt64 sums as strings, so the fixtures do too. `returned` answers the netting
 * read; `returnedWithBounties` answers it once bounty supporters are part of it.
 */
function mockLedger({
  snapshot,
  earned,
  returned = 0,
  returnedWithBounties = returned,
  awardedBounties = [],
  consumed,
  ingestSettled = true,
}: {
  snapshot?: number;
  earned: number;
  returned?: number;
  returnedWithBounties?: number;
  awardedBounties?: number[];
  consumed: number;
  ingestSettled?: boolean;
}) {
  mockClickhouse.$query.mockImplementation(async (parts: string[] | string) => {
    const sql = typeof parts === 'string' ? parts : parts.join('');
    if (sql.includes('AS balance')) return [{ balance: String(snapshot ?? 0) }];
    if (sql.includes('AS settled')) return ingestSettled ? [{ settled: 1 }] : [];
    if (sql.includes('AS consumed'))
      return [{ earned: String(earned), consumed: String(consumed) }];
    if (sql.includes('AS returned'))
      return [{ returned: String(sql.includes('values(') ? returnedWithBounties : returned) }];
    if (sql.includes('AS bountyId')) return awardedBounties.map((bountyId) => ({ bountyId }));
    throw new Error(`unexpected query: ${sql}`);
  });
}

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

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
      consumed: 30_000,
      remaining: 100_000,
    });
  });

  // Both arms on one fixture: the same 100k round trip counts in full when nothing went back, and
  // counts nothing once the creator sent the same user 100k.
  it('counts Buzz from a user only beyond what the creator sent that user', async () => {
    mockLedger({ snapshot: 0, earned: 100_000, returned: 0, consumed: 0 });
    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(100_000);

    mockLedger({ snapshot: 0, earned: 100_000, returned: 100_000, consumed: 0 });
    expect(await getBankableAmount(userId, 0, afterSettle)).toEqual({
      snapshot: 0,
      earned: 0,
      consumed: 0,
      remaining: 0,
    });
  });

  it('keeps the part of a payment that was not sent back', async () => {
    mockLedger({ snapshot: 10_000, earned: 100_000, returned: 30_000, consumed: 0 });

    const result = await getBankableAmount(userId, 0, afterSettle);

    expect(result).toEqual({ snapshot: 10_000, earned: 70_000, consumed: 0, remaining: 80_000 });
  });

  // Sending Buzz back after banking it leaves a shortfall that later earnings fill first.
  it('carries Buzz sent back after banking as a shortfall against later earnings', async () => {
    mockLedger({ snapshot: 0, earned: 150_000, returned: 100_000, consumed: 100_000 });

    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(0);

    mockLedger({ snapshot: 0, earned: 230_000, returned: 100_000, consumed: 100_000 });

    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(30_000);
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

    expect(result).toEqual({ snapshot: 0, earned: 2_000, consumed: 0, remaining: 2_000 });
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

  it('checks ingest for a row dated at least an hour past the cutover', async () => {
    mockLedger({ snapshot: 0, earned: 0, consumed: 0 });

    await getBankableAmount(userId, 0, afterSettle);

    const settledAt = new Date(BANKABLE_CUTOVER.getTime() + 60 * 60 * 1000);
    expect(issuedSql('AS settled')).toBe(
      `SELECT 1 AS settled FROM buzzTransactions WHERE date >= ${String(settledAt)} LIMIT 1`
    );
  });

  // Pinned whole: a wrong term still returns a plausible number.
  it('computes the cutover balance as Buzz in minus Buzz out before the cutover', async () => {
    mockLedger({ snapshot: 0, earned: 0, consumed: 0 });

    await getBankableAmount(userId, 0, afterSettle);

    const cutover = String(BANKABLE_CUTOVER);
    expect(issuedSql('AS balance')).toBe(
      squash(`SELECT
        ( SELECT sum(amount) FROM buzzTransactions
          WHERE toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql})
            AND date < ${cutover} )
        - ( SELECT sum(amount) FROM buzzTransactions
          WHERE fromAccountId = ${userId} AND fromAccountType IN (${buzzBankTypesSql})
            AND date < ${cutover} ) AS balance`)
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

  // Pinned whole: a wrong join key still returns a plausible number.
  it('nets what each user paid against what the creator sent that user', async () => {
    mockLedger({ snapshot: 0, earned: 0, consumed: 0 });

    await getBankableAmount(userId, 0, afterSettle);

    const since = `toAccountId = ${userId} AND toAccountType IN (${buzzBankTypesSql}) AND date >= '2026-11-01 00:00:00'`;
    expect(issuedSql('AS returned')).toBe(
      squash(`SELECT sum(least(received.amount, sent.amount)) AS returned FROM (
          ${receivedFromUsersSql(since, [])}
        ) AS received
        INNER JOIN (
          SELECT toInt64(toAccountId) AS counterparty, toInt64(sum(amount)) AS amount
          FROM buzzTransactions
          WHERE fromAccountId = ${userId} AND ${SENT_TO_USER_SQL}
            AND date >= '2026-11-01 00:00:00'
          GROUP BY counterparty
        ) AS sent ON sent.counterparty = received.payer`)
    );
  });

  it('nets a bounty award against the supporters who funded it', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ bountyId: 7, userId: 99, unitAmount: 100_000 }]);
    mockLedger({
      snapshot: 0,
      earned: 100_000,
      returned: 0,
      returnedWithBounties: 100_000,
      awardedBounties: [7],
      consumed: 0,
    });

    expect((await getBankableAmount(userId, 0, afterSettle))?.remaining).toBe(0);
    expect(issuedSql('values(')).toContain('(7, 99, 100000, 100000)');
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

describe('getBountyFunders', () => {
  it('gives each supporter of a bounty their part of what all its supporters put in', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      { bountyId: 7, userId: 1, unitAmount: 60 },
      { bountyId: 7, userId: 2, unitAmount: 40 },
      { bountyId: 8, userId: 3, unitAmount: 5 },
    ]);

    expect(await getBountyFunders([7, 8])).toEqual([
      { bountyId: 7, userId: 1, unitAmount: 60, total: 100 },
      { bountyId: 7, userId: 2, unitAmount: 40, total: 100 },
      { bountyId: 8, userId: 3, unitAmount: 5, total: 5 },
    ]);
  });
});

describe('receivedFromUsersSql', () => {
  // Pinned whole: a wrong payer column or split still returns plausible pairs.
  it('attributes user payments, platform-paid sales to their buyer and bounty awards to their supporters', () => {
    const sql = receivedFromUsersSql('toAccountId = 1', [
      { bountyId: 7, userId: 2, unitAmount: 60, total: 100 },
    ]);
    expect(squash(sql)).toBe(
      squash(`SELECT recipient, payer, sum(amount) AS amount FROM (SELECT toInt64(toAccountId) AS recipient,
          toInt64(if(fromAccountId = 0, JSONExtractInt(details, 'purchasedBy'), fromAccountId)) AS payer,
          toInt64(amount) AS amount
        FROM buzzTransactions
        WHERE toAccountId = 1 AND ${BANKABLE_EARNING_PREDICATE_SQL}
          AND (${RECEIVED_FROM_USER_SQL} OR (type = 'sell' AND fromAccountId = 0 AND JSONExtractInt(details, 'purchasedBy') > 0))
        UNION ALL
        SELECT award.recipient, funder.userId, intDiv(award.amount * funder.unitAmount, funder.total)
        FROM (
          SELECT toInt64(toAccountId) AS recipient, JSONExtractInt(details, 'entityId') AS bountyId,
            toInt64(amount) AS amount
          FROM buzzTransactions
          WHERE toAccountId = 1 AND (type = 'bounty' AND fromAccountId = 0 AND JSONExtractString(details, 'entityType') = 'Bounty')
        ) AS award
        INNER JOIN (
          SELECT * FROM values('bountyId Int64, userId Int64, unitAmount Int64, total Int64', (7, 2, 60, 100))
        ) AS funder ON funder.bountyId = award.bountyId) GROUP BY recipient, payer`)
    );
  });

  it('leaves the bounty arm out when no supporter is known, as ClickHouse rejects an empty values()', () => {
    expect(receivedFromUsersSql('toAccountId = 1', [])).not.toContain('UNION ALL');
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
  // Justin, 2026-10-09: generation tips are bankable but do not set the peak, like user tips.
  it('counts licence fees and user-paid early access from the cutover', () => {
    expect(PEAK_EARNING_PREDICATE_SQL).toBe(`(
  type = 'licenseFee'
  OR (type = 'purchase' AND fromAccountId != 0)
)`);
  });

  it('also counts generation compensation before the cutover', () => {
    expect(PRE_CUTOVER_PEAK_EARNING_PREDICATE_SQL).toBe(`(
  type IN ('compensation', 'licenseFee')
  OR (type = 'purchase' AND fromAccountId != 0)
)`);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { BANKABLE_CUTOVER } from '~/shared/constants/creator-program.constants';
import { PLACEMENT_LEDGER_TEXT } from '~/shared/utils/placement';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockClickhouse } = vi.hoisted(() => ({
  mockClickhouse: { $query: vi.fn() },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockClickhouse }));

import {
  BANKABLE_EARNING_PREDICATE_SQL,
  getBankableAmount,
} from '~/server/services/creator-program-bankable';

const userId = 42;
const sysRedis = redisMock.sysRedis;
const afterSettle = new Date('2026-12-15T12:00:00Z');

function sqlOf(callIndex: number) {
  const [parts, ...values] = mockClickhouse.$query.mock.calls[callIndex] as [string[], ...any[]];
  return parts.reduce(
    (acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''),
    ''
  );
}

/** ClickHouse returns UInt64 sums as strings, so the fixtures do too. */
function mockLedger({
  snapshot,
  earned,
  consumed,
}: {
  snapshot?: number;
  earned: number;
  consumed: number;
}) {
  mockClickhouse.$query.mockImplementation(async (parts: string[]) => {
    const sql = parts.join('');
    if (sql.includes('AS balance')) return [{ balance: String(snapshot ?? 0) }];
    return [{ earned: String(earned), consumed: String(consumed) }];
  });
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

  it('never reports a negative remaining amount', async () => {
    mockLedger({ snapshot: 10_000, earned: 0, consumed: 0 });

    const result = await getBankableAmount(userId, 25_000, afterSettle);

    expect(result?.remaining).toBe(0);
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
    expect(mockClickhouse.$query).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).not.toContain('AS balance');
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
  it('leaves generation compensation out', () => {
    expect(BANKABLE_EARNING_PREDICATE_SQL).not.toContain('compensation');
  });

  it('counts licence fees, donations, shop sales and bounties from anyone', () => {
    expect(BANKABLE_EARNING_PREDICATE_SQL).toMatch(
      /^\(\s*type IN \('licenseFee', 'donation', 'sell', 'bounty'\)\n/
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

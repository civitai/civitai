import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deepStringProxy } from './test-utils';

// ---------------------------------------------------------------------------
// processFinalRatings is the batch drain that flips Pending votes to
// Correct/Failed/Inconclusive. Tightly coupled to a 10s sysRedis lock and a
// ClickHouse buffer-cutoff cursor. These tests pin each branch + lock release.
// ---------------------------------------------------------------------------

const {
  mockSysRedis,
  mockClickhouseQuery,
  mockClickhouseExec,
  mockMultiChain,
} = vi.hoisted(() => {
  // Each multi() call records its sequence on a shared spy so tests can
  // inspect what commands were chained without rewriting the chain factory.
  const multiCalls: Array<{ ops: Array<{ cmd: string; args: unknown[] }>; result: unknown[] }> = [];

  return {
    mockSysRedis: {
      incr: vi.fn().mockResolvedValue(0),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      del: vi.fn().mockResolvedValue(1),
      multi: vi.fn(() => {
        const ops: Array<{ cmd: string; args: unknown[] }> = [];
        const chain: any = {};
        for (const cmd of ['setNX', 'expire', 'set', 'del']) {
          chain[cmd] = (...args: unknown[]) => {
            ops.push({ cmd, args });
            return chain;
          };
        }
        chain.exec = vi.fn().mockResolvedValue([]);
        multiCalls.push({ ops, result: [] });
        return chain;
      }),
      packed: { get: vi.fn() },
    },
    mockClickhouseQuery: vi.fn().mockResolvedValue([]),
    mockClickhouseExec: vi.fn().mockResolvedValue(undefined),
    mockMultiChain: multiCalls,
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: mockClickhouseQuery, $exec: mockClickhouseExec },
}));
vi.mock('~/server/redis/client', () => ({
  redis: {},
  sysRedis: mockSysRedis,
  REDIS_KEYS: deepStringProxy('rk'),
  REDIS_SYS_KEYS: deepStringProxy('rsk'),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/games/new-order/utils', () => ({}));

import { processFinalRatings } from '~/server/services/games/new-order.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiChain.length = 0;
});

describe('processFinalRatings', () => {
  it('returns "not-needed" when pending count is low AND last-processed is recent', async () => {
    mockSysRedis.incr.mockResolvedValue(10); // way below PROCESS_MIN
    // Last processed: just now → timeSinceLastProcessed = ~0
    mockSysRedis.get
      .mockResolvedValueOnce(Date.now().toString()) // LAST_PROCESSED_AT
      .mockResolvedValueOnce('0'); // BATCH_CUTOFF

    const result = await processFinalRatings();

    expect(result).toMatchObject({ status: 'not-needed' });
    // No lock attempted, no ClickHouse hit
    expect(mockSysRedis.multi).not.toHaveBeenCalled();
    expect(mockClickhouseQuery).not.toHaveBeenCalled();
    expect(mockClickhouseExec).not.toHaveBeenCalled();
  });

  it('returns "no-lock" when another process holds the lock', async () => {
    mockSysRedis.incr.mockResolvedValue(10_000); // above PROCESS_MIN, forces shouldProcess
    mockSysRedis.get
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('0');
    // Make the lock-acquire multi return [0] (setNX failed → lock not acquired)
    mockSysRedis.multi.mockImplementationOnce(() => {
      const chain: any = {};
      chain.setNX = () => chain;
      chain.expire = () => chain;
      chain.exec = vi.fn().mockResolvedValue([0, 1]);
      return chain;
    });

    const result = await processFinalRatings();

    expect(result).toEqual({ status: 'no-lock' });
    // Did NOT proceed to ClickHouse work
    expect(mockClickhouseQuery).not.toHaveBeenCalled();
    expect(mockClickhouseExec).not.toHaveBeenCalled();
  });

  it('returns "no-new-data" + releases lock when batch cursor has not advanced', async () => {
    mockSysRedis.incr.mockResolvedValue(10_000);
    mockSysRedis.get
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('1000'); // cutoff = 1000

    // Lock acquired
    mockSysRedis.multi.mockImplementationOnce(() => {
      const chain: any = {};
      chain.setNX = () => chain;
      chain.expire = () => chain;
      chain.exec = vi.fn().mockResolvedValue([1, 1]);
      return chain;
    });
    // ClickHouse update_time = 1000 → updateStart.getTime() === updateEnd.getTime()
    mockClickhouseQuery.mockResolvedValue([{ updateEnd: '1970-01-01T00:00:01.000Z' }]);
    // Wait — we need updateStart to equal updateEnd as Date objects. updateStart is
    // `new Date(parseInt('1000'))` = `new Date(1000)` = 1970-01-01T00:00:01.000Z.
    // Same as our mocked updateEnd ISO string when parsed by `new Date(...)`.

    // The "finally" block uses another multi() — provide an impl for that too.
    mockSysRedis.multi.mockImplementationOnce(() => {
      const chain: any = {};
      chain.set = () => chain;
      chain.del = () => chain;
      chain.exec = vi.fn().mockResolvedValue([]);
      return chain;
    });

    const result = await processFinalRatings();

    expect(result).toEqual({ status: 'no-new-data' });
    // No insert
    expect(mockClickhouseExec).not.toHaveBeenCalled();
    // Lock was acquired AND released — 2 multi() calls total
    expect(mockSysRedis.multi).toHaveBeenCalledTimes(2);
  });

  it('writes the rating finalization batch when there is new data', async () => {
    mockSysRedis.incr.mockResolvedValue(10_000);
    mockSysRedis.get
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('1000');

    // Lock acquired
    mockSysRedis.multi.mockImplementationOnce(() => {
      const chain: any = {};
      chain.setNX = () => chain;
      chain.expire = () => chain;
      chain.exec = vi.fn().mockResolvedValue([1, 1]);
      return chain;
    });
    // Cutoff has advanced (updateEnd > updateStart=1000)
    mockClickhouseQuery.mockResolvedValue([{ updateEnd: '2025-05-01T00:00:00.000Z' }]);
    // Cutoff-update multi
    mockSysRedis.multi.mockImplementationOnce(() => {
      const chain: any = {};
      chain.set = () => chain;
      chain.exec = vi.fn().mockResolvedValue([]);
      return chain;
    });
    // Finally-release multi
    mockSysRedis.multi.mockImplementationOnce(() => {
      const chain: any = {};
      chain.set = () => chain;
      chain.del = () => chain;
      chain.exec = vi.fn().mockResolvedValue([]);
      return chain;
    });

    const result = await processFinalRatings();

    expect(result).toMatchObject({ status: 'processed' });
    expect(mockClickhouseExec).toHaveBeenCalledTimes(1);
  });

  it('releases the lock in finally even when the ClickHouse insert throws', async () => {
    mockSysRedis.incr.mockResolvedValue(10_000);
    mockSysRedis.get
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('1000');

    mockSysRedis.multi.mockImplementationOnce(() => {
      const chain: any = {};
      chain.setNX = () => chain;
      chain.expire = () => chain;
      chain.exec = vi.fn().mockResolvedValue([1, 1]);
      return chain;
    });
    mockClickhouseQuery.mockResolvedValue([{ updateEnd: '2025-05-01T00:00:00.000Z' }]);
    mockClickhouseExec.mockRejectedValueOnce(new Error('CH insert failed'));
    // Finally-release multi (no cutoff-update multi this time because we throw before it)
    mockSysRedis.multi.mockImplementationOnce(() => {
      const chain: any = {};
      chain.set = () => chain;
      chain.del = () => chain;
      chain.exec = vi.fn().mockResolvedValue([]);
      return chain;
    });

    const result = await processFinalRatings();

    expect(result).toMatchObject({ status: 'error' });
    // Lock acquired (1) + finally release (1) = 2 multis. No cutoff-update.
    expect(mockSysRedis.multi).toHaveBeenCalledTimes(2);
  });
});

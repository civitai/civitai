import { describe, expect, it, vi } from 'vitest';
import { runPrepayoutReview, type AccountState, type PrepayoutReviewDeps } from '../run';
import type { PrepayoutLimits } from '../signals';

// Synthetic values for these tests only. Production limits are not committed.
const limits: PrepayoutLimits = {
  counterparty: 1_000,
  singlePayerShare: 0.9,
  singlePayerAmount: 9_999_999,
  payoutJump: 50,
  batchPayer: 9_999_999,
  youngPayerDays: 10,
  payoutJumpPercentile: 0.5,
  historyPeriods: 2,
};

type Rows = {
  batch: { userId: number; payoutCents: number }[];
  totals: { userId: number; amount: number }[];
  pairs: { userId: number; payerId: number; received: number; sent: number }[];
  prior?: { userId: string; period: string; payoutCents: string }[];
};

function fakeClickhouse(rows: Rows) {
  const queries: string[] = [];
  return {
    queries,
    ch: {
      $query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('substring(externalTransactionId')) return rows.prior ?? [];
        if (sql.includes("toAccountType = 'cashPending'")) return rows.batch;
        if (sql.includes('LEFT JOIN')) return rows.pairs;
        return rows.totals;
      }),
    } as PrepayoutReviewDeps['ch'] & { $query: ReturnType<typeof vi.fn> },
  };
}

const account = (over: Partial<AccountState> = {}): AccountState => ({
  username: 'someone',
  createdAt: new Date('2024-01-01'),
  muted: false,
  pendingRestriction: false,
  banned: false,
  programBanned: false,
  ...over,
});

function makeDeps(rows: Rows, over: Partial<PrepayoutReviewDeps> = {}) {
  const { ch, queries } = fakeClickhouse(rows);
  const store = {
    startRun: vi.fn(async () => 7),
    finishRun: vi.fn(async () => undefined),
    saveFlag: vi.fn(async () => ({ created: true, reopened: false })),
  };
  const deps: PrepayoutReviewDeps = {
    ch,
    readLimits: async () => limits,
    readCounterpartyMinimum: async () => null,
    getWarnedAt: async () => new Map(),
    getCarriedUserIds: async () => [],
    loadAccounts: async (ids) =>
      new Map(ids.map((id) => [id, account({ username: `u${id}`, muted: id === 3 })])),
    store,
    sendReport: vi.fn(async () => undefined),
    now: () => new Date('2026-11-01T06:00:00Z'),
    ...over,
  };
  return { deps, store, queries };
}

// Creator 1 is clean, 2 exchanges Buzz both ways with user 900, 3 is muted.
const batchRows: Rows = {
  batch: [
    { userId: 1, payoutCents: 5_000 },
    { userId: 2, payoutCents: 6_000 },
    { userId: 3, payoutCents: 7_000 },
  ],
  totals: [
    { userId: 1, amount: 500_000 },
    { userId: 2, amount: 500_000 },
    { userId: 3, amount: 500_000 },
  ],
  pairs: [
    { userId: 1, payerId: 800, received: 2_000, sent: 0 },
    { userId: 2, payerId: 900, received: 3_000, sent: 2_500 },
  ],
};

describe('runPrepayoutReview', () => {
  it('reviews last month and holds only the creators a signal fires for', async () => {
    const { deps, store, queries } = makeDeps(batchRows);

    const outcome = await runPrepayoutReview(deps);

    expect(store.startRun).toHaveBeenCalledWith('2026-10', new Date('2026-11-01T06:00:00Z'));
    expect(queries.some((q) => q.includes("'comp-pool-unified-2026-10-'"))).toBe(true);
    expect(outcome).toEqual({ creditedCount: 3, evaluatedCount: 3, flaggedCount: 2, error: null });
    expect(store.saveFlag.mock.calls.map(([f]) => [f.userId, f.signals])).toEqual([
      [2, ['counterparty']],
      [3, ['restricted']],
    ]);
    expect(store.saveFlag.mock.calls[0][0].evidence).toMatchObject({
      payoutCents: 6_000,
      exchanges: [{ userId: 900, username: 'u900', received: 3_000, sent: 2_500 }],
    });
    expect(store.finishRun).toHaveBeenCalledWith(7, expect.objectContaining({ error: null }));
    expect(deps.sendReport).toHaveBeenCalledWith(
      expect.objectContaining({
        detector: 'creator-program-prepayout',
        findings: [
          expect.objectContaining({ userId: 2, actioned: true, action: 'held' }),
          expect.objectContaining({ userId: 3, actioned: true, action: 'held' }),
        ],
      })
    );
  });

  it('files a held creator on the board when first held or held again, not on every re-run', async () => {
    const { deps } = makeDeps(batchRows);
    deps.store.saveFlag = vi.fn(async (flag) => ({
      created: flag.userId === 3,
      reopened: false,
    }));

    await runPrepayoutReview(deps);
    const [first] = (deps.sendReport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(first.findings.map((f: { userId: number }) => f.userId)).toEqual([3]);

    deps.store.saveFlag = vi.fn(async (flag) => ({ created: false, reopened: flag.userId === 2 }));
    await runPrepayoutReview(deps);
    const [second] = (deps.sendReport as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(second.findings).toEqual([
      expect.objectContaining({ userId: 2, reason: expect.stringMatching(/^Held again/) }),
    ]);
  });

  it('feeds payout history and prior warnings into the signals', async () => {
    const rows: Rows = {
      ...batchRows,
      // Creator 4 usually gets 100 cents; 9_000 is 90x and the top of the batch.
      batch: [...batchRows.batch, { userId: 4, payoutCents: 9_000 }],
      totals: [...batchRows.totals, { userId: 4, amount: 500_000 }],
      pairs: [{ userId: 3, payerId: 901, received: 600, sent: 600 }],
      prior: [
        { userId: '4', period: '2026-09', payoutCents: '100' },
        { userId: '4', period: '2026-08', payoutCents: '100' },
      ],
    };
    const { deps, store } = makeDeps(rows, {
      loadAccounts: async (ids) => new Map(ids.map((id) => [id, account()])),
      readCounterpartyMinimum: async () => 500,
      getWarnedAt: async () => new Map([[3, '2026-09-02T10:00:00.000Z']]),
    });

    await runPrepayoutReview(deps);

    expect(store.saveFlag.mock.calls.map(([f]) => [f.userId, f.signals])).toEqual([
      [3, ['warned-again']],
      [4, ['payout-jump']],
    ]);
  });

  it('does not review after the 14th, when the batch has already settled', async () => {
    const { deps, store, queries } = makeDeps(batchRows, {
      now: () => new Date('2026-11-15T06:00:00Z'),
    });

    expect((await runPrepayoutReview(deps)).error).toBe('after the 14th');
    expect(store.startRun).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it('re-decides a creator withheld last cycle, credited again or not', async () => {
    const { deps, store } = makeDeps(batchRows, {
      getCarriedUserIds: async () => [1, 77],
      loadAccounts: async (ids) => new Map(ids.map((id) => [id, account()])),
    });

    const outcome = await runPrepayoutReview(deps);

    expect(outcome).toMatchObject({ creditedCount: 3, evaluatedCount: 4 });
    const flagged = store.saveFlag.mock.calls.map(([f]) => [f.userId, f.signals, f.payoutCents]);
    expect(flagged).toContainEqual([1, ['withheld-carried'], 5_000]);
    expect(flagged).toContainEqual([77, ['withheld-carried'], 0]);
  });

  it('records a failed run when ClickHouse is unavailable', async () => {
    const { deps, store } = makeDeps(batchRows, { ch: null });

    expect((await runPrepayoutReview(deps)).error).toBe('clickhouse unavailable');
    expect(store.saveFlag).not.toHaveBeenCalled();
  });

  it('records a failed run, and holds nobody, while the limits are unset', async () => {
    const { deps, store, queries } = makeDeps(batchRows, { readLimits: async () => null });

    const outcome = await runPrepayoutReview(deps);

    expect(outcome.error).toBe('limits not set');
    expect(queries).toEqual([]);
    expect(store.saveFlag).not.toHaveBeenCalled();
    expect(store.finishRun).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ error: 'limits not set' })
    );
  });

  it('records a failed run when the batch is empty, so settlement alerts', async () => {
    const { deps, store } = makeDeps({ batch: [], totals: [], pairs: [] });

    const outcome = await runPrepayoutReview(deps);

    expect(outcome).toMatchObject({ creditedCount: 0, error: expect.any(String) });
    expect(store.finishRun).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ error: outcome.error })
    );
  });

  it('a failed board report leaves the run clean', async () => {
    const { deps, store } = makeDeps(batchRows, {
      sendReport: vi.fn(async () => {
        throw new Error('board down');
      }),
    });

    await expect(runPrepayoutReview(deps)).resolves.toMatchObject({ error: null, flaggedCount: 2 });
    expect(store.finishRun).toHaveBeenCalledWith(7, expect.objectContaining({ error: null }));
  });

  it('records the error and rethrows when a query fails', async () => {
    const { deps, store } = makeDeps(batchRows);
    deps.loadAccounts = async () => {
      throw new Error('replica down');
    };

    await expect(runPrepayoutReview(deps)).rejects.toThrow('replica down');
    expect(store.finishRun).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ error: 'replica down' })
    );
  });
});

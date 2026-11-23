import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same mocked surface as stickerPlacementAccepted.reward.test.ts: base.reward builds a ClickHouse
// client and buzz.service at import time.
const h = vi.hoisted(() => ({
  insert: vi.fn(async () => undefined),
  createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: unknown[]) => h.insert(...(args as [])),
    // The monthly cap lookup: nothing awarded yet.
    $query: vi.fn(async () => []),
  },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: unknown[]) => h.createBuzzTransactionMany(...(args as [])),
  getMultipliersForUser: (...args: unknown[]) => h.getMultipliersForUser(...(args as [])),
  getTransactionByExternalId: vi.fn(async () => null),
}));

import type { BuzzEventLog } from '~/server/rewards/base.reward';
import { reportAcceptedReward } from '~/server/rewards/passive/reportAccepted.reward';

/** The buzzEvents rows written, as `toUserId:forId`. A pending row is what process-rewards pays. */
const written = () =>
  h.insert.mock.calls.flatMap((call) => {
    const [{ values }] = call as unknown as [{ values: { toUserId: number; forId: number }[] }];
    return values.map((v) => `${v.toUserId}:${v.forId}`);
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the report accepted reward', () => {
  // Literal -1 rather than the constant: a fixture following a changed constant would keep passing
  // while the system account's real reports started paying again.
  it('records no reward for a report filed by the system account', async () => {
    await reportAcceptedReward.apply({ userId: -1, reportId: 9 });
    await reportAcceptedReward.apply({ userId: 42, reportId: 10 });

    // The person's report is the control: it shows a write would have been seen.
    expect(written()).toEqual(['42:10']);
  });
});

/** buzzEvents rows the job has already settled, as the preprocess lookup reads them. */
type Row = { type: string; toUserId: number; forId: number; status: string; version: number };
let table: Row[] = [];
const ch = {
  // Applies the type and status filters only when the SQL asks for them, so a query that loses
  // one is seen to. The key filter only bounds the read: the reward looks each event up by key.
  query: vi.fn(
    async ({
      query,
      query_params: { type, keys },
    }: {
      query: string;
      query_params: { type: string; keys: [number, number][] };
    }) => {
      const sql = query.replace(/\s+/g, ' ');
      const byType = sql.includes('type = {type:String}');
      const settledOnly = sql.includes("status != 'pending'");
      const byKey = sql.includes('(toUserId, forId) IN {keys:Array(Tuple(Int32, Int32))}');
      const wanted = new Set(keys.map(([toUserId, forId]) => `${toUserId}:${forId}`));
      const latest = new Map<string, { toUserId: number; forId: number; version: number }>();
      for (const row of table) {
        const key = `${row.toUserId}:${row.forId}`;
        if (byType && row.type !== type) continue;
        if (settledOnly && row.status === 'pending') continue;
        if (byKey && !wanted.has(key)) continue;
        if ((latest.get(key)?.version ?? -1) < row.version) latest.set(key, { ...row });
      }
      return { json: async () => [...latest.values()] };
    }
  ),
};

/** A pending row as `process-rewards` reads it back from buzzEvents. */
const pending = (reportId: number, version: number): BuzzEventLog => ({
  type: 'reportAccepted',
  forId: reportId,
  toUserId: 42,
  byUserId: 42,
  awardAmount: 50,
  multiplier: 1,
  status: 'pending',
  version,
  transactionDetails: '{}',
});

/** The externalTransactionId of each transaction sent to the buzz service. */
const paid = () =>
  h.createBuzzTransactionMany.mock.calls.flatMap((call) => {
    const [transactions] = call as unknown as [{ externalTransactionId: string }[]];
    return transactions.map((t) => t.externalTransactionId);
  });

const run = (toProcess: BuzzEventLog[]) =>
  reportAcceptedReward.process({
    ch: ch as never,
    db: {} as never,
    lastUpdate: new Date(0),
    toProcess,
  });

describe('paying an accepted report', () => {
  beforeEach(() => {
    table = [];
  });

  it('pays a report once, however many times it is accepted', async () => {
    // Report 10 was accepted and paid before; report 11 is accepted for the first time.
    table = [
      { type: 'reportAccepted', toUserId: 42, forId: 10, status: 'pending', version: 1 },
      { type: 'reportAccepted', toUserId: 42, forId: 10, status: 'awarded', version: 2 },
      // Settled rows for report 11's id under another reward, and under another reporter.
      { type: 'goodContent:image', toUserId: 42, forId: 11, status: 'awarded', version: 2 },
      { type: 'reportAccepted', toUserId: 7, forId: 11, status: 'awarded', version: 2 },
    ];
    const again = pending(10, 1);
    const first = pending(11, 1);

    await run([again, first]);

    // type:forId-toUserId-byUserId. Report 11 is the control: it shows a payment would be seen.
    expect(paid()).toEqual(['reportAccepted:11-42-42']);
    expect(again.status).toBe('unqualified');
  });

  // Keep: the row recording the repeat shares the payment row's key, and buzzEvents keeps the
  // highest version per key. Written at the payment's version or above, it would replace the
  // payment, and the monthly cap would stop counting money already paid.
  it('records a repeated acceptance below the version of the original payment', async () => {
    table = [{ type: 'reportAccepted', toUserId: 42, forId: 10, status: 'awarded', version: 2 }];

    await run([pending(10, 1)]);

    const written = h.insert.mock.calls.flatMap((call) => {
      const [{ values }] = call as unknown as [{ values: { forId: number; version: number }[] }];
      return values.filter((v) => v.forId === 10).map((v) => v.version);
    });
    expect(written).toEqual([1]);
  });

  it('keeps a repeated acceptance below the original payment when the batch fails to send', async () => {
    table = [{ type: 'reportAccepted', toUserId: 42, forId: 10, status: 'awarded', version: 2 }];
    h.createBuzzTransactionMany.mockRejectedValue(new Error('buzz service down'));

    try {
      await expect(run([pending(10, 1), pending(11, 1)])).rejects.toThrow('Failed to send');
    } finally {
      h.createBuzzTransactionMany.mockResolvedValue({ transactions: [] });
    }

    const written = h.insert.mock.calls.flatMap((call) => {
      const [{ values }] = call as unknown as [{ values: { forId: number; version: number }[] }];
      return values.filter((v) => v.forId === 10).map((v) => v.version);
    });
    expect(written).toEqual([1]);
  });

  it('still pays a report whose earlier payment failed and was reset to pending', async () => {
    // A failed send rewrites the row as pending one version above the awarded one it replaced.
    table = [
      { type: 'reportAccepted', toUserId: 42, forId: 10, status: 'awarded', version: 2 },
      { type: 'reportAccepted', toUserId: 42, forId: 10, status: 'pending', version: 3 },
    ];

    await run([pending(10, 3)]);

    expect(paid()).toEqual(['reportAccepted:10-42-42']);
  });
});

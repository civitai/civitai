import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockClickhouse, mockFetchThroughCache } = vi.hoisted(() => {
  return {
    mockDbRead: {
      model: { findMany: vi.fn() },
    },
    mockClickhouse: { $query: vi.fn() },
    mockFetchThroughCache: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockClickhouse }));
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: mockFetchThroughCache }));
vi.mock('~/server/redis/client', () => ({
  REDIS_KEYS: {
    CREATOR_EARNINGS: {
      THIS_MONTH: 'creator-earnings:this-month',
      MODEL_PERFORMANCE: 'creator-earnings:model-performance',
      SOURCE_MIX: 'creator-earnings:source-mix',
    },
  },
}));
vi.mock('~/server/common/constants', () => ({
  CacheTTL: { sm: 60, md: 300, lg: 3600, day: 86400 },
}));

// Late import after mocks are wired
import {
  getEarningsThisMonth,
  getModelPerformance,
  getSourceMix,
} from '~/server/services/creator-earnings.service';

const USER_ID = 42;

const fixedDate = new Date('2026-05-15T12:00:00Z');
const currentMonthBucket = '2026-05-01 00:00:00';
const priorMonthBucket = '2026-04-01 00:00:00';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(fixedDate);
  mockDbRead.model.findMany.mockReset();
  mockClickhouse.$query.mockReset();
});

describe('getEarningsThisMonth', () => {
  it('aggregates creatorsTip + tipConfirm + buzzTransactions into current/prior monthly buckets', async () => {
    mockDbRead.model.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'My LoRA',
        type: 'LORA',
        earlyAccessDeadline: null,
        modelVersions: [{ id: 101 }, { id: 102 }],
      },
    ]);

    // Three queries fan out in queryMonthlyAggregate(); return tagged shapes per call
    mockClickhouse.$query.mockImplementation(async (sql: any) => {
      sql = typeof sql === 'string' ? sql : Array.from(sql).join('');
      if (sql.includes('orchestration.jobs')) {
        return [
          { bucket: currentMonthBucket, amount: 5000 },
          { bucket: priorMonthBucket, amount: 3000 },
        ];
      }
      if (sql.includes('Tip_Confirm')) {
        return [{ bucket: currentMonthBucket, amount: 1200 }];
      }
      if (sql.includes('buzzTransactions')) {
        return [
          { bucket: currentMonthBucket, category: 'ea', amount: 2500 },
          { bucket: currentMonthBucket, category: 'bounty', amount: 100 },
          { bucket: priorMonthBucket, category: 'ea', amount: 800 },
        ];
      }
      return [];
    });

    const result = await getEarningsThisMonth({ userId: USER_ID });

    expect(result.currentMonth.breakdown).toMatchObject({
      creatorsTip: 5000,
      tipConfirm: 1200,
      ea: 2500,
      bounty: 100,
      other: 0,
    });
    expect(result.currentMonth.totalBuzz).toBe(5000 + 1200 + 2500 + 100);
    expect(result.currentMonth.usdEquivalent).toBeCloseTo((5000 + 1200 + 2500 + 100) / 1000, 2);
    expect(result.priorMonth.breakdown.creatorsTip).toBe(3000);
    expect(result.priorMonth.breakdown.ea).toBe(800);
  });

  it('returns zero totals for a creator with no models and no transactions', async () => {
    mockDbRead.model.findMany.mockResolvedValue([]);
    mockClickhouse.$query.mockResolvedValue([]);

    const result = await getEarningsThisMonth({ userId: USER_ID });

    expect(result.currentMonth.totalBuzz).toBe(0);
    expect(result.priorMonth.totalBuzz).toBe(0);
    expect(result.currentMonth.breakdown.creatorsTip).toBe(0);
  });

  it('skips the orchestration.jobs creatorsTip query when the creator has no model versions', async () => {
    mockDbRead.model.findMany.mockResolvedValue([]);
    const calls: string[] = [];
    mockClickhouse.$query.mockImplementation(async (sql: any) => {
      sql = typeof sql === 'string' ? sql : Array.from(sql).join('');
      calls.push(sql);
      return [];
    });

    await getEarningsThisMonth({ userId: USER_ID });

    expect(calls.some((s) => s.includes('orchestration.jobs'))).toBe(false);
    expect(calls.some((s) => s.includes('Tip_Confirm'))).toBe(true);
    expect(calls.some((s) => s.includes('buzzTransactions'))).toBe(true);
  });
});

describe('getSourceMix', () => {
  it('returns rows with percentages summing to ~100 when there is earning activity', async () => {
    mockDbRead.model.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Model',
        type: 'LORA',
        earlyAccessDeadline: null,
        modelVersions: [{ id: 101 }],
      },
    ]);

    mockClickhouse.$query.mockImplementation(async (sql: any) => {
      sql = typeof sql === 'string' ? sql : Array.from(sql).join('');
      if (sql.includes('orchestration.jobs')) return [{ amount: 700 }];
      if (sql.includes('Tip_Confirm')) return [{ amount: 200 }];
      if (sql.includes('buzzTransactions')) return [{ category: 'ea', amount: 100 }];
      return [];
    });

    const rows = await getSourceMix({ userId: USER_ID, window: '30d' });

    const byKey = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(byKey.creatorsTip.buzz).toBe(700);
    expect(byKey.tipConfirm.buzz).toBe(200);
    expect(byKey.ea.buzz).toBe(100);
    expect(byKey.creatorsTip.pct).toBeCloseTo(70, 0);
    expect(byKey.tipConfirm.pct).toBeCloseTo(20, 0);
    expect(byKey.ea.pct).toBeCloseTo(10, 0);
  });

  it('returns 0% across all rows when there is no earning activity', async () => {
    mockDbRead.model.findMany.mockResolvedValue([]);
    mockClickhouse.$query.mockResolvedValue([]);

    const rows = await getSourceMix({ userId: USER_ID, window: '30d' });

    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.buzz).toBe(0);
      expect(r.pct).toBe(0);
    }
  });
});

describe('getModelPerformance', () => {
  it('aggregates per-version jobs/buzz up to model and computes trend', async () => {
    mockDbRead.model.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Up model',
        type: 'LORA',
        earlyAccessDeadline: new Date('2027-01-01T00:00:00Z'),
        modelVersions: [{ id: 101 }, { id: 102 }],
      },
      {
        id: 2,
        name: 'Down model',
        type: 'Checkpoint',
        earlyAccessDeadline: null,
        modelVersions: [{ id: 201 }],
      },
    ]);

    mockClickhouse.$query.mockResolvedValue([
      // model 1 grew: 1000 prior -> 2000 current
      { modelVersionId: 101, period: 'current', jobs: 100, buzz: 1500 },
      { modelVersionId: 102, period: 'current', jobs: 50, buzz: 500 },
      { modelVersionId: 101, period: 'prior', jobs: 80, buzz: 1000 },
      // model 2 shrank: 500 prior -> 200 current
      { modelVersionId: 201, period: 'current', jobs: 20, buzz: 200 },
      { modelVersionId: 201, period: 'prior', jobs: 60, buzz: 500 },
    ]);

    const rows = await getModelPerformance({
      userId: USER_ID,
      window: '30d',
      sortBy: 'buzzEarned',
    });

    // Sorted by buzzEarned desc -> Up model (2000) first, Down model (200) second
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      modelId: 1,
      modelName: 'Up model',
      jobsCount: 150,
      buzzEarned: 2000,
      trend: 'up',
      eaEnabled: true,
    });
    expect(rows[1]).toMatchObject({
      modelId: 2,
      modelName: 'Down model',
      jobsCount: 20,
      buzzEarned: 200,
      trend: 'down',
      eaEnabled: false,
    });
  });

  it('returns empty array for a creator with no published models', async () => {
    mockDbRead.model.findMany.mockResolvedValue([]);

    const rows = await getModelPerformance({
      userId: USER_ID,
      window: '30d',
      sortBy: 'buzzEarned',
    });

    expect(rows).toEqual([]);
    expect(mockClickhouse.$query).not.toHaveBeenCalled();
  });

  it('marks EA as disabled when earlyAccessDeadline is in the past', async () => {
    mockDbRead.model.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Past-EA model',
        type: 'LORA',
        earlyAccessDeadline: new Date('2025-01-01T00:00:00Z'),
        modelVersions: [{ id: 101 }],
      },
    ]);
    mockClickhouse.$query.mockResolvedValue([
      { modelVersionId: 101, period: 'current', jobs: 5, buzz: 50 },
    ]);

    const rows = await getModelPerformance({
      userId: USER_ID,
      window: '30d',
      sortBy: 'buzzEarned',
    });

    expect(rows[0].eaEnabled).toBe(false);
  });
});

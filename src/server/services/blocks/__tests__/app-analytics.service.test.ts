import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the Phase 0 author-analytics service. The security-critical
 * surface is ownership: a caller must only ever see analytics for app_block
 * ids resolved from AppBlock.app.userId === their id. Everything else is
 * aggregation correctness + range clamping.
 *
 * Prisma is mocked at the module boundary; the raw `$queryRaw` calls are
 * matched by sniffing the SQL text of the tagged template so each of the
 * three raw queries (installs series / runs series / distinct users) gets
 * its own canned result.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    appBlock: { findMany: vi.fn() },
    blockUserSubscription: { count: vi.fn() },
    blockSpendAttribution: { aggregate: vi.fn() },
    blockBuzzAttribution: { aggregate: vi.fn() },
    blockScopeInvocation: { count: vi.fn(), groupBy: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

// `Prisma.sql` / `Prisma.join` are used by the service to build the raw
// queries. Provide a minimal shim that records the static SQL strings so
// the $queryRaw mock can route by content.
vi.mock('@prisma/client', () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({
      __sql: strings.join('?'),
    }),
    join: (values: unknown[]) => ({ __join: values }),
  },
}));

import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  getMyAppAnalytics,
  getOwnedAppBlockIds,
  resolveRange,
} from '../app-analytics.service';

const OWNER_ID = 42;
const OWNED_ID = 'apb_owned';
const OWNED_ID_2 = 'apb_owned2';
const FOREIGN_ID = 'apb_someone_else';

function routeQueryRaw() {
  // The three raw queries are distinguished by a unique table token in
  // their SQL text.
  mockDbRead.$queryRaw.mockImplementation((arg: { __sql?: string }) => {
    const sql = arg?.__sql ?? '';
    if (sql.includes('block_user_subscriptions')) {
      return Promise.resolve([
        { bucket: new Date('2026-06-01T00:00:00Z'), value: 3n },
        { bucket: new Date('2026-06-02T00:00:00Z'), value: 5n },
      ]);
    }
    if (sql.includes('block_spend_attribution')) {
      return Promise.resolve([{ bucket: new Date('2026-06-01T00:00:00Z'), value: 7n }]);
    }
    if (sql.includes('block_scope_invocations')) {
      return Promise.resolve([{ value: 4n }]); // distinct users
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: caller owns one app.
  mockDbRead.appBlock.findMany.mockResolvedValue([{ id: OWNED_ID }, { id: OWNED_ID_2 }]);
  mockDbRead.blockUserSubscription.count
    .mockResolvedValueOnce(20) // installs total
    .mockResolvedValueOnce(12); // installs active
  mockDbRead.blockSpendAttribution.aggregate.mockResolvedValue({
    _count: 7,
    _sum: { buzzAmount: 7000 },
  });
  mockDbRead.blockBuzzAttribution.aggregate.mockResolvedValue({
    _count: 2,
    _sum: { buzzAmount: 5000, usdAmountCents: 999 },
  });
  // invocations: total count then error count
  mockDbRead.blockScopeInvocation.count
    .mockResolvedValueOnce(100) // apiCalls total
    .mockResolvedValueOnce(10); // status>=400
  mockDbRead.blockScopeInvocation.groupBy
    .mockResolvedValueOnce([
      { scope: 'ai:write:budgeted', _count: 60 },
      { scope: 'models:read', _count: 40 },
    ])
    .mockResolvedValueOnce([{ endpoint: '/api/v1/foo', _count: 70 }]);
  routeQueryRaw();
});

describe('resolveRange', () => {
  const now = new Date('2026-06-21T00:00:00Z');

  it('defaults to the last DEFAULT_RANGE_DAYS at day granularity', () => {
    const r = resolveRange({ now });
    expect(r.to.getTime()).toBe(now.getTime());
    const spanDays = (r.to.getTime() - r.from.getTime()) / (24 * 3600 * 1000);
    expect(spanDays).toBeCloseTo(DEFAULT_RANGE_DAYS, 5);
    expect(r.granularity).toBe('day');
  });

  it('switches to week granularity for ranges over 60 days', () => {
    const from = new Date(now.getTime() - 120 * 24 * 3600 * 1000);
    const r = resolveRange({ from, to: now, now });
    expect(r.granularity).toBe('week');
  });

  it('caps the range at MAX_RANGE_DAYS', () => {
    const from = new Date(now.getTime() - 5 * 365 * 24 * 3600 * 1000);
    const r = resolveRange({ from, to: now, now });
    const spanDays = (r.to.getTime() - r.from.getTime()) / (24 * 3600 * 1000);
    expect(spanDays).toBeLessThanOrEqual(MAX_RANGE_DAYS + 0.001);
  });

  it('clamps a future `to` down to now', () => {
    const future = new Date(now.getTime() + 10 * 24 * 3600 * 1000);
    const r = resolveRange({ to: future, now });
    expect(r.to.getTime()).toBe(now.getTime());
  });

  it('falls back to default when from > to', () => {
    const from = new Date('2026-06-20T00:00:00Z');
    const to = new Date('2026-06-10T00:00:00Z');
    const r = resolveRange({ from, to, now });
    expect(r.from.getTime()).toBeLessThan(r.to.getTime());
  });
});

describe('getOwnedAppBlockIds (ownership resolution)', () => {
  it('returns all owned ids when no specific id is requested', async () => {
    const ids = await getOwnedAppBlockIds({ ownerUserId: OWNER_ID });
    expect(ids).toEqual([OWNED_ID, OWNED_ID_2]);
    expect(mockDbRead.appBlock.findMany).toHaveBeenCalledWith({
      where: { app: { userId: OWNER_ID } },
      select: { id: true },
    });
  });

  it('returns the single requested id when the caller owns it', async () => {
    const ids = await getOwnedAppBlockIds({ ownerUserId: OWNER_ID, appBlockId: OWNED_ID });
    expect(ids).toEqual([OWNED_ID]);
  });

  it('returns [] when the requested id is NOT owned (no cross-owner leak)', async () => {
    const ids = await getOwnedAppBlockIds({ ownerUserId: OWNER_ID, appBlockId: FOREIGN_ID });
    expect(ids).toEqual([]);
  });
});

describe('getMyAppAnalytics (aggregation)', () => {
  it('aggregates installs, runs+buzz, purchased and engagement correctly', async () => {
    const result = await getMyAppAnalytics({ userId: OWNER_ID });

    expect(result.notOwned).toBe(false);
    // installs
    expect(result.installs.total).toBe(20);
    expect(result.installs.active).toBe(12);
    expect(result.installs.series).toEqual([
      { bucket: '2026-06-01T00:00:00.000Z', value: 3 },
      { bucket: '2026-06-02T00:00:00.000Z', value: 5 },
    ]);
    // runs + buzz spent
    expect(result.runs.count).toBe(7);
    expect(result.runs.buzzSpent).toBe(7000);
    expect(result.runs.series).toEqual([
      { bucket: '2026-06-01T00:00:00.000Z', value: 7 },
    ]);
    // buzz purchased
    expect(result.buzzPurchased.count).toBe(2);
    expect(result.buzzPurchased.buzzAmount).toBe(5000);
    expect(result.buzzPurchased.grossCents).toBe(999);
    // engagement
    expect(result.engagement.apiCalls).toBe(100);
    expect(result.engagement.activeUsers).toBe(4);
    expect(result.engagement.errorRate).toBeCloseTo(0.1, 5);
    expect(result.engagement.topScopes).toEqual([
      { scope: 'ai:write:budgeted', count: 60 },
      { scope: 'models:read', count: 40 },
    ]);
    expect(result.engagement.topEndpoints).toEqual([
      { endpoint: '/api/v1/foo', count: 70 },
    ]);
  });

  it('reports a zero error rate when there are no API calls', async () => {
    // Override invocation counts: 0 total, 0 errors.
    mockDbRead.blockScopeInvocation.count.mockReset();
    mockDbRead.blockScopeInvocation.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const result = await getMyAppAnalytics({ userId: OWNER_ID });
    expect(result.engagement.apiCalls).toBe(0);
    expect(result.engagement.errorRate).toBe(0);
  });

  it('passes the owned id set into the aggregate where-clauses', async () => {
    await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: OWNED_ID });
    // spend aggregate should be scoped to the single owned id
    const spendArgs = mockDbRead.blockSpendAttribution.aggregate.mock.calls[0][0];
    expect(spendArgs.where.appBlockId).toEqual({ in: [OWNED_ID] });
    expect(spendArgs.where.attributedAt).toHaveProperty('gte');
    expect(spendArgs.where.attributedAt).toHaveProperty('lte');
  });
});

describe('getMyAppAnalytics (ownership enforcement)', () => {
  it('returns zeroed analytics with notOwned=true for a non-owned id', async () => {
    const result = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: FOREIGN_ID });
    expect(result.notOwned).toBe(true);
    expect(result.installs.total).toBe(0);
    expect(result.runs.count).toBe(0);
    expect(result.buzzPurchased.count).toBe(0);
    expect(result.engagement.apiCalls).toBe(0);
    // CRITICAL: none of the aggregate queries ran — no foreign data touched.
    expect(mockDbRead.blockSpendAttribution.aggregate).not.toHaveBeenCalled();
    expect(mockDbRead.blockBuzzAttribution.aggregate).not.toHaveBeenCalled();
    expect(mockDbRead.blockScopeInvocation.count).not.toHaveBeenCalled();
  });

  it('returns empty (notOwned=false) when the caller owns nothing', async () => {
    mockDbRead.appBlock.findMany.mockResolvedValue([]);
    const result = await getMyAppAnalytics({ userId: OWNER_ID });
    expect(result.notOwned).toBe(false);
    expect(result.installs.total).toBe(0);
    expect(mockDbRead.blockSpendAttribution.aggregate).not.toHaveBeenCalled();
  });
});

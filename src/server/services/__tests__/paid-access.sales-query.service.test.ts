import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sale query in getSalesFor decides which sales apply to which version and which are live enough to
// cache. Every other suite stubs createCachedObject with a fake that never calls lookupFn, so the query is
// unobservable there: the fake hands back a sale list by construction. This one drives the real lookup and
// lets the database mock answer, so replacing the filter with `where: {}` goes red instead of green.
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    paidAccess: { findMany: vi.fn() },
    modelVersionSaleItem: { findMany: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, xs: 60 } }));
vi.mock('~/server/redis/client', () => ({
  REDIS_KEYS: {
    CACHES: { PAID_ACCESS: 'test:paid-access', PAID_ACCESS_CAP_TIER: 'test:cap-tier' },
  },
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: ({
    lookupFn,
  }: {
    lookupFn: (ids: number[], fromWrite?: boolean) => Promise<Record<string, unknown>>;
  }) => ({
    fetch: (ids: number[]) => lookupFn(ids, false),
    bust: vi.fn(),
  }),
}));

import { getPaidAccess } from '~/server/services/paid-access.service';

const PERMANENT = { entityId: 1, ownerId: 9, endsAt: null, timeframeDays: null, terms: { download: { price: 500 } } };
const ALSO_PERMANENT = { ...PERMANENT, entityId: 2 };
const TIMED = { ...PERMANENT, entityId: 3, timeframeDays: 7, endsAt: new Date('2099-01-01T00:00:00.000Z') };

const saleRow = (modelVersionId: number, id: number, userId = 9) => ({
  modelVersionId,
  sale: {
    id,
    userId,
    discountType: 'Percent',
    discountAmount: 20,
    startsAt: new Date('2026-03-01T00:00:00.000Z'),
    endsAt: new Date('2099-01-01T00:00:00.000Z'),
    canceledAt: null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.modelVersionSaleItem.findMany.mockResolvedValue([]);
});

describe('getSalesFor — which sales reach which version', () => {
  it('attributes each sale only to the version it covers', async () => {
    mockDb.paidAccess.findMany.mockResolvedValue([PERMANENT, ALSO_PERMANENT]);
    mockDb.modelVersionSaleItem.findMany.mockResolvedValue([saleRow(1, 11), saleRow(2, 22)]);

    const out = await getPaidAccess('ModelVersion', [1, 2]);

    expect(out[1]?.sales?.map((s) => s.id)).toEqual([11]);
    expect(out[2]?.sales?.map((s) => s.id)).toEqual([22]);
  });

  it('scopes the query to the requested versions and to live-or-upcoming, uncancelled sales', async () => {
    mockDb.paidAccess.findMany.mockResolvedValue([PERMANENT]);

    await getPaidAccess('ModelVersion', [1]);

    const where = mockDb.modelVersionSaleItem.findMany.mock.calls[0][0].where;
    expect(where.modelVersionId).toEqual({ in: [1] });
    expect(where.sale.endsAt.gt).toBeInstanceOf(Date);
    expect(where.sale.OR).toEqual([{ canceledAt: null }, { canceledAt: { gt: expect.any(Date) } }]);
  });

  it('never asks for sales on a TIMED early-access gate — sales are paid-access only', async () => {
    mockDb.paidAccess.findMany.mockResolvedValue([TIMED]);

    const out = await getPaidAccess('ModelVersion', [3]);

    // The gate type is mutable after a sale is authored, so this cannot be left to the authoring refusal.
    expect(mockDb.modelVersionSaleItem.findMany).not.toHaveBeenCalled();
    expect(out[3]?.sales).toEqual([]);
  });

  it('asks only about gated versions, and not at all when a batch is entirely free', async () => {
    mockDb.paidAccess.findMany.mockResolvedValue([PERMANENT]);

    await getPaidAccess('ModelVersion', [1, 404, 405]);

    expect(mockDb.modelVersionSaleItem.findMany.mock.calls[0][0].where.modelVersionId).toEqual({ in: [1] });

    vi.clearAllMocks();
    mockDb.paidAccess.findMany.mockResolvedValue([]);
    await getPaidAccess('ModelVersion', [500, 501]);
    expect(mockDb.modelVersionSaleItem.findMany).not.toHaveBeenCalled();
  });

  it('asks for no sales on a ComicChapter gate', async () => {
    mockDb.paidAccess.findMany.mockResolvedValue([{ ...PERMANENT, terms: { access: { price: 10 } } }]);

    await getPaidAccess('ComicChapter', [1]);

    expect(mockDb.modelVersionSaleItem.findMany).not.toHaveBeenCalled();
  });
});

describe('getSalesFor — a sale may only price its own author’s versions', () => {
  it('drops a sale whose author does not own the version it names', async () => {
    // Sales are authored in a different application. Without this re-check the main app would treat any
    // sale row as authoritative over any version id it names, and the only ownership guard would live
    // outside this codebase entirely.
    mockDb.paidAccess.findMany.mockResolvedValue([PERMANENT]);
    mockDb.modelVersionSaleItem.findMany.mockResolvedValue([saleRow(1, 11, 999)]);

    const out = await getPaidAccess('ModelVersion', [1]);

    expect(out[1]?.sales).toEqual([]);
  });

  it('keeps a sale authored by the version’s own owner', async () => {
    mockDb.paidAccess.findMany.mockResolvedValue([PERMANENT]);
    mockDb.modelVersionSaleItem.findMany.mockResolvedValue([saleRow(1, 11, PERMANENT.ownerId)]);

    const out = await getPaidAccess('ModelVersion', [1]);

    expect(out[1]?.sales?.map((s) => s.id)).toEqual([11]);
  });
});

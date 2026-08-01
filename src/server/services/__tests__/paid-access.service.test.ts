import { beforeEach, describe, expect, it, vi } from 'vitest';
import { increaseDate } from '~/utils/date-helpers';

const { mockDbWrite, mockBust, mockCacheFetch } = vi.hoisted(() => ({
  // Keyed by the cache's redis key so one stub can drive both the PaidAccess and cap-tier caches.
  mockCacheFetch: vi.fn(async (_key: string, _ids: number[]) => ({} as Record<string, unknown>)),
  mockDbWrite: {
    paidAccess: {
      deleteMany: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    modelVersion: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  },
  mockBust: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: mockDbWrite }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, xs: 60 } }));
vi.mock('~/server/redis/client', () => ({
  REDIS_KEYS: {
    CACHES: { PAID_ACCESS: 'test:paid-access', PAID_ACCESS_CAP_TIER: 'test:cap-tier' },
  },
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: ({ key }: { key: string }) => ({
    fetch: (ids: number[]) => mockCacheFetch(key, ids),
    bust: mockBust,
  }),
}));

import {
  assertPaidAccessInput,
  getViewerMonetization,
  materializePaidAccessEndsAt,
  toModelVersionPaidAccessDto,
  toPublicPaidAccessDto,
  writePaidAccessForModelVersion,
} from '~/server/services/paid-access.service';

const TERMS = { download: { price: 500 }, generation: { trialLimit: 5 } };
const PUBLISHED = new Date('2026-07-01T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.paidAccess.deleteMany.mockResolvedValue({ count: 0 });
  mockDbWrite.paidAccess.upsert.mockResolvedValue({});
  mockDbWrite.paidAccess.update.mockResolvedValue({});
  mockDbWrite.$executeRaw.mockResolvedValue(0);
});

describe('writePaidAccessForModelVersion — gate state machine', () => {
  it('NOT gated (null input): deletes the row, resets EarlyAccess->Public availability, and busts', async () => {
    await writePaidAccessForModelVersion(5, null);

    expect(mockDbWrite.paidAccess.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'ModelVersion', entityId: 5 },
    });
    // The availability reconciliation UPDATE — the fix that un-strands migrated EarlyAccess versions.
    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.paidAccess.upsert).not.toHaveBeenCalled();
    expect(mockBust).toHaveBeenCalledWith([5]);
  });

  it('NOT gated when input is present but has neither permanent nor a positive timeframe', async () => {
    await writePaidAccessForModelVersion(5, { timeframeDays: 0, terms: TERMS });
    expect(mockDbWrite.paidAccess.deleteMany).toHaveBeenCalled();
    expect(mockDbWrite.paidAccess.upsert).not.toHaveBeenCalled();
  });

  it('PERMANENT: endsAt null, timeframeDays null', async () => {
    await writePaidAccessForModelVersion(
      5,
      { permanent: true, terms: TERMS },
      { publishedAt: null, ownerId: 7 }
    );

    expect(mockDbWrite.paidAccess.upsert).toHaveBeenCalledTimes(1);
    const arg = mockDbWrite.paidAccess.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ endsAt: null, timeframeDays: null, ownerId: 7 });
    expect(arg.update).toMatchObject({ endsAt: null, timeframeDays: null });
  });

  it('TIMED + published: endsAt = publishedAt + timeframeDays, timeframeDays kept', async () => {
    await writePaidAccessForModelVersion(
      5,
      { timeframeDays: 7, terms: TERMS },
      { publishedAt: PUBLISHED, ownerId: 7 }
    );

    const arg = mockDbWrite.paidAccess.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({
      endsAt: increaseDate(PUBLISHED, 7, 'days'),
      timeframeDays: 7,
    });
  });

  it('TIMED + unpublished (publishedAt null): endsAt null (pending), timeframeDays kept', async () => {
    await writePaidAccessForModelVersion(
      5,
      { timeframeDays: 7, terms: TERMS },
      { publishedAt: null, ownerId: 7 }
    );

    const arg = mockDbWrite.paidAccess.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ endsAt: null, timeframeDays: 7 });
  });

  it('looks the version up for publishedAt/ownerId when opts omits them; no-ops on a missing version', async () => {
    mockDbWrite.modelVersion.findUnique.mockResolvedValueOnce(null);
    await writePaidAccessForModelVersion(5, { timeframeDays: 7, terms: TERMS });
    expect(mockDbWrite.modelVersion.findUnique).toHaveBeenCalled();
    expect(mockDbWrite.paidAccess.upsert).not.toHaveBeenCalled();
  });
});

describe('assertPaidAccessInput — a gated version must charge something purchasable', () => {
  it('no-op for null / non-gated input', () => {
    expect(() => assertPaidAccessInput(null)).not.toThrow();
    expect(() => assertPaidAccessInput({ timeframeDays: 0, terms: {} })).not.toThrow();
  });

  it('throws when gated but charges for nothing (no download, no paid generation)', () => {
    expect(() => assertPaidAccessInput({ timeframeDays: 7, terms: {} })).toThrow();
    expect(() =>
      assertPaidAccessInput({ timeframeDays: 7, terms: { generation: { free: true } } })
    ).toThrow();
  });

  it('throws for a priceless generation-only tier with no download fallback (would charge undefined Buzz)', () => {
    expect(() =>
      assertPaidAccessInput({ timeframeDays: 7, terms: { generation: { trialLimit: 5 } } })
    ).toThrow('A generation-only paid tier must set a price');
  });

  it('allows a download tier, a priced generation-only tier, or free generation alongside download', () => {
    expect(() =>
      assertPaidAccessInput({ timeframeDays: 7, terms: { download: { price: 500 } } })
    ).not.toThrow();
    expect(() =>
      assertPaidAccessInput({ timeframeDays: 7, terms: { generation: { price: 200 } } })
    ).not.toThrow();
    expect(() =>
      assertPaidAccessInput({
        permanent: true,
        terms: { download: { price: 500 }, generation: { free: true } },
      })
    ).not.toThrow();
  });
});

describe('materializePaidAccessEndsAt — publish-time materialization', () => {
  it('no row: no update', async () => {
    mockDbWrite.paidAccess.findUnique.mockResolvedValueOnce(null);
    await materializePaidAccessEndsAt(5, PUBLISHED);
    expect(mockDbWrite.paidAccess.update).not.toHaveBeenCalled();
  });

  it('permanent gate (timeframeDays null): no-op', async () => {
    mockDbWrite.paidAccess.findUnique.mockResolvedValueOnce({ timeframeDays: null, endsAt: null });
    await materializePaidAccessEndsAt(5, PUBLISHED);
    expect(mockDbWrite.paidAccess.update).not.toHaveBeenCalled();
  });

  it('tombstone (endsAt already in the past): SKIP — a republish must not re-gate an ended version', async () => {
    mockDbWrite.paidAccess.findUnique.mockResolvedValueOnce({
      timeframeDays: 7,
      endsAt: new Date('2000-01-01T00:00:00.000Z'),
    });
    await materializePaidAccessEndsAt(5, PUBLISHED);
    expect(mockDbWrite.paidAccess.update).not.toHaveBeenCalled();
  });

  it('pending (endsAt null) timed gate: materializes endsAt = publishedAt + timeframeDays', async () => {
    mockDbWrite.paidAccess.findUnique.mockResolvedValueOnce({ timeframeDays: 7, endsAt: null });
    await materializePaidAccessEndsAt(5, PUBLISHED);
    expect(mockDbWrite.paidAccess.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { endsAt: increaseDate(PUBLISHED, 7, 'days') } })
    );
  });
});

describe('toPublicPaidAccessDto — the v1 public API view', () => {
  const row = (over: Partial<Parameters<typeof toPublicPaidAccessDto>[0] & object>) =>
    ({ entityType: 'ModelVersion', entityId: 5, ownerId: 1, terms: TERMS, ...over } as NonNullable<
      Parameters<typeof toPublicPaidAccessDto>[0]
    >);

  it('ungated version (no row): null', () => {
    expect(toPublicPaidAccessDto(undefined)).toBeNull();
  });

  it('permanent gate: permanent=true with no deadline', () => {
    expect(toPublicPaidAccessDto(row({ endsAt: null, timeframeDays: null }))).toEqual({
      permanent: true,
      endsAt: null,
    });
  });

  it('active timed gate: permanent=false, carries the deadline', () => {
    const endsAt = increaseDate(new Date(), 3, 'days');
    expect(toPublicPaidAccessDto(row({ endsAt, timeframeDays: 7 }))).toEqual({
      permanent: false,
      endsAt,
    });
  });

  it('pending timed gate (unpublished, endsAt not yet materialized): gated, deadline null', () => {
    expect(toPublicPaidAccessDto(row({ endsAt: null, timeframeDays: 7 }))).toEqual({
      permanent: false,
      endsAt: null,
    });
  });

  it('expired timed gate (tombstone row): null — the version reads as ungated', () => {
    const endsAt = new Date('2000-01-01T00:00:00.000Z');
    expect(toPublicPaidAccessDto(row({ endsAt, timeframeDays: 7 }))).toBeNull();
  });

  it('never leaks terms (pricing stays with the purchase flow)', () => {
    const dto = toPublicPaidAccessDto(row({ endsAt: null, timeframeDays: null }));
    expect(dto).not.toHaveProperty('terms');
    expect(dto).not.toHaveProperty('ownerId');
  });
});

describe('getViewerMonetization — gate price and licensing fee capped as one', () => {
  const OWNER = 7;
  const FUTURE = new Date('2099-01-01T00:00:00.000Z');

  // Permanent (timeframeDays null) — the only kind with a price ceiling. A timed window is uncapped and
  // has its own tests below.
  const row = (over: Record<string, unknown> = {}) => ({
    entityId: 1,
    ownerId: OWNER,
    endsAtMs: FUTURE.getTime(),
    timeframeDays: null,
    terms: { download: { price: 5000 } },
    ...over,
  });

  const drive = (
    gates: Record<string, unknown>,
    tiers: Record<number, string | null> = { [OWNER]: null }
  ) =>
    mockCacheFetch.mockImplementation(async (key: string) =>
      key === 'test:cap-tier'
        ? Object.fromEntries(
            Object.entries(tiers).map(([id, tier]) => [id, { userId: Number(id), tier }])
          )
        : gates
    );

  it('lowers an over-cap gate price for a non-owner when the owner has lapsed', async () => {
    drive({ 1: row() });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 500 } });
  });

  it('leaves the OWNER the stored price — their editors write these terms back', async () => {
    drive({ 1: row() });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: OWNER } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 5000 } });
  });

  it('leaves a MODERATOR the stored price', async () => {
    drive({ 1: row() });

    const out = await getViewerMonetization({
      versions: [{ id: 1 }],
      viewer: { id: 2, isModerator: true },
    });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 5000 } });
  });

  it('leaves a price already under the cap alone', async () => {
    drive({ 1: row({ terms: { download: { price: 300 } } }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 300 } });
  });

  it('caps a paid generation tier and keeps trialLimit', async () => {
    drive({
      1: row({ terms: { download: { price: 5000 }, generation: { price: 2000, trialLimit: 5 } } }),
    });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({
      download: { price: 500 },
      generation: { price: 500, trialLimit: 5 },
    });
  });

  // A paid generation tier with no explicit price falls back to the download price at charge time, so
  // the display must NOT invent one — capping the download alone keeps the two in step.
  it('does not invent a generation price when the tier relies on the download fallback', async () => {
    drive({ 1: row({ terms: { download: { price: 5000 }, generation: { trialLimit: 5 } } }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({
      download: { price: 500 },
      generation: { trialLimit: 5 },
    });
  });

  it('never turns a free generation grant into a paid one', async () => {
    drive({ 1: row({ terms: { download: { price: 5000 }, generation: { free: true } } }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({
      download: { price: 500 },
      generation: { free: true },
    });
  });

  it('caps a generation-only gate without inventing a download tier', async () => {
    drive({ 1: row({ terms: { generation: { price: 3000, trialLimit: 10 } } }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ generation: { price: 500, trialLimit: 10 } });
    expect(out[1].paidAccess?.terms).not.toHaveProperty('download');
  });

  it('keeps a stored fee of 0 as 0 rather than null', async () => {
    drive({ 1: row() });

    const out = await getViewerMonetization({
      versions: [{ id: 1, ownerId: OWNER, licensingFee: 0, modelType: 'Checkpoint' }],
      viewer: { id: 2 },
    });

    expect(out[1].licensingFee).toBe(0);
  });

  it('caps the licensing fee against the same tier as the gate', async () => {
    drive({ 1: row() });

    const out = await getViewerMonetization({
      versions: [{ id: 1, ownerId: OWNER, licensingFee: 8, modelType: 'Checkpoint' }],
      viewer: { id: 2 },
    });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 500 } });
    expect(out[1].licensingFee).toBe(1); // free-tier checkpoint cap
  });

  it('caps a licensing fee on an UNGATED version when the owner is given', async () => {
    drive({});

    const out = await getViewerMonetization({
      versions: [{ id: 1, ownerId: OWNER, licensingFee: 8, modelType: 'Checkpoint' }],
      viewer: { id: 2 },
    });

    expect(out[1].paidAccess).toBeUndefined();
    expect(out[1].licensingFee).toBe(1);
  });

  it('resolves cap tiers in ONE batched fetch across distinct owners', async () => {
    drive(
      {
        1: row({ entityId: 1, ownerId: 8 }),
        2: row({ entityId: 2, ownerId: 8 }),
        3: row({ entityId: 3, ownerId: 9 }),
      },
      { 8: null, 9: null }
    );

    await getViewerMonetization({
      versions: [{ id: 1 }, { id: 2 }, { id: 3 }],
      viewer: { id: 2 },
    });

    const tierCalls = mockCacheFetch.mock.calls.filter(([key]) => key === 'test:cap-tier');
    expect(tierCalls).toHaveLength(1);
    expect(tierCalls[0][1]).toEqual([8, 9]);
  });

  it('runs NO cap-tier fetch when nothing is chargeable', async () => {
    drive({ 1: row({ terms: { generation: { free: true } } }) });

    await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(mockCacheFetch.mock.calls.filter(([key]) => key === 'test:cap-tier')).toHaveLength(0);
  });
});

describe('getViewerMonetization — an unset gate/fee is never invented', () => {
  const drive = () =>
    mockCacheFetch.mockImplementation(async (key: string) =>
      key === 'test:cap-tier' ? { 7: { userId: 7, tier: null } } : {}
    );

  it('no gate and no fee: nothing charged, and no cap tier is even resolved', async () => {
    drive();

    const out = await getViewerMonetization({
      versions: [{ id: 1, ownerId: 7 }],
      viewer: { id: 2 },
    });

    expect(out[1]).toEqual({ paidAccess: undefined, licensingFee: null });
    expect(mockCacheFetch.mock.calls.filter(([key]) => key === 'test:cap-tier')).toHaveLength(0);
  });

  it('a null fee stays null rather than falling back to the free-tier cap', async () => {
    drive();

    const out = await getViewerMonetization({
      versions: [{ id: 1, ownerId: 7, licensingFee: null, modelType: 'Checkpoint' }],
      viewer: { id: 2 },
    });

    expect(out[1].licensingFee).toBeNull();
  });
});

describe('getViewerMonetization — the price ceiling is permanent-only', () => {
  const OWNER = 7;
  const drive = (gates: Record<string, unknown>) =>
    mockCacheFetch.mockImplementation(async (key: string) =>
      key === 'test:cap-tier' ? { [OWNER]: { userId: OWNER, tier: null } } : gates
    );
  const row = (over: Record<string, unknown>) => ({
    entityId: 1,
    ownerId: OWNER,
    endsAtMs: new Date('2099-01-01T00:00:00.000Z').getTime(),
    terms: { download: { price: 5000 } },
    ...over,
  });

  it('lowers an over-cap PERMANENT gate to the tier ceiling', async () => {
    drive({ 1: row({ timeframeDays: null }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 500 } });
  });

  it('leaves a TIMED early-access window at its stored price', async () => {
    drive({ 1: row({ timeframeDays: 7 }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 5000 } });
  });

  it('still caps the licensing fee on a timed gate — it is charged per generation, not per window', async () => {
    drive({ 1: row({ timeframeDays: 7 }) });

    const out = await getViewerMonetization({
      versions: [{ id: 1, ownerId: OWNER, licensingFee: 8, modelType: 'Checkpoint' }],
      viewer: { id: 2 },
    });

    expect(out[1].licensingFee).toBe(1);
  });
});

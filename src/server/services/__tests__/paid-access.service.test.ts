import { beforeEach, describe, expect, it, vi } from 'vitest';
import { increaseDate } from '~/utils/date-helpers';

const { mockDbWrite, mockBust } = vi.hoisted(() => ({
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
vi.mock('~/server/redis/client', () => ({ REDIS_KEYS: { CACHES: { PAID_ACCESS: 'test:paid-access' } } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: () => ({ fetch: vi.fn(), bust: mockBust }),
}));

import {
  assertPaidAccessInput,
  materializePaidAccessEndsAt,
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

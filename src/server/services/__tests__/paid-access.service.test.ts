import { beforeEach, describe, expect, it, vi } from 'vitest';
import { increaseDate } from '~/utils/date-helpers';

const { mockBust, mockCacheFetch } = vi.hoisted(() => ({
  mockCacheFetch: vi.fn(async (_key: string, _ids: number[]) => ({} as Record<string, unknown>)),
  mockBust: vi.fn(),
}));

vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, xs: 60 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: ({ key }: { key: string }) => ({
    fetch: (ids: number[]) => mockCacheFetch(key, ids),
    bust: mockBust,
  }),
}));

import {
  assertMonetizationWrite,
  assertPaidAccessInput,
  getViewerMonetization,
  materializePaidAccessEndsAt,
  toModelVersionPaidAccessDto,
  toPublicPaidAccessDto,
  writePaidAccessForModelVersion,
} from '~/server/services/paid-access.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { REDIS_KEYS } from '~/server/redis/client';

const mockDbWrite = dbMock.dbWrite;

// Stubbed at the DB layer rather than by mocking pricing-slot.service: assertPricingAllowed reaches
// countPricingSlotsThisMonth through a module-local binding a module mock cannot intercept, so the
// rules under test — the floor, the allowance arithmetic, the already-priced exemption — are real.
const mockSlotCount = dbMock.dbRead.pricingSlot.count;

const PAID_ACCESS_KEY = `${REDIS_KEYS.CACHES.PAID_ACCESS}:ModelVersion`;

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
  it('NOT gated (null input): deletes the row and busts, leaving availability alone', async () => {
    await writePaidAccessForModelVersion(5, null);

    expect(mockDbWrite.paidAccess.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'ModelVersion', entityId: 5 },
    });
    // Gating is decoupled from `availability`; clearing a gate must not rewrite the creator's setting.
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
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

describe('getViewerMonetization — the stored price is the charged price', () => {
  const OWNER = 7;
  const FUTURE = new Date('2099-01-01T00:00:00.000Z');
  const row = (over: Record<string, unknown> = {}) => ({
    entityId: 1,
    ownerId: OWNER,
    endsAtMs: FUTURE.getTime(),
    timeframeDays: null,
    terms: { download: { price: 5000 } },
    ...over,
  });
  const drive = (gates: Record<string, unknown>) =>
    mockCacheFetch.mockImplementation(async () => gates);

  it('quotes a permanent gate at its stored price — nothing clamps it any more', async () => {
    drive({ 1: row() });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 5000 } });
  });

  it('quotes a timed early-access window the same way', async () => {
    drive({ 1: row({ timeframeDays: 7 }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 5000 } });
  });

  it('returns the stored licensing fee untouched', async () => {
    drive({ 1: row() });

    const out = await getViewerMonetization({
      versions: [{ id: 1, licensingFee: 8 }],
      viewer: { id: 2 },
    });

    expect(out[1].licensingFee).toBe(8);
  });

  // A reintroduced clamp would show up here as a second cache key being fetched.
  it('resolves no subscription tier at all — one cache, the gate rows', async () => {
    drive({ 1: row() });

    await getViewerMonetization({ versions: [{ id: 1, licensingFee: 8 }], viewer: { id: 2 } });

    const keys = new Set(mockCacheFetch.mock.calls.map(([key]) => key));
    expect([...keys]).toEqual([PAID_ACCESS_KEY]);
  });
});

describe('getViewerMonetization — an unset gate/fee is never invented', () => {
  const drive = () => mockCacheFetch.mockImplementation(async () => ({}));

  it('no gate and no fee: nothing charged', async () => {
    drive();

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1]).toEqual({ paidAccess: undefined, sale: null, licensingFee: null });
  });

  it('a null fee stays null rather than becoming 0', async () => {
    drive();

    const out = await getViewerMonetization({
      versions: [{ id: 1, licensingFee: null }],
      viewer: { id: 2 },
    });

    expect(out[1].licensingFee).toBeNull();
  });
});

// The write gate. Each rule is exercised against a version with NO existing price, since that is the
// only case either rule applies to — the "editing is always free" direction is at the end, and is the
// property that grandfathers everything priced before these rules existed.
describe('assertMonetizationWrite', () => {
  const ELIGIBLE = { scores: { models: 50000 } };

  beforeEach(() => {
    mockCacheFetch.mockImplementation(async () => ({}));
    mockSlotCount.mockResolvedValue(0);
  });

  it('rejects a fee above the flat ceiling', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        licensingFee: 101,
        storedLicensingFee: 0,
        tier: 'gold',
        userMeta: ELIGIBLE,
      })
    ).rejects.toThrow(/at most 100 Buzz/);
  });

  it('allows 500 on a video model — the ceiling is 5x there', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        licensingFee: 500,
        storedLicensingFee: 0,
        tier: 'free',
        userMeta: ELIGIBLE,
        baseModel: 'Hunyuan Video',
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
  });

  it('does not check a paid-access price at all — it is uncapped', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: { permanent: true, terms: { download: { price: 10_000_000 } } } as never,
        tier: 'free',
        userMeta: ELIGIBLE,
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
  });

  it('refuses a creator below the eligibility floor', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: { permanent: true, terms: {} } as never,
        tier: 'gold',
        userMeta: { scores: { models: 9999 } },
      })
    ).rejects.toThrow(/creator score of 10,000/);
  });

  it('refuses once the monthly allowance is spent', async () => {
    mockSlotCount.mockResolvedValue(3);
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: { permanent: true, terms: {} } as never,
        tier: 'free',
        userMeta: ELIGIBLE,
      })
    ).rejects.toThrow(/monetized 3 of 3 model versions this month/);
  });

  it('never blocks gold — its allowance is unlimited, so no count is even read', async () => {
    mockSlotCount.mockResolvedValue(9999);
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: { permanent: true, terms: {} } as never,
        tier: 'gold',
        userMeta: ELIGIBLE,
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
    expect(mockSlotCount).not.toHaveBeenCalled();
  });

  // Deliberate, and the opposite of every other creator-score gate: the floor is a statement about who
  // may sell, not a permission level. A moderator exemption here would be a silent bypass of both rules.
  it('does NOT exempt moderators from the floor or the allowance', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        isModerator: true,
        paidAccess: { permanent: true, terms: {} } as never,
        tier: 'free',
        userMeta: { scores: { models: 100 } },
      })
    ).rejects.toThrow(/creator score/);
  });

  it('exempts a moderator from the FEE CEILING only', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        isModerator: true,
        paidAccess: null,
        licensingFee: 5000,
        storedLicensingFee: 10,
        tier: 'free',
        userMeta: ELIGIBLE,
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
  });

  // The gate lookup feeds BOTH wasPriced and the willBePriced fallback.
  describe('the existing permanent gate makes a version already-priced', () => {
    // The write gate reads PaidAccess fresh from the primary: an hour-old cache would disagree with
    // the caller's live fee read about whether the version is already priced.
    const gateRow = (timeframeDays: number | null) =>
      mockDbWrite.paidAccess.findUnique.mockResolvedValue({ timeframeDays } as never);
    const noGate = () => mockDbWrite.paidAccess.findUnique.mockResolvedValue(null as never);

    it('lets a below-floor owner add a fee to a version they already gate, at no cost', async () => {
      gateRow(null);
      mockSlotCount.mockResolvedValue(99);

      await expect(
        assertMonetizationWrite({
          ownerId: 1,
          versionId: 1,
          paidAccess: null,
          licensingFee: 5,
          storedLicensingFee: 0,
          tier: 'free',
          userMeta: { scores: { models: 0 } },
        })
      ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
    });

    // Re-pricing the gate itself, which is what a creator does most often. The gate row is what makes
    // the version already-priced, so the new terms are irrelevant to both rules.
    it('lets a below-floor owner change the PRICE of a gate they already have, at no cost', async () => {
      gateRow(null);
      mockSlotCount.mockResolvedValue(99);

      await expect(
        assertMonetizationWrite({
          ownerId: 1,
          versionId: 1,
          paidAccess: {
            permanent: true,
            terms: { download: { price: 99999 } },
          } as never,
          tier: 'free',
          userMeta: { scores: { models: 0 } },
        })
      ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
    });

    // The negative control: without it the test above passes for the wrong reason, since a lookup that
    // returns nothing at all also produces spendsSlot on the same inputs.
    it('charges for the same write when no gate row exists', async () => {
      noGate();

      await expect(
        assertMonetizationWrite({
          ownerId: 1,
          versionId: 1,
          paidAccess: null,
          licensingFee: 5,
          storedLicensingFee: 0,
          tier: 'free',
          userMeta: { scores: { models: 50000 } },
        })
      ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
    });

    // A timed window is not a price, so it must not confer the exemption.
    it('does not treat a TIMED window as already-priced', async () => {
      gateRow(7);

      await expect(
        assertMonetizationWrite({
          ownerId: 1,
          versionId: 1,
          paidAccess: null,
          licensingFee: 5,
          storedLicensingFee: 0,
          tier: 'free',
          userMeta: { scores: { models: 0 } },
        })
      ).rejects.toThrow(/creator score/);
    });

    // A fee-only edit on an already-gated version leaves it gated: willBePriced falls back to the row.
    it('keeps a gated version priced when the write clears its fee', async () => {
      gateRow(null);

      await expect(
        assertMonetizationWrite({
          ownerId: 1,
          versionId: 1,
          paidAccess: undefined,
          licensingFee: 0,
          storedLicensingFee: 5,
          tier: 'free',
          userMeta: { scores: { models: 0 } },
        })
      ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
    });
  });

  // Moving to a stricter media axis is not a raise by the numbers, but it does put the fee over the
  // ceiling that will apply — and nothing clamps at charge time any more.
  it('refuses an untouched video-ceiling fee when the write switches to an image base model', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        licensingFee: 500,
        storedLicensingFee: 500,
        tier: 'gold',
        userMeta: { scores: { models: 50000 } },
        baseModel: 'SDXL 1.0',
        storedBaseModel: 'Hunyuan Video',
      })
    ).rejects.toThrow(/at most 100 Buzz per generation on this base model/);
  });

  // The upsert treats an absent fee as unchanged, so a write that moves only the base model has to
  // face the same ceiling — otherwise it is the way around the check above.
  it('refuses the same move when the write omits the fee entirely', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        licensingFee: undefined,
        storedLicensingFee: 500,
        tier: 'gold',
        userMeta: { scores: { models: 50000 } },
        baseModel: 'SDXL 1.0',
        storedBaseModel: 'Hunyuan Video',
      })
    ).rejects.toThrow(/at most 100 Buzz per generation on this base model/);
  });

  it('still allows re-saving that fee while the version stays on a video base model', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        licensingFee: 500,
        storedLicensingFee: 500,
        tier: 'gold',
        userMeta: { scores: { models: 50000 } },
        baseModel: 'Hunyuan Video',
        storedBaseModel: 'Hunyuan Video',
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
  });

  // Named after what it claims: the floor test below fails at the floor and never reaches the allowance.
  it('does not exempt moderators from the ALLOWANCE either', async () => {
    mockSlotCount.mockResolvedValue(3);
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        isModerator: true,
        paidAccess: { permanent: true, terms: {} } as never,
        tier: 'free',
        userMeta: { scores: { models: 50000 } },
      })
    ).rejects.toThrow(/3 of 3/);
  });

  // The grandfathering rule, and the reason no backfill is needed: a version that already carries a
  // price is exempt from both rules and spends nothing, however far below the floor its owner is.
  it('lets a below-floor creator edit a price they already charge, at no cost', async () => {
    mockSlotCount.mockResolvedValue(99);
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        licensingFee: 5,
        storedLicensingFee: 2,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
  });

  it('treats an absent licensingFee as unchanged, not cleared', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        storedLicensingFee: 2,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
  });

  it('spends nothing when the write leaves the version unpriced', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        licensingFee: 0,
        storedLicensingFee: 0,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
  });

  // The other half of the ledger: taking the last price off offers the slot back. Offered, not given —
  // releasePricingSlot still has to find nothing transacted against the version.
  it('offers the slot back when the write clears the only price', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: null,
        licensingFee: 0,
        storedLicensingFee: 5,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: true });
  });

  // Clearing ONE of two prices is not clearing the price: the version still charges. `undefined`
  // leaves the gate alone — null would be asking to clear it as well, and does.
  it('offers nothing back while the other kind of price still stands', async () => {
    mockDbWrite.paidAccess.findUnique.mockResolvedValue({ timeframeDays: null } as never);

    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        versionId: 1,
        paidAccess: undefined,
        licensingFee: 0,
        storedLicensingFee: 5,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
  });

  // null is the explicit clear, and it has to reach the ledger as one: removing the gate from a version
  // whose only price it was returns the slot.
  it('offers the slot back when a null gate clears the only price', async () => {
    mockDbWrite.paidAccess.findUnique.mockResolvedValue({ timeframeDays: null } as never);

    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        versionId: 1,
        paidAccess: null,
        storedLicensingFee: 0,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: true });
  });

  // A timed window is not a price: it prices itself out when the window closes.
  it('does not spend a slot on a timed early-access window', async () => {
    await expect(
      assertMonetizationWrite({
        ownerId: 1,
        paidAccess: { permanent: false, timeframeDays: 7, terms: {} } as never,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
  });
});

describe('getViewerMonetization — a scheduled sale on top of the gate price', () => {
  const OWNER = 7;
  const FUTURE = new Date('2099-01-01T00:00:00.000Z');
  const PAST = new Date('2020-01-01T00:00:00.000Z');

  const sale = (over: Record<string, unknown> = {}) => ({
    id: 1,
    discountType: 'Percent',
    discountAmount: 20,
    startsAtMs: PAST.getTime(),
    endsAtMs: FUTURE.getTime(),
    canceledAtMs: null,
    ...over,
  });

  const row = (over: Record<string, unknown> = {}) => ({
    entityId: 1,
    ownerId: OWNER,
    endsAtMs: FUTURE.getTime(),
    timeframeDays: null,
    terms: { download: { price: 1000 } },
    sales: [],
    ...over,
  });

  const drive = (
    gates: Record<string, unknown>,
    tiers: Record<number, string | null> = { [OWNER]: 'gold' }
  ) =>
    mockCacheFetch.mockImplementation(async (key: string) =>
      key === 'test:cap-tier'
        ? Object.fromEntries(
            Object.entries(tiers).map(([id, tier]) => [id, { userId: Number(id), tier }])
          )
        : gates
    );

  it('discounts the price a buyer is shown', async () => {
    drive({ 1: row({ sales: [sale()] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 800 } });
  });

  // Nothing sits between the creator's number and the buyer's any more — the tier ceiling this used to
  // compose over was removed, so the discount comes off the stored price whatever the owner's tier.
  it('takes the sale off the stored price, whatever the owner tier', async () => {
    drive({ 1: row({ terms: { download: { price: 5000 } }, sales: [sale()] }) }, { [OWNER]: null });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 4000 } });
  });

  // The viewer still matters, but only for the sale: an owner's editor resubmits what it is shown, so
  // a discounted price written back would make the sale permanent.
  it('shows the OWNER the stored price, and the sale separately', async () => {
    drive({ 1: row({ terms: { download: { price: 1000 } }, sales: [sale()] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: OWNER } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 1000 } });
    expect(out[1].sale?.buyerTerms).toEqual({ download: { price: 800 } });
  });

  it('ignores a sale that has been cancelled, even while its window is still open', async () => {
    drive({ 1: row({ sales: [sale({ canceledAtMs: PAST.getTime() })] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 1000 } });
  });

  it('ignores a sale whose window has not opened yet', async () => {
    drive({ 1: row({ sales: [sale({ startsAtMs: FUTURE.getTime() })] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 1000 } });
  });

  it('leaves the OWNER the undiscounted stored price, as with the cap', async () => {
    drive({ 1: row({ sales: [sale()] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: OWNER } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 1000 } });
  });
});

describe('getViewerMonetization — what the UI is told about a sale', () => {
  const OWNER = 7;
  const FUTURE = new Date('2099-01-01T00:00:00.000Z');
  const PAST = new Date('2020-01-01T00:00:00.000Z');

  const sale = (over: Record<string, unknown> = {}) => ({
    id: 1,
    discountType: 'Percent',
    discountAmount: 20,
    startsAtMs: PAST.getTime(),
    endsAtMs: FUTURE.getTime(),
    canceledAtMs: null,
    ...over,
  });

  const row = (over: Record<string, unknown> = {}) => ({
    entityId: 1,
    ownerId: OWNER,
    endsAtMs: FUTURE.getTime(),
    timeframeDays: null,
    terms: { download: { price: 1000 } },
    sales: [],
    ...over,
  });

  const drive = (gates: Record<string, unknown>, tier: string | null = 'gold') =>
    mockCacheFetch.mockImplementation(async (key: string) =>
      key === 'test:cap-tier' ? { [OWNER]: { userId: OWNER, tier } } : gates
    );

  it('reports the pre-sale price and the end date, so the UI never recomputes the discount', async () => {
    drive({ 1: row({ sales: [sale()] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 800 } });
    expect(out[1].sale?.listTerms).toEqual({ download: { price: 1000 } });
    expect(out[1].sale?.buyerTerms).toEqual({ download: { price: 800 } });
    expect(out[1].sale?.endsAt).toEqual(FUTURE);
    // The discount travels with the sale so a badge can say "20% off" without deriving it client-side.
    expect(out[1].sale?.discountType).toBe('Percent');
    expect(out[1].sale?.discountAmount).toBe(20);
  });

  it('tells the OWNER about their own sale, while still quoting them the stored price', async () => {
    // Their editors write the stored terms back, so those must not be discounted — but suppressing the
    // sale entirely made a creator's own model page the one place their live sale was invisible.
    drive({ 1: row({ sales: [sale()] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: OWNER } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 1000 } });
    expect(out[1].sale?.discountType).toBe('Percent');
    expect(out[1].sale?.discountAmount).toBe(20);
    expect(out[1].sale?.endsAt).toEqual(FUTURE);
    // And the buyer price, or the owner is shown a page of stored prices with a banner claiming a
    // discount whose actual number appears nowhere.
    expect(out[1].sale?.buyerTerms).toEqual({ download: { price: 800 } });
  });

  it('reports no sale when there is none', async () => {
    drive({ 1: row() });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].sale).toBeNull();
  });

  it('reports a sale on a GENERATION-ONLY gate, which has no download price at all', async () => {
    // Every other fixture here has a download tier. A review found that both branches decided "is there
    // a sale" from the download price alone, so a gen-only gate reported NO sale to anyone while the
    // charge discounted it — and the card badged it, promising what the page then denied.
    drive({ 1: row({ terms: { generation: { price: 1000, trialLimit: 5 } }, sales: [sale()] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ generation: { price: 800, trialLimit: 5 } });
    expect(out[1].sale?.discountAmount).toBe(20);
    expect(out[1].sale?.buyerTerms).toEqual({ generation: { price: 800, trialLimit: 5 } });
  });

  it('still reports nothing on a gen-only gate when no sale is running', async () => {
    drive({ 1: row({ terms: { generation: { price: 1000, trialLimit: 5 } } }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].sale).toBeNull();
    expect(out[1].paidAccess?.terms).toEqual({ generation: { price: 1000, trialLimit: 5 } });
  });

  it('reports no sale when the discount rounds away to nothing', async () => {
    // 1% of 50 floors to 0. Drawing a strikethrough over an unchanged number would read as a broken page.
    drive({ 1: row({ terms: { download: { price: 50 } }, sales: [sale({ discountAmount: 1 })] }) });

    const out = await getViewerMonetization({ versions: [{ id: 1 }], viewer: { id: 2 } });

    expect(out[1].paidAccess?.terms).toEqual({ download: { price: 50 } });
    expect(out[1].sale).toBeNull();
  });
});

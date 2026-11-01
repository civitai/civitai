import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockChQuery } = vi.hoisted(() => ({ mockChQuery: vi.fn(async () => [] as unknown[]) }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: (strings: TemplateStringsArray, ...values: unknown[]) => mockChQuery(strings, values),
  },
}));

import { MONETIZATION_MIN_CREATOR_SCORE } from '@civitai/buzz';
import {
  assertPricingAllowed,
  countPricingSlotsThisMonth,
  listPricingSlots,
  recordPricingSlot,
  releasePricingSlot,
} from '~/server/services/pricing-slot.service';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

const mockCount = dbMock.dbRead.pricingSlot.count;
const mockPrimaryCount = dbMock.dbWrite.pricingSlot.count;
const mockCreateMany = dbMock.dbWrite.pricingSlot.createMany;
const mockFindUnique = dbMock.dbRead.user.findUnique;
const mockDeleteMany = dbMock.dbWrite.pricingSlot.deleteMany;
// Publish state and access rows are not touched by the price write, so they stay on the replica.
const mockVersion = dbMock.dbRead.modelVersion.findUnique;
const mockAccessCount = dbMock.dbRead.entityAccess.count;
const mockMetric = dbMock.dbRead.modelVersionMetric.findUnique;
// The post-write re-reads: a lagging replica here refuses a release and silently eats the slot.
const mockSlot = dbMock.dbWrite.pricingSlot.findUnique;
const mockFee = dbMock.dbWrite.modelVersion.findUnique;
const mockGate = dbMock.dbWrite.paidAccess.findUnique;

const OWNER = 42;
const VERSION = 9;
const SLOT_CREATED = new Date('2026-08-20T00:00:00.000Z');

/** The releasable case: unpriced, unpublished, unsold, unearned. Each test spoils one thing. */
function seedReleasable() {
  mockSlot.mockResolvedValue({ createdAt: SLOT_CREATED, ownerId: OWNER } as never);
  mockChQuery.mockResolvedValue([] as never);
  mockFee.mockResolvedValue({ licensingFee: null } as never);
  mockVersion.mockResolvedValue({
    initialPublishedAt: null,
    publishedAt: null,
  } as never);
  mockGate.mockResolvedValue(null as never);
  mockAccessCount.mockResolvedValue(0 as never);
  mockMetric.mockResolvedValue({ earnedAmount: 0 } as never);
  mockDeleteMany.mockResolvedValue({ count: 1 } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChQuery.mockResolvedValue([] as never);
  mockCount.mockResolvedValue(0 as never);
  mockCreateMany.mockResolvedValue({ count: 1 } as never);
});

describe('releasePricingSlot', () => {
  const release = () =>
    releasePricingSlot({ entityType: 'ModelVersion', entityId: VERSION, ownerId: OWNER });

  it('returns the slot for a version nobody ever transacted against', async () => {
    seedReleasable();

    await expect(release()).resolves.toBe(true);
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { entityType: 'ModelVersion', entityId: VERSION, ownerId: OWNER },
    });
    // The owner's own access row is not a sale. Asserted on the ARGS, because stubbing only the count
    // lets the `not: ownerId` exclusion be deleted with every test still green — and then any
    // owner-held row makes the version look sold and the slot is never returned.
    expect(mockAccessCount).toHaveBeenCalledWith({
      where: { accessToId: VERSION, accessToType: 'ModelVersion', accessorId: { not: OWNER } },
    });
  });

  // The slot's own createdAt bounds the charge lookup, so a fee earned BEFORE the owner priced the
  // version does not hold the slot it never paid for.
  it('asks only about charges made since the slot was spent', async () => {
    seedReleasable();
    mockVersion.mockResolvedValue({
      initialPublishedAt: new Date('2026-01-01'),
      publishedAt: null,
    } as never);

    await release();

    expect(mockChQuery).toHaveBeenCalledTimes(1);
    // Asserted on the emitted SQL and the values POSITIONALLY, not with toContain: a position-blind
    // check passes when the two interpolations are swapped, and says nothing about the two literal
    // predicates. Without the version bound the query asks "has ANYONE been charged since this date",
    // which is true on prod essentially always — so every release would be refused.
    const [strings, values] = mockChQuery.mock.calls[0] as [string[], unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain('date >= toDate(');
    expect(sql).toContain('modelVersionId = ');
    expect(sql).toContain("source = 'licenseFee'");
    expect(values).toEqual([SLOT_CREATED, VERSION]);
  });

  it('refuses when a fee was charged since the slot was spent', async () => {
    seedReleasable();
    mockVersion.mockResolvedValue({
      initialPublishedAt: new Date('2026-01-01'),
      publishedAt: null,
    } as never);
    mockChQuery.mockResolvedValue([{ charged: 1 }] as never);

    await expect(release()).resolves.toBe(false);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  // ClickHouse answering is what makes the daily mirror unnecessary; consulting both would let a
  // stale all-time total veto a live answer.
  it('does not consult the daily mirror when ClickHouse answered', async () => {
    seedReleasable();
    mockVersion.mockResolvedValue({
      initialPublishedAt: new Date('2026-01-01'),
      publishedAt: null,
    } as never);

    await expect(release()).resolves.toBe(true);
    expect(mockMetric).not.toHaveBeenCalled();
  });

  // The lookup sits on a creator's save and the client's own timeout is 300s, so a stalled ClickHouse
  // must not hold the save open. Uses fake timers: a real 3s wait would make this the slowest test here.
  it('gives up on a hung ClickHouse and falls back', async () => {
    vi.useFakeTimers();
    try {
      seedReleasable();
      mockVersion.mockResolvedValue({
        licensingFee: null,
        initialPublishedAt: new Date('2026-01-01'),
        publishedAt: null,
      } as never);
      mockChQuery.mockReturnValue(new Promise(() => undefined) as never);
      mockMetric.mockResolvedValue({ earnedAmount: 5 } as never);

      const pending = release();
      await vi.advanceTimersByTimeAsync(3000);

      await expect(pending).resolves.toBe(false);
      expect(mockMetric).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Fails soft, not open: an unavailable ClickHouse drops back to the day-behind mirror.
  it('falls back to the earnings mirror when ClickHouse throws', async () => {
    seedReleasable();
    mockVersion.mockResolvedValue({
      initialPublishedAt: new Date('2026-01-01'),
      publishedAt: null,
    } as never);
    mockChQuery.mockRejectedValue(new Error('clickhouse down') as never);
    mockMetric.mockResolvedValue({ earnedAmount: 5 } as never);

    await expect(release()).resolves.toBe(false);
    expect(mockMetric).toHaveBeenCalled();
  });

  it('refuses when the slot row is gone', async () => {
    seedReleasable();
    mockSlot.mockResolvedValue(null as never);

    await expect(release()).resolves.toBe(false);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  // The slot belongs to whoever spent it; a transferred model must not let the new owner reclaim it.
  it('refuses when the slot belongs to someone else', async () => {
    seedReleasable();
    mockSlot.mockResolvedValue({ createdAt: SLOT_CREATED, ownerId: 999 } as never);

    await expect(release()).resolves.toBe(false);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('scopes the delete to the owner, so a transferred slot is not theirs to return', async () => {
    seedReleasable();
    await release();

    expect(mockDeleteMany.mock.calls[0][0].where.ownerId).toBe(OWNER);
  });

  // Throwing would not preserve the slot: this runs after the write that cleared the price, so the
  // retry sees an unpriced version, computes releasesSlot false, and never calls this again. A throw
  // costs the creator the slot AND reports a failed save for a write that landed.
  it('swallows a database failure rather than failing the save it runs after', async () => {
    seedReleasable();
    mockSlot.mockRejectedValue(new Error('relation "PricingSlot" does not exist'));

    await expect(release()).resolves.toBe(false);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('swallows a failure from the delete itself', async () => {
    seedReleasable();
    mockDeleteMany.mockRejectedValue(new Error('connection terminated'));

    await expect(release()).resolves.toBe(false);
  });

  describe('refuses, leaving the slot spent', () => {
    // Re-read post-write rather than trusting the caller: the version may still carry the OTHER price.
    it('when a licensing fee is still set', async () => {
      seedReleasable();
      mockFee.mockResolvedValue({ licensingFee: 5 } as never);

      await expect(release()).resolves.toBe(false);
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    it('when a permanent gate is still set', async () => {
      seedReleasable();
      mockGate.mockResolvedValue({ timeframeDays: null } as never);

      await expect(release()).resolves.toBe(false);
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    // A timed window is not a price, so it must not hold the slot hostage.
    it('but NOT for a timed early-access window, which is not a price', async () => {
      seedReleasable();
      mockGate.mockResolvedValue({ timeframeDays: 7 } as never);

      await expect(release()).resolves.toBe(true);
    });

    it('when someone else holds access to it', async () => {
      seedReleasable();
      mockAccessCount.mockResolvedValue(1 as never);

      await expect(release()).resolves.toBe(false);
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    // `earnedAmount` is all-time, so it says a version earned SOMETHING, not that it earned while
    // priced. ClickHouse answers the scoped question, and a lifetime total must not override it —
    // otherwise a long-popular version could never recover a slot it was priced with for an hour.
    it('but NOT on a lifetime total when nothing was charged since the slot', async () => {
      seedReleasable();
      mockVersion.mockResolvedValue({
        initialPublishedAt: new Date('2026-01-01'),
        publishedAt: new Date('2026-01-01'),
      } as never);
      mockMetric.mockResolvedValue({ earnedAmount: 500_000 } as never);

      await expect(release()).resolves.toBe(true);
    });

    // Fails closed: a version that cannot be read cannot be shown to be untransacted.
    it('when the version cannot be read at all', async () => {
      seedReleasable();
      mockFee.mockResolvedValue(null as never);

      await expect(release()).resolves.toBe(false);
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    // ComicChapter shares the ledger but has no transaction check written for it yet.
    it('for an entity kind whose transactions this cannot check', async () => {
      seedReleasable();

      await expect(
        releasePricingSlot({ entityType: 'ComicChapter', entityId: VERSION, ownerId: OWNER })
      ).resolves.toBe(false);
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });
  });

  // No buyer could reach an unpublished version and no generation could charge for it, so neither fee
  // source is consulted — the one answer here with no staleness in it.
  it('asks nothing about charges for a version that was never published', async () => {
    seedReleasable();

    await expect(release()).resolves.toBe(true);
    expect(mockChQuery).not.toHaveBeenCalled();
    expect(mockMetric).not.toHaveBeenCalled();
  });
});

describe('countPricingSlotsThisMonth', () => {
  // afterEach, not a trailing call: a failed assertion would otherwise leak frozen time into every
  // later test in the file and turn one legible failure into a cascade.
  afterEach(() => vi.useRealTimers());

  it('counts from the first of the current UTC month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T13:00:00.000Z'));

    await countPricingSlotsThisMonth(42);

    expect(mockCount).toHaveBeenCalledWith({
      where: { ownerId: 42, createdAt: { gte: new Date('2026-08-01T00:00:00.000Z') } },
    });
  });
});

describe('recordPricingSlot', () => {
  it('inserts with skipDuplicates so a second application costs nothing', async () => {
    await recordPricingSlot({ entityType: 'ModelVersion', entityId: 9, ownerId: 42 });

    expect(mockCreateMany).toHaveBeenCalledWith({
      data: [{ entityType: 'ModelVersion', entityId: 9, ownerId: 42 }],
      skipDuplicates: true,
    });
  });

  // The slot has to join the transaction it accompanies, or a rolled-back write leaves it spent.
  it('writes through a passed transaction client, not the default one', async () => {
    const tx = { pricingSlot: { createMany: vi.fn(async () => ({ count: 1 })) } };

    await recordPricingSlot({ entityType: 'ModelVersion', entityId: 9, ownerId: 42 }, tx as never);

    expect(tx.pricingSlot.createMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });
});

describe('assertPricingAllowed', () => {
  const eligible = { scores: { total: MONETIZATION_MIN_CREATOR_SCORE } };

  it('spends a slot for a newly priced version', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: 'free',
        userMeta: eligible,
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
  });

  it('is a no-op when the version was already priced', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: true,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: 'free',
        userMeta: { scores: { total: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('is a no-op when the write leaves it unpriced', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: false,
        addsGate: false,
        hadGate: false,
        tier: 'free',
        userMeta: { scores: { total: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
  });

  // Clearing the LAST price is the only shape that offers a slot back — and it is offered, not given:
  // releasePricingSlot still has to find nothing transacted against the version.
  it('offers the slot back when the write removes the last price', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: true,
        willBePriced: false,
        addsGate: false,
        hadGate: false,
        tier: 'free',
        userMeta: { scores: { total: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false, releasesSlot: true });
    // Neither rule is consulted: a creator below the floor may always stop charging.
    expect(mockCount).not.toHaveBeenCalled();
  });

  // Every production caller passes a THUNK, not a string — the controller and the REST endpoint both
  // defer the tier lookup so it only runs when a write actually prices something. Every other test
  // here passes a string, so the shape that ships was the one shape unexercised: drop the
  // `typeof tier === 'function'` handling and the record becomes MONTHLY_PRICING_ALLOWANCE_BY_TIER[fn],
  // i.e. undefined, i.e. the free allowance for everyone including gold.
  it('resolves a tier passed as a thunk, which is what every caller passes', async () => {
    mockCount.mockResolvedValue(50 as never);

    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: async () => 'gold',
        userMeta: { scores: { total: 50000 } },
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
  });

  it('gives a thunk resolving to null the free allowance, not none', async () => {
    mockCount.mockResolvedValue(3 as never);

    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: async () => null,
        userMeta: { scores: { total: 50000 } },
      })
    ).rejects.toThrow(/3 of 3/);
  });

  // The thunk exists to keep a three-query tier lookup off saves that price nothing. Awaiting it on a
  // write that is exempt would give that back silently.
  it('never calls the thunk for a write that prices nothing', async () => {
    const tier = vi.fn(async () => 'gold');

    await assertPricingAllowed({
      userId: 1,
      wasPriced: true,
      willBePriced: true,
      addsGate: false,
      hadGate: false,
      tier,
      userMeta: { scores: { total: 50000 } },
    });

    expect(tier).not.toHaveBeenCalled();
  });

  it('refuses one point below the floor and allows exactly the floor', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: 'gold',
        // Both keys, unequal — see the note on the same fixture in paid-access.service.test.ts.
        userMeta: { scores: { total: MONETIZATION_MIN_CREATOR_SCORE - 1, models: 50_000 } },
      })
    ).rejects.toThrow(/creator score/);

    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: 'gold',
        userMeta: eligible,
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
  });

  it('allows the last slot of the month and refuses the next', async () => {
    mockCount.mockResolvedValue(2 as never);
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: 'free',
        userMeta: eligible,
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });

    mockCount.mockResolvedValue(3 as never);
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: 'free',
        userMeta: eligible,
      })
    ).rejects.toThrow(/3 of 3/);
  });

  it('gives an unknown or absent tier the free allowance rather than none', async () => {
    mockCount.mockResolvedValue(2 as never);
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: null,
        userMeta: eligible,
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
  });

  it('falls back to reading the score when the caller has no user meta', async () => {
    mockFindUnique.mockResolvedValue({ meta: { scores: { total: 50000 } } } as never);

    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        addsGate: false,
        hadGate: false,
        tier: 'free',
      })
    ).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 1 }, select: { meta: true } });
  });

  describe('licensing-fee boost', () => {
    const boosted = (overrides: { addsGate?: boolean } = {}) =>
      assertPricingAllowed({
        userId: 7,
        wasPriced: false,
        willBePriced: true,
        addsGate: overrides.addsGate ?? false,
        hadGate: false,
        tier: 'free',
        userMeta: eligible,
      });

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
      redisMock.sysRedis.hGet.mockResolvedValue('100' as never);
    });
    afterEach(() => {
      vi.useRealTimers();
      redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    });

    it('lets a granted creator past the tier allowance with a licensing fee', async () => {
      mockCount.mockResolvedValue(3 as never);
      await expect(boosted()).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
      expect(redisMock.sysRedis.hGet).toHaveBeenCalledWith(
        REDIS_SYS_KEYS.PRICING.FEE_ALLOWANCE_BOOST,
        '7'
      );
    });

    it('stops at the tier allowance plus the boost', async () => {
      mockCount.mockResolvedValue(102 as never);
      await expect(boosted()).resolves.toEqual({ spendsSlot: true, releasesSlot: false });
      mockCount.mockResolvedValue(103 as never);
      await expect(boosted()).rejects.toThrow(/103 of 103/);
    });

    it('does not widen a paid-access gate', async () => {
      mockCount.mockResolvedValue(3 as never);
      await expect(boosted({ addsGate: true })).rejects.toThrow(/licensing fees only/);
    });

    it('gives a creator with no grant only the tier allowance', async () => {
      redisMock.sysRedis.hGet.mockResolvedValue(null as never);
      mockCount.mockResolvedValue(3 as never);
      await expect(boosted()).rejects.toThrow(/3 of 3/);
    });

    it('ends on its own at the start of November, whatever the grant list holds', async () => {
      vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
      mockCount.mockResolvedValue(3 as never);
      await expect(boosted()).rejects.toThrow(/3 of 3/);
    });

    it('bounds the grant-list read so a hung Redis cannot hold the save open', async () => {
      redisMock.sysRedis.hGet.mockReturnValue(new Promise(() => undefined) as never);
      redisMock.withSysReadDeadline.mockImplementationOnce(async () => {
        throw new Error('sysRedis read timed out');
      });
      mockCount.mockResolvedValue(3 as never);
      await expect(boosted()).rejects.toThrow(/3 of 3/);
    }, 2000);

    it('tells a boosted creator the refusal already includes their extra slots', async () => {
      mockCount.mockResolvedValue(103 as never);
      await expect(boosted()).rejects.toThrow(/includes your 100 extra licensing-fee slots/);
    });

    describe('adding permanent paid access to a version that already carries a fee', () => {
      const entity = { entityType: 'ModelVersion' as const, entityId: VERSION };
      const convert = () =>
        assertPricingAllowed({
          userId: 7,
          wasPriced: true,
          willBePriced: true,
          addsGate: true,
          hadGate: false,
          entity,
          tier: 'free',
          userMeta: eligible,
        });

      beforeEach(() => {
        mockSlot.mockResolvedValue({ createdAt: new Date('2026-10-02T00:00:00Z') } as never);
        // A lagging replica that has not seen this month's slots yet: the count must come from the primary.
        mockCount.mockResolvedValue(0 as never);
      });

      it('is refused once boost-funded fee slots are in use', async () => {
        mockPrimaryCount.mockResolvedValue(4 as never);
        await expect(convert()).rejects.toThrow(/licensing fees only/);
      });

      it('stays free while every slot this month fits the tier allowance', async () => {
        mockPrimaryCount.mockResolvedValue(3 as never);
        await expect(convert()).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
      });

      it('is free as before for a creator with no grant', async () => {
        redisMock.sysRedis.hGet.mockResolvedValue(null as never);
        mockPrimaryCount.mockResolvedValue(50 as never);
        await expect(convert()).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
        expect(mockPrimaryCount).not.toHaveBeenCalled();
      });

      it('is free as before once the window closes', async () => {
        vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
        mockPrimaryCount.mockResolvedValue(50 as never);
        await expect(convert()).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
      });

      it('is refused when the grant list cannot be read and the month is over the tier', async () => {
        redisMock.sysRedis.hGet.mockRejectedValue(new Error('down') as never);
        mockPrimaryCount.mockResolvedValue(4 as never);
        await expect(convert()).rejects.toThrow(/licensing fees only/);
      });

      it('does not apply to a version that already had its gate', async () => {
        mockPrimaryCount.mockResolvedValue(50 as never);
        await expect(
          assertPricingAllowed({
            userId: 7,
            wasPriced: true,
            willBePriced: true,
            addsGate: true,
            hadGate: true,
            entity,
            tier: 'free',
            userMeta: eligible,
          })
        ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
      });

      it('does not apply to editing the fee on a version that keeps no gate', async () => {
        mockPrimaryCount.mockResolvedValue(50 as never);
        await expect(
          assertPricingAllowed({
            userId: 7,
            wasPriced: true,
            willBePriced: true,
            addsGate: false,
            hadGate: false,
            entity,
            tier: 'free',
            userMeta: eligible,
          })
        ).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
      });

      it('is free as before for a version whose fee was set in an earlier month', async () => {
        mockSlot.mockResolvedValue({ createdAt: new Date('2026-09-30T23:59:59Z') } as never);
        mockPrimaryCount.mockResolvedValue(50 as never);
        await expect(convert()).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
        expect(mockSlot).toHaveBeenCalledWith({
          where: { entityType_entityId: entity },
          select: { createdAt: true },
        });
      });

      it('counts a slot spent at the very start of the month as this month', async () => {
        mockSlot.mockResolvedValue({ createdAt: new Date('2026-10-01T00:00:00Z') } as never);
        mockPrimaryCount.mockResolvedValue(4 as never);
        await expect(convert()).rejects.toThrow(/licensing fees only/);
      });

      it.each([
        ['silver', 'resolves'],
        ['free', 'rejects'],
      ])('applies the rule to a tier passed as a thunk (%s)', async (tier, outcome) => {
        mockPrimaryCount.mockResolvedValue(4 as never);
        const result = assertPricingAllowed({
          userId: 7,
          wasPriced: true,
          willBePriced: true,
          addsGate: true,
          hadGate: false,
          entity,
          tier: async () => tier,
          userMeta: eligible,
        });
        if (outcome === 'resolves')
          await expect(result).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
        else await expect(result).rejects.toThrow(/licensing fees only/);
      });

      it('is free as before for a version that never spent a slot', async () => {
        mockSlot.mockResolvedValue(null as never);
        mockPrimaryCount.mockResolvedValue(50 as never);
        await expect(convert()).resolves.toEqual({ spendsSlot: false, releasesSlot: false });
      });
    });

    it('falls back to the tier allowance when the grant list cannot be read', async () => {
      redisMock.sysRedis.hGet.mockRejectedValue(new Error('down') as never);
      mockCount.mockResolvedValue(3 as never);
      await expect(boosted()).rejects.toThrow(/3 of 3/);
    });
  });
});

describe('listPricingSlots', () => {
  const mockSlots = dbMock.dbRead.pricingSlot.findMany;
  const mockVersions = dbMock.dbRead.modelVersion.findMany;
  const mockGates = dbMock.dbRead.paidAccess.findMany;

  const THIS_MONTH = new Date();
  const LAST_MONTH = new Date(
    Date.UTC(THIS_MONTH.getUTCFullYear(), THIS_MONTH.getUTCMonth() - 1, 15)
  );

  beforeEach(() => {
    mockSlots.mockResolvedValue([
      { entityType: 'ModelVersion', entityId: 1, createdAt: THIS_MONTH },
      { entityType: 'ModelVersion', entityId: 2, createdAt: LAST_MONTH },
    ] as never);
    mockVersions.mockResolvedValue([
      { id: 1, name: 'v1', licensingFee: 40, model: { id: 100, name: 'Model A' } },
      { id: 2, name: 'v2', licensingFee: null, model: { id: 200, name: 'Model B' } },
    ] as never);
    mockGates.mockResolvedValue([] as never);
  });

  it('splits on the calendar month the allowance is counted over', async () => {
    const slots = await listPricingSlots(OWNER);
    expect(slots.map((s) => s.countsThisMonth)).toEqual([true, false]);
    expect(slots[0]).toMatchObject({ modelName: 'Model A', versionName: 'v1', licensingFee: 40 });
  });

  it('reads a price off a permanent gate only, never a timed window', async () => {
    mockGates.mockResolvedValue([
      { entityId: 1, timeframeDays: null, terms: { download: { price: 5000 } } },
      { entityId: 2, timeframeDays: 15, terms: { download: { price: 9000 } } },
    ] as never);

    const [current, older] = await listPricingSlots(OWNER);
    expect(current.accessPrice).toBe(5000);
    expect(older.accessPrice).toBeNull();
  });

  it('names a deleted version rather than dropping the slot that is still counted', async () => {
    mockVersions.mockResolvedValue([] as never);

    const slots = await listPricingSlots(OWNER);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ modelId: null, modelName: null, licensingFee: null });
  });
});

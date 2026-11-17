import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  GIFT_CLAIMER_NAMES_VISIBLE_SINCE,
  GIFT_LIVE_CODES_MAX_PER_VERSION,
  GIFT_MINT_MAX_PER_CALL,
} from '~/server/services/model-version-gift.constants';
import { resetUsageLimitConfigCache } from '~/server/services/usage-limit-config.service';

const { mockGetPaidAccess, mockBustOrchestrator } = vi.hoisted(() => ({
  mockGetPaidAccess: vi.fn(),
  mockBustOrchestrator: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/paid-access.service', () => ({ getPaidAccess: mockGetPaidAccess }));
vi.mock('~/server/services/orchestrator/models', () => ({
  bustOrchestratorModelCache: mockBustOrchestrator,
}));

const {
  claimGift,
  createGiftLink,
  generateGiftCode,
  hashGiftCode,
  listGiftClaims,
  listGiftLinks,
  mintGiftCodes,
  normalizeGiftCode,
  removeGiftClaim,
  revokeGiftLinks,
} = await import('~/server/services/model-version-gift.service');

const OWNER = 10;
const CLAIMER = 20;
const VERSION_ID = 555;

function seed({
  versionStatus = 'Published',
  modelStatus = 'Published',
  gate = { endsAt: null as Date | null, terms: { download: { price: 500 } } as object },
  held = 0,
  link = {
    id: 1,
    modelVersionId: VERSION_ID,
    createdById: OWNER,
    revokedAt: null as Date | null,
    expiresAt: null as Date | null,
  },
  live = 0,
} = {}) {
  const version = {
    id: VERSION_ID,
    status: versionStatus,
    model: { id: 1, userId: OWNER, status: modelStatus },
  };
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(version);
  mockGetPaidAccess.mockResolvedValue(
    gate ? { [VERSION_ID]: { entityId: VERSION_ID, ownerId: OWNER, ...gate } } : {}
  );
  dbMock.dbWrite.entityAccess.findUnique.mockResolvedValue(held ? { permissions: held } : null);
  dbMock.dbWrite.modelVersionGiftLink.findUnique.mockResolvedValue(link);
  dbMock.dbWrite.modelVersionGiftLink.create.mockResolvedValue({ id: 1 });
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ live }]);
  // Each claim step's statement reports one row unless a test says otherwise.
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  redisMock.redis.incrBy.mockResolvedValue(1);
  redisMock.redis.ttl.mockResolvedValue(60);
}

beforeEach(() => vi.clearAllMocks());

/** The values bound into the EntityAccess grant: version, user, permissions, meta, addedBy. */
const grantValues = () => {
  const call = dbMock.dbWrite.$executeRaw.mock.calls.find((c: unknown[]) =>
    (c[0] as string[]).join('?').includes('INSERT INTO "EntityAccess"')
  );
  return (call ?? []).slice(1, 6);
};

describe('gift codes', () => {
  it('generates cvg_ codes that normalise to themselves and hash stably', () => {
    const code = generateGiftCode();
    expect(code).toMatch(/^cvg_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(normalizeGiftCode(code)).toBe(code);
    expect(hashGiftCode(code)).toBe(hashGiftCode(normalizeGiftCode(code)!));
  });

  it('accepts a code typed in lower case, with hyphens, or with Crockford look-alikes', () => {
    const code = 'cvg_0123456789ABCDEFGHJKMNPQRS';
    expect(normalizeGiftCode('CVG_0123-4567-89ab-cdef-ghjk-mnpqrs')).toBe(code);
    expect(normalizeGiftCode('cvg_O123456789ABCDEFGHJKMNPQRS')).toBe(code);
    expect(normalizeGiftCode('cvg_0I23456789ABCDEFGHJKMNPQRS')).toBe(
      'cvg_0123456789ABCDEFGHJKMNPQRS'
    );
  });

  it('rejects a wrong length or a character outside the alphabet', () => {
    expect(normalizeGiftCode('cvg_0123')).toBeNull();
    expect(normalizeGiftCode('cvg_0123456789ABCDEFGHJKMNPQRU')).toBeNull();
  });
});

describe('createGiftLink / mintGiftCodes', () => {
  it('stores only the hash and a 4-character hint, never the code it returns', async () => {
    seed();
    const { code } = await createGiftLink({
      userId: OWNER,
      modelVersionId: VERSION_ID,
      maxRedemptions: 10,
    });
    const stored = JSON.stringify(dbMock.dbWrite.modelVersionGiftLink.create.mock.calls[0][0]);
    expect(stored).not.toContain(code.slice(4));
    expect(stored).toContain(hashGiftCode(code));
  });

  it('refuses someone who does not own the model', async () => {
    seed();
    await expect(
      createGiftLink({ userId: CLAIMER, modelVersionId: VERSION_ID, maxRedemptions: 10 })
    ).rejects.toThrow('You do not own this model version.');
    expect(dbMock.dbWrite.modelVersionGiftLink.create).not.toHaveBeenCalled();
  });

  it('refuses a version that is not gated', async () => {
    seed({ gate: null as never });
    await expect(
      createGiftLink({ userId: OWNER, modelVersionId: VERSION_ID, maxRedemptions: 10 })
    ).rejects.toThrow('gated model version');
  });

  it('rate-limits minting per creator', async () => {
    seed();
    redisMock.redis.incrBy.mockResolvedValue(20);
    await expect(
      createGiftLink({ userId: OWNER, modelVersionId: VERSION_ID, maxRedemptions: 10 })
    ).resolves.toBeDefined();
    redisMock.redis.incrBy.mockResolvedValue(21);
    await expect(
      mintGiftCodes({ userId: OWNER, modelVersionId: VERSION_ID, count: 1 })
    ).rejects.toThrow('Too many attempts');
    expect(dbMock.dbWrite.modelVersionGiftLink.createMany).not.toHaveBeenCalled();
  });

  it(`refuses more than ${GIFT_MINT_MAX_PER_CALL} codes in one call`, async () => {
    seed();
    await expect(
      mintGiftCodes({
        userId: OWNER,
        modelVersionId: VERSION_ID,
        count: GIFT_MINT_MAX_PER_CALL + 1,
      })
    ).rejects.toThrow(`between 1 and ${GIFT_MINT_MAX_PER_CALL}`);
    expect(dbMock.dbWrite.modelVersionGiftLink.createMany).not.toHaveBeenCalled();
  });

  it(`refuses a mint that would pass ${GIFT_LIVE_CODES_MAX_PER_VERSION} live codes on the version`, async () => {
    seed({ live: GIFT_LIVE_CODES_MAX_PER_VERSION - 2 });
    await expect(
      mintGiftCodes({ userId: OWNER, modelVersionId: VERSION_ID, count: 3 })
    ).rejects.toThrow(`at most ${GIFT_LIVE_CODES_MAX_PER_VERSION} live gift codes`);
    expect(dbMock.dbWrite.modelVersionGiftLink.createMany).not.toHaveBeenCalled();
  });
});

describe('claimGift', () => {
  const code = 'cvg_0123456789ABCDEFGHJKMNPQRS';

  it('grants, then busts the claimer’s caches', async () => {
    seed();
    await expect(claimGift({ user: { id: CLAIMER }, code })).resolves.toMatchObject({
      modelVersionId: VERSION_ID,
      alreadyHadAccess: false,
      notice: 'The creator can see that you claimed this, and can remove gifted access.',
    });
    expect(grantValues()).toEqual([
      VERSION_ID,
      CLAIMER,
      3,
      JSON.stringify({ giftLinkId: 1, 'gift-permissions': 3 }),
      // addedById stays the claimer, not the creator: the personal-data export reads EntityAccess
      // by addedById, so the creator would carry every recipient's id.
      CLAIMER,
    ]);
    expect(mockBustOrchestrator).toHaveBeenCalledTimes(1);
    expect(mockBustOrchestrator).toHaveBeenCalledWith(VERSION_ID, CLAIMER);
  });

  it('grants download to a generation-only holder when the version sells download', async () => {
    seed({ held: 1 });
    await expect(claimGift({ user: { id: CLAIMER }, code })).resolves.toMatchObject({
      alreadyHadAccess: false,
    });
    expect(grantValues()[2]).toBe(3);
  });

  it('grants generation only on a generation-only gate', async () => {
    seed({ gate: { endsAt: null, terms: { generation: { price: 100 } } } });
    await claimGift({ user: { id: CLAIMER }, code });
    expect(grantValues()[2]).toBe(1);
  });

  it('spends no slot on someone who already holds what the gift grants', async () => {
    seed({ held: 3 });
    const result = await claimGift({ user: { id: CLAIMER }, code });
    expect(result).toMatchObject({ alreadyHadAccess: true });
    expect(result).not.toHaveProperty('notice');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('spends no slot once the gate has ended and the version is free', async () => {
    seed({ gate: { endsAt: new Date(Date.now() - 1000), terms: {} } });
    await expect(claimGift({ user: { id: CLAIMER }, code })).resolves.toMatchObject({
      alreadyHadAccess: true,
    });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('answers an unknown code and a malformed one with the same message', async () => {
    seed();
    dbMock.dbWrite.modelVersionGiftLink.findUnique.mockResolvedValue(null);
    for (const attempt of [code, 'not-a-code'])
      await expect(claimGift({ user: { id: CLAIMER }, code: attempt })).rejects.toThrow(
        'This gift is invalid, expired or no longer available.'
      );
  });

  it.each([
    ['revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('answers a %s link with the same message as an unknown one', async (_label, change) => {
    seed({
      link: {
        id: 1,
        modelVersionId: VERSION_ID,
        createdById: OWNER,
        revokedAt: null,
        expiresAt: null,
        ...change,
      },
    });
    await expect(claimGift({ user: { id: CLAIMER }, code })).rejects.toThrow(
      'This gift is invalid, expired or no longer available.'
    );
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when the cap update takes no row (cap reached or revoked mid-claim)', async () => {
    seed();
    // The redemption insert, the allowance lock, then the cap update.
    dbMock.dbWrite.$executeRaw
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    await expect(claimGift({ user: { id: CLAIMER }, code })).rejects.toThrow(
      'This gift is invalid, expired or no longer available.'
    );
    expect(mockBustOrchestrator).not.toHaveBeenCalled();
  });

  it('counts the attempt against the rate limit before looking the code up', async () => {
    seed();
    redisMock.redis.incrBy.mockResolvedValue(11);
    await expect(claimGift({ user: { id: CLAIMER }, code })).rejects.toThrow('Too many attempts');
    expect(dbMock.dbWrite.modelVersionGiftLink.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a code minted by a previous owner after the model was transferred', async () => {
    seed({
      link: {
        id: 1,
        modelVersionId: VERSION_ID,
        createdById: 99,
        revokedAt: null,
        expiresAt: null,
      },
    });
    await expect(claimGift({ user: { id: CLAIMER }, code })).rejects.toThrow(
      'This gift is invalid, expired or no longer available.'
    );
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses the model’s owner and an unpublished version', async () => {
    seed();
    await expect(claimGift({ user: { id: OWNER }, code })).rejects.toThrow('your own model');
    seed({ versionStatus: 'Scheduled' });
    await expect(claimGift({ user: { id: CLAIMER }, code })).rejects.toThrow('published models');
    seed({ modelStatus: 'Unpublished' });
    await expect(claimGift({ user: { id: CLAIMER }, code })).rejects.toThrow('published models');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  describe('monthly allowance', () => {
    const allowanceLocks = () =>
      dbMock.dbWrite.$executeRaw.mock.calls.filter((c: unknown[]) =>
        (c[0] as string[]).join('?').includes('pg_advisory_xact_lock')
      );
    /** The claimer has `used` claims this month, counting the one being made. */
    const seedUsed = (used: number) => {
      seed();
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ used }]);
    };

    beforeEach(() => {
      resetUsageLimitConfigCache();
      dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-20T12:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('refuses the claim past the limit with the product rate-limit metadata', async () => {
      seedUsed(4);
      const refusal = claimGift({ user: { id: CLAIMER }, code });
      await expect(refusal).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        message:
          "You've claimed your 3 gifts for this month. To get this one, reach out to the person who gave you the link.",
        cause: {
          rateLimit: {
            id: 'gifts.monthly',
            kind: 'product',
            limit: 3,
            used: 3,
            remaining: 0,
            windowSeconds: 30 * 24 * 60 * 60,
            retryAfterSeconds: 10.5 * 24 * 60 * 60,
            retryAt: '2026-12-01T00:00:00.000Z',
            resetAt: '2026-12-01T00:00:00.000Z',
          },
        },
      });
      expect(grantValues()).toEqual([]);
      expect(mockBustOrchestrator).not.toHaveBeenCalled();
      // Counted under the claimer's lock, over this UTC month.
      expect(allowanceLocks()).toHaveLength(1);
      const count = dbMock.dbWrite.$queryRaw.mock.calls.find((c: unknown[]) =>
        (c[0] as string[]).join('?').includes('"claimedAt" >=')
      );
      expect(count?.slice(1)).toEqual([
        CLAIMER,
        new Date('2026-11-01T00:00:00.000Z'),
        new Date('2026-12-01T00:00:00.000Z'),
      ]);
    });

    it.each([
      [undefined, 3],
      ['founder', 15],
      ['bronze', 15],
      ['silver', 30],
      ['gold', 60],
    ])('gives tier %s %i claims a month', async (tier, limit) => {
      const user = { id: CLAIMER, tier };
      seedUsed(limit);
      await expect(claimGift({ user, code })).resolves.toMatchObject({ alreadyHadAccess: false });
      seedUsed(limit + 1);
      await expect(claimGift({ user, code })).rejects.toMatchObject({
        cause: { rateLimit: { limit } },
      });
    });

    it('counts nothing while an override disables the limit', async () => {
      dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
        key: 'usage-limits',
        value: { version: 1, limits: { 'gifts.monthly': { disabled: true } } },
      });
      seedUsed(100);
      await expect(claimGift({ user: { id: CLAIMER }, code })).resolves.toMatchObject({
        alreadyHadAccess: false,
      });
      expect(allowanceLocks()).toEqual([]);
    });

    it('takes no allowance for a repeat claim of the same link', async () => {
      seedUsed(100);
      // The redemption insert finds the claim already recorded.
      dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0);
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ used: 100 }, { '?column?': 1 }]);
      await expect(claimGift({ user: { id: CLAIMER }, code })).resolves.toMatchObject({
        alreadyHadAccess: false,
      });
      expect(allowanceLocks()).toEqual([]);
    });
  });
});

type MintArgs = Parameters<typeof mintGiftCodes>[0];
type CreateArgs = Parameters<typeof createGiftLink>[0];

describe('who may manage gifts', () => {
  const manage = {
    list: (userId: number, isModerator = false) =>
      listGiftLinks({ userId, isModerator, modelVersionId: VERSION_ID }),
    // Mint takes no moderator flag; one forwarded anyway must change nothing.
    mint: (userId: number, isModerator = false) =>
      mintGiftCodes({ userId, isModerator, modelVersionId: VERSION_ID, count: 1 } as MintArgs),
    revoke: (userId: number, isModerator = false) =>
      revokeGiftLinks({ userId, isModerator, modelVersionId: VERSION_ID, id: 1 }),
    create: (userId: number, isModerator = false) =>
      createGiftLink({
        userId,
        isModerator,
        modelVersionId: VERSION_ID,
        maxRedemptions: 10,
      } as CreateArgs),
    claims: (userId: number, isModerator = false) =>
      listGiftClaims({ userId, isModerator, modelVersionId: VERSION_ID, id: 1 }),
    removeClaim: (userId: number, isModerator = false) =>
      removeGiftClaim({
        userId,
        isModerator,
        modelVersionId: VERSION_ID,
        giftLinkId: 1,
        claimerId: CLAIMER,
      }),
  };

  it.each(Object.entries(manage))(
    '%s refuses a non-owner before touching gift rows',
    async (_n, fn) => {
      seed();
      await expect(fn(CLAIMER)).rejects.toThrow('You do not own this model version.');
      expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
      expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelVersionGiftLink.updateMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelVersionGiftLink.createMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelVersionGiftLink.create).not.toHaveBeenCalled();
    }
  );

  const { list, revoke, claims, removeClaim } = manage;
  it.each(Object.entries({ list, revoke, claims, removeClaim }))(
    '%s lets a moderator through',
    async (_n, fn) => {
      seed();
      dbMock.dbRead.$queryRaw.mockResolvedValue([]);
      dbMock.dbWrite.modelVersionGiftLink.updateMany.mockResolvedValue({ count: 1 });
      dbMock.dbWrite.modelVersionGiftLink.findMany.mockResolvedValue([]);
      await expect(fn(CLAIMER, true)).resolves.toBeDefined();
    }
  );

  // Decision (lead review of #8146): moderators list and revoke, but never mint free access to a
  // creator's paid version. Do not route mint through the moderator check.
  const { mint, create } = manage;
  it.each(Object.entries({ mint, create }))(
    '%s refuses a moderator who does not own the version',
    async (_n, fn) => {
      seed();
      await expect(fn(CLAIMER, true)).rejects.toThrow('You do not own this model version.');
      expect(dbMock.dbWrite.modelVersionGiftLink.createMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelVersionGiftLink.create).not.toHaveBeenCalled();
    }
  );
});

describe('the live-code cap', () => {
  const sqlOf = (c: unknown[]) => (c[0] as string[]).join('?');

  it.each([
    [
      'createGiftLink',
      () => createGiftLink({ userId: OWNER, modelVersionId: VERSION_ID, maxRedemptions: 10 }),
      'create',
    ],
    [
      'mintGiftCodes',
      () => mintGiftCodes({ userId: OWNER, modelVersionId: VERSION_ID, count: 2 }),
      'createMany',
    ],
  ] as const)(
    '%s takes the per-version lock before it counts and inserts',
    async (_n, run, insert) => {
      seed();
      await run();
      const lock = dbMock.dbWrite.$executeRaw.mock.calls.findIndex((c: unknown[]) =>
        sqlOf(c).includes('pg_advisory_xact_lock')
      );
      expect(lock, 'no advisory lock was taken').toBeGreaterThanOrEqual(0);
      expect(dbMock.dbWrite.$executeRaw.mock.calls[lock].slice(1)).toEqual([
        0x47490001,
        VERSION_ID,
      ]);
      const lockOrder = dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[lock];
      expect(lockOrder).toBeLessThan(dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[0]);
      expect(lockOrder).toBeLessThan(
        dbMock.dbWrite.modelVersionGiftLink[insert].mock.invocationCallOrder[0]
      );
    }
  );
});

describe('mintGiftCodes', () => {
  it('stores single-use rows sharing one batch id', async () => {
    seed();
    const { batchId, codes } = await mintGiftCodes({
      userId: OWNER,
      modelVersionId: VERSION_ID,
      count: 3,
    });
    const rows = dbMock.dbWrite.modelVersionGiftLink.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
    expect(
      rows.map((r: { maxRedemptions: number; batchId: string }) => [r.maxRedemptions, r.batchId])
    ).toEqual([1, 1, 1].map((n) => [n, batchId]));
    expect(rows.map((r: { codeHash: string }) => r.codeHash)).toEqual(codes.map(hashGiftCode));
  });
});

describe('removeGiftClaim', () => {
  const removeClaim = () =>
    removeGiftClaim({
      userId: OWNER,
      modelVersionId: VERSION_ID,
      giftLinkId: 1,
      claimerId: CLAIMER,
    });

  it("busts the claimer's generator cache once the removal commits", async () => {
    seed();
    dbMock.dbWrite.$queryRaw
      .mockResolvedValueOnce([{ permissions: 3, meta: { giftLinkId: 1, 'gift-permissions': 3 } }])
      .mockResolvedValueOnce([]);

    await expect(removeClaim()).resolves.toEqual({ removed: true });
    expect(mockBustOrchestrator).toHaveBeenCalledTimes(1);
    expect(mockBustOrchestrator).toHaveBeenCalledWith(VERSION_ID, CLAIMER);
  });

  it('busts nothing when there is no claim to remove', async () => {
    seed();
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0);

    await expect(removeClaim()).rejects.toThrow('No claim to remove.');
    expect(mockBustOrchestrator).not.toHaveBeenCalled();
  });

  it('refuses claims from before the claimer names were shown', async () => {
    seed();
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0);
    await removeClaim().catch(() => undefined);
    const [, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0] as unknown[];
    expect(values).toContain(GIFT_CLAIMER_NAMES_VISIBLE_SINCE.toISOString());
  });
});

describe('revokeGiftLinks', () => {
  it('only revokes live links on the caller’s own version', async () => {
    seed();
    dbMock.dbWrite.modelVersionGiftLink.updateMany.mockResolvedValue({ count: 1 });
    await revokeGiftLinks({ userId: OWNER, modelVersionId: VERSION_ID, id: 9 });
    expect(dbMock.dbWrite.modelVersionGiftLink.updateMany.mock.calls[0][0].where).toEqual({
      modelVersionId: VERSION_ID,
      id: 9,
      revokedAt: null,
    });
  });

  it('revokes a batch only on the caller’s own version', async () => {
    seed();
    dbMock.dbWrite.modelVersionGiftLink.updateMany.mockResolvedValue({ count: 3 });
    await revokeGiftLinks({ userId: OWNER, modelVersionId: VERSION_ID, batchId: 'b-1' });
    expect(dbMock.dbWrite.modelVersionGiftLink.updateMany.mock.calls[0][0].where).toEqual({
      modelVersionId: VERSION_ID,
      batchId: 'b-1',
      revokedAt: null,
    });
  });

  it('needs exactly one of id or batchId', async () => {
    seed();
    await expect(revokeGiftLinks({ userId: OWNER, modelVersionId: VERSION_ID })).rejects.toThrow(
      'exactly one of id or batchId'
    );
    await expect(
      revokeGiftLinks({ userId: OWNER, modelVersionId: VERSION_ID, id: 1, batchId: 'b' })
    ).rejects.toThrow('exactly one of id or batchId');
  });

  it('reports a revoke that matched no active link as a failure', async () => {
    seed();
    dbMock.dbWrite.modelVersionGiftLink.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      revokeGiftLinks({ userId: OWNER, modelVersionId: VERSION_ID, id: 99 })
    ).rejects.toThrow('No active gift link to revoke.');
  });
});

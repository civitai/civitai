import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  GIFT_LIVE_CODES_MAX_PER_VERSION,
  GIFT_MINT_MAX_PER_CALL,
} from '~/server/services/model-version-gift.constants';

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
  listGiftLinks,
  mintGiftCodes,
  normalizeGiftCode,
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
    const { code } = await createGiftLink({ userId: OWNER, modelVersionId: VERSION_ID });
    const stored = JSON.stringify(dbMock.dbWrite.modelVersionGiftLink.create.mock.calls[0][0]);
    expect(stored).not.toContain(code.slice(4));
    expect(stored).toContain(hashGiftCode(code));
  });

  it('refuses someone who does not own the model', async () => {
    seed();
    await expect(createGiftLink({ userId: CLAIMER, modelVersionId: VERSION_ID })).rejects.toThrow(
      'You do not own this model version.'
    );
    expect(dbMock.dbWrite.modelVersionGiftLink.create).not.toHaveBeenCalled();
  });

  it('refuses a version that is not gated', async () => {
    seed({ gate: null as never });
    await expect(createGiftLink({ userId: OWNER, modelVersionId: VERSION_ID })).rejects.toThrow(
      'gated model version'
    );
  });

  it('rate-limits minting per creator', async () => {
    seed();
    redisMock.redis.incrBy.mockResolvedValue(20);
    await expect(
      createGiftLink({ userId: OWNER, modelVersionId: VERSION_ID })
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
    await expect(claimGift({ userId: CLAIMER, code })).resolves.toMatchObject({
      modelVersionId: VERSION_ID,
      alreadyHadAccess: false,
    });
    expect(grantValues()).toEqual([
      VERSION_ID,
      CLAIMER,
      3,
      JSON.stringify({ giftLinkId: 1 }),
      OWNER,
    ]);
    expect(mockBustOrchestrator).toHaveBeenCalledTimes(1);
    expect(mockBustOrchestrator).toHaveBeenCalledWith(VERSION_ID, CLAIMER);
  });

  it('grants download to a generation-only holder when the version sells download', async () => {
    seed({ held: 1 });
    await expect(claimGift({ userId: CLAIMER, code })).resolves.toMatchObject({
      alreadyHadAccess: false,
    });
    expect(grantValues()[2]).toBe(3);
  });

  it('grants generation only on a generation-only gate', async () => {
    seed({ gate: { endsAt: null, terms: { generation: { price: 100 } } } });
    await claimGift({ userId: CLAIMER, code });
    expect(grantValues()[2]).toBe(1);
  });

  it('spends no slot on someone who already holds what the gift grants', async () => {
    seed({ held: 3 });
    await expect(claimGift({ userId: CLAIMER, code })).resolves.toMatchObject({
      alreadyHadAccess: true,
    });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('spends no slot once the gate has ended and the version is free', async () => {
    seed({ gate: { endsAt: new Date(Date.now() - 1000), terms: {} } });
    await expect(claimGift({ userId: CLAIMER, code })).resolves.toMatchObject({
      alreadyHadAccess: true,
    });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('answers an unknown code and a malformed one with the same message', async () => {
    seed();
    dbMock.dbWrite.modelVersionGiftLink.findUnique.mockResolvedValue(null);
    for (const attempt of [code, 'not-a-code'])
      await expect(claimGift({ userId: CLAIMER, code: attempt })).rejects.toThrow(
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
    await expect(claimGift({ userId: CLAIMER, code })).rejects.toThrow(
      'This gift is invalid, expired or no longer available.'
    );
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when the cap update takes no row (cap reached or revoked mid-claim)', async () => {
    seed();
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(claimGift({ userId: CLAIMER, code })).rejects.toThrow(
      'This gift is invalid, expired or no longer available.'
    );
    expect(mockBustOrchestrator).not.toHaveBeenCalled();
  });

  it('counts the attempt against the rate limit before looking the code up', async () => {
    seed();
    redisMock.redis.incrBy.mockResolvedValue(11);
    await expect(claimGift({ userId: CLAIMER, code })).rejects.toThrow('Too many attempts');
    expect(dbMock.dbWrite.modelVersionGiftLink.findUnique).not.toHaveBeenCalled();
  });

  it('refuses the model’s owner and an unpublished version', async () => {
    seed();
    await expect(claimGift({ userId: OWNER, code })).rejects.toThrow('your own model');
    seed({ versionStatus: 'Scheduled' });
    await expect(claimGift({ userId: CLAIMER, code })).rejects.toThrow('published models');
    seed({ modelStatus: 'Unpublished' });
    await expect(claimGift({ userId: CLAIMER, code })).rejects.toThrow('published models');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('who may manage gifts', () => {
  const manage = {
    list: (userId: number, isModerator = false) =>
      listGiftLinks({ userId, isModerator, modelVersionId: VERSION_ID }),
    mint: (userId: number, isModerator = false) =>
      mintGiftCodes({ userId, isModerator, modelVersionId: VERSION_ID, count: 1 }),
    revoke: (userId: number, isModerator = false) =>
      revokeGiftLinks({ userId, isModerator, modelVersionId: VERSION_ID, id: 1 }),
    create: (userId: number, isModerator = false) =>
      createGiftLink({ userId, isModerator, modelVersionId: VERSION_ID }),
  };

  it.each(Object.entries(manage))(
    '%s refuses a non-owner before touching gift rows',
    async (_n, fn) => {
      seed();
      await expect(fn(CLAIMER)).rejects.toThrow('You do not own this model version.');
      expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelVersionGiftLink.updateMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelVersionGiftLink.createMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelVersionGiftLink.create).not.toHaveBeenCalled();
    }
  );

  it.each(Object.entries(manage))('%s lets a moderator through', async (_n, fn) => {
    seed();
    dbMock.dbWrite.modelVersionGiftLink.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.modelVersionGiftLink.findMany.mockResolvedValue([]);
    await expect(fn(CLAIMER, true)).resolves.toBeDefined();
  });
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

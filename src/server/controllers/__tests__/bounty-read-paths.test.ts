import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BountyVisibility from '~/server/services/bounty-visibility';
import type * as BountyEntryService from '~/server/services/bountyEntry.service';
import type * as BountyBenefactorService from '~/server/services/bountyBenefactor.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as BountyService from '~/server/services/bounty.service';
import type * as FileService from '~/server/services/file.service';
import type * as UserService from '~/server/services/user.service';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';

const {
  mockAssert,
  mockGetEntries,
  mockGetBenefactors,
  mockGetEntryById,
  mockGetEntryFiles,
  mockUpsertBounty,
  mockDeleteBounty,
} = vi.hoisted(() => ({
  mockAssert: vi.fn(),
  mockGetEntries: vi.fn(async () => []),
  mockGetBenefactors: vi.fn(async () => []),
  mockGetEntryById: vi.fn(async () => ({ id: 3, user: { id: 5 } })),
  mockGetEntryFiles: vi.fn(async () => []),
  mockUpsertBounty: vi.fn(),
  mockDeleteBounty: vi.fn(),
}));

// The showcase hat is a cache read beside these checks; it has its own test.
vi.mock('~/server/events/showcase-hat', () => ({ getShowcaseHatForUser: async () => null }));
vi.mock('~/server/services/bounty-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyVisibility>()),
  assertBountyVisible: mockAssert,
}));
vi.mock('~/server/services/bountyEntry.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyEntryService>()),
  getAllEntriesByBountyId: mockGetEntries,
  getEntryById: mockGetEntryById,
  getBountyEntryFilteredFiles: mockGetEntryFiles,
}));
vi.mock('~/server/services/bounty.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyService>()),
  upsertBounty: mockUpsertBounty,
  deleteBountyById: mockDeleteBounty,
  getBountyImages: vi.fn(async () => []),
  getImagesForBounties: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileService>()),
  getFilesByEntity: vi.fn(async () => []),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));
vi.mock('~/server/services/bountyBenefactor.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyBenefactorService>()),
  getAllBenefactorsByBountyId: mockGetBenefactors,
}));
const emptyPreference = { getCached: vi.fn(async () => [] as { id: number }[]) };
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: emptyPreference,
  BlockedUsers: emptyPreference,
  BlockedByUsers: emptyPreference,
}));

// event-engine-common is a git submodule a fresh checkout does not have; image.service imports it.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Real env validation throws in test; the controllers' import graph reads env at load.
vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

const {
  getBountyHandler,
  getInfiniteBountiesHandler,
  getBountyEntriesHandler,
  getBountyBenefactorsHandler,
  addBenefactorUnitAmountHandler,
  upsertBountyHandler,
  deleteBountyHandler,
} = await import('../bounty.controller');
const {
  getBountyEntryHandler,
  getBountyEntryFilteredFilesHandler,
  upsertBountyEntryHandler,
  submitBountyEntryHandler,
} = await import('../bountyEntry.controller');
const stranger = { user: { id: 6 } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockAssert.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
});

describe('a Private bounty is not reachable through its satellite reads', () => {
  it.each([
    [
      'getEntries',
      () => getBountyEntriesHandler({ input: { id: 9 } as never, ctx: stranger }),
      mockGetEntries,
      { bountyId: 9 },
    ],
    [
      'getBenefactors',
      () => getBountyBenefactorsHandler({ input: { id: 9 }, ctx: stranger }),
      mockGetBenefactors,
      { bountyId: 9 },
    ],
    [
      'entry detail',
      () => getBountyEntryHandler({ input: { id: 3 }, ctx: stranger }),
      mockGetEntryById,
      { entryId: 3 },
    ],
    [
      'entry files',
      () => getBountyEntryFilteredFilesHandler({ input: { id: 3 }, ctx: stranger }),
      mockGetEntryFiles,
      { entryId: 3 },
    ],
  ])('%s 404s before reading anything', async (_label, call, downstream, target) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockAssert).toHaveBeenCalledWith(target, { id: 6 });
    expect(downstream).not.toHaveBeenCalled();
  });

  // A participant who is not the owner cannot keep adding entries or Buzz to a hidden bounty.
  it.each([
    [
      'bountyEntry.upsert',
      () => upsertBountyEntryHandler({ input: { bountyId: 9 } as never, ctx: stranger }),
    ],
    [
      'bountyEntry.submit',
      () =>
        submitBountyEntryHandler({
          input: { bountyId: 9, files: [], imageUuids: [] } as never,
          ctx: stranger,
        }),
    ],
    [
      'bounty.addBenefactorUnitAmount',
      () =>
        addBenefactorUnitAmountHandler({
          input: { bountyId: 9, unitAmount: 100 } as never,
          ctx: stranger,
        }),
    ],
  ])('%s on a hidden bounty 404s', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockAssert).toHaveBeenCalledWith({ bountyId: 9 }, { id: 6 });
    expect(dbMock.dbRead.bounty.findUnique).not.toHaveBeenCalled();
  });
});

describe('bounty write responses', () => {
  const row = {
    id: 9,
    name: 'B',
    meta: { textScanFlags: { poi: { reason: 'r', names: ['Jane Doe'] } } },
  };
  const ctx = { user: { id: 5 }, track: { bounty: vi.fn(async () => undefined) } } as never;

  it('upsert never returns meta', async () => {
    mockUpsertBounty.mockResolvedValue(row);
    const result = await upsertBountyHandler({ input: { id: 9 } as never, ctx });
    expect(result).toEqual({ id: 9, name: 'B' });
  });

  it('upsert returns the profanity details to a moderator only', async () => {
    const details = {
      baseModel: 'SD 1.5',
      profanityMatches: ['term'],
      profanityEvaluation: { reason: 'test reason' },
    };
    mockUpsertBounty.mockResolvedValue({ ...row, details });
    const asUser = await upsertBountyHandler({ input: { id: 9 } as never, ctx });
    expect(asUser).toEqual({ id: 9, name: 'B', details: { baseModel: 'SD 1.5' } });
    const modCtx = { ...(ctx as object), user: { id: 5, isModerator: true } } as never;
    const asMod = await upsertBountyHandler({ input: { id: 9 } as never, ctx: modCtx });
    expect(asMod).toEqual({ id: 9, name: 'B', details });
  });

  it('delete never returns meta', async () => {
    mockDeleteBounty.mockResolvedValue(row);
    const result = await deleteBountyHandler({ input: { id: 9 }, ctx });
    expect(result).toEqual({ id: 9, name: 'B' });
  });
});

describe('bounty detail and feed visibility', () => {
  const OWNER = 5;
  const privateBounty = {
    id: 9,
    name: 'B',
    availability: 'Private',
    poi: false,
    user: { id: OWNER },
    details: null,
    tags: [],
    meta: { textScanFlags: { poi: { reason: 'r', names: ['Jane Doe'] } } },
  };

  beforeEach(() => dbMock.dbRead.bounty.findUnique.mockResolvedValue(privateBounty));

  it('getBounty is not found for a stranger', async () => {
    await expect(getBountyHandler({ input: { id: 9 }, ctx: stranger })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it.each([
    ['the owner', { id: OWNER }],
    ['a moderator', { id: 77, isModerator: true }],
  ])('getBounty returns it to %s, without meta', async (_label, user) => {
    const result = await getBountyHandler({ input: { id: 9 }, ctx: { user } as never });
    expect(result.id).toBe(9);
    expect(result).not.toHaveProperty('meta');
  });

  it("getInfinite filters by the viewer's own id, not the profile being browsed", async () => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([]);
    await getInfiniteBountiesHandler({
      input: { limit: 10, userId: 99, period: 'AllTime', sort: 'Newest' } as never,
      ctx: stranger,
    });
    expect(dbMock.dbRead.bounty.findMany).toHaveBeenCalledTimes(1);
    const { where } = dbMock.dbRead.bounty.findMany.mock.calls[0][0];
    expect(where.AND).toContainEqual({
      OR: [{ availability: { not: 'Private' } }, { userId: 6 }],
    });
  });
});

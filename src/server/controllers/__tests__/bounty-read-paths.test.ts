import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BountyVisibility from '~/server/services/bounty-visibility';
import type * as BountyEntryService from '~/server/services/bountyEntry.service';
import type * as BountyBenefactorService from '~/server/services/bountyBenefactor.service';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { mockAssert, mockGetEntries, mockGetBenefactors, mockGetEntryById, mockGetEntryFiles, mockGetComments, mockGetThread, mockGetCount } =
  vi.hoisted(() => ({
    mockAssert: vi.fn(),
    mockGetEntries: vi.fn(async () => []),
    mockGetBenefactors: vi.fn(async () => []),
    mockGetEntryById: vi.fn(async () => ({ id: 3, user: { id: 5 } })),
    mockGetEntryFiles: vi.fn(async () => []),
    mockGetComments: vi.fn(async () => null),
    mockGetThread: vi.fn(async () => null),
    mockGetCount: vi.fn(async () => 0),
  }));

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
vi.mock('~/server/services/bountyBenefactor.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyBenefactorService>()),
  getAllBenefactorsByBountyId: mockGetBenefactors,
}));
vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  getCommentsInfinite: mockGetComments,
  getCommentsThreadDetails2: mockGetThread,
  getCommentCount: mockGetCount,
  isViewerContentOwner: vi.fn(async () => false),
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

const { getBountyEntriesHandler, getBountyBenefactorsHandler, addBenefactorUnitAmountHandler } = await import('../bounty.controller');
const {
  getBountyEntryHandler,
  getBountyEntryFilteredFilesHandler,
  upsertBountyEntryHandler,
  submitBountyEntryHandler,
} = await import(
  '../bountyEntry.controller'
);
const { getCommentsInfiniteHandler, getCommentsThreadDetailsHandler, getCommentCountV2Handler } =
  await import('../commentv2.controller');

const stranger = { user: { id: 6 } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockAssert.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
});

describe('a Private bounty is not reachable through its satellite reads', () => {
  it.each([
    ['getEntries', () => getBountyEntriesHandler({ input: { id: 9 } as never, ctx: stranger }), mockGetEntries, { bountyId: 9 }],
    ['getBenefactors', () => getBountyBenefactorsHandler({ input: { id: 9 }, ctx: stranger }), mockGetBenefactors, { bountyId: 9 }],
    ['entry detail', () => getBountyEntryHandler({ input: { id: 3 }, ctx: stranger }), mockGetEntryById, { entryId: 3 }],
    ['entry files', () => getBountyEntryFilteredFilesHandler({ input: { id: 3 }, ctx: stranger }), mockGetEntryFiles, { entryId: 3 }],
  ])('%s 404s before reading anything', async (_label, call, downstream, target) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockAssert).toHaveBeenCalledWith(target, { id: 6 });
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each([
    ['getInfinite', () => getCommentsInfiniteHandler({ input: { entityType: 'bounty', entityId: 9 } as never, ctx: stranger }), mockGetComments],
    ['getThreadDetails', () => getCommentsThreadDetailsHandler({ input: { entityType: 'bountyEntry', entityId: 3 } as never, ctx: stranger }), mockGetThread],
    ['getCount', () => getCommentCountV2Handler({ input: { entityType: 'bounty', entityId: 9 } as never, ctx: stranger }), mockGetCount],
  ])('comments %s on a hidden bounty 404s', async (_label, call, downstream) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(downstream).not.toHaveBeenCalled();
  });

  // The control: a comment thread on anything but a bounty never pays for the lookup.
  it('leaves other comment threads alone', async () => {
    await getCommentsInfiniteHandler({ input: { entityType: 'image', entityId: 1 } as never, ctx: stranger });
    expect(mockAssert).not.toHaveBeenCalled();
    expect(mockGetComments).toHaveBeenCalled();
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

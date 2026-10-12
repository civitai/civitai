import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';
import type * as CrucibleService from '~/server/services/crucible.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

/**
 * A block hides the crucible whichever side made it: a host who blocked the viewer and a viewer
 * who blocked the host both get not-found from every read, enter, judge and follow path.
 *
 * Drives the REAL router, so the controller's block lists and the service checks are exercised
 * together.
 */

const { mockGetCrucibles, mockGetFeaturedCrucible, blockedBy, blocked } = vi.hoisted(() => ({
  mockGetCrucibles: vi.fn(),
  mockGetFeaturedCrucible: vi.fn(),
  blockedBy: vi.fn(),
  blocked: vi.fn(),
}));

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  BlockedByUsers: { getCached: blockedBy },
  BlockedUsers: { getCached: blocked },
}));

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  getCrucibles: mockGetCrucibles,
  getFeaturedCrucible: mockGetFeaturedCrucible,
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ crucible: true }),
}));

import { crucibleRouter } from '~/server/routers/crucible.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const CRUCIBLE_ID = 7;
const HOST_ID = 555;
const VIEWER_ID = 999;
const NOT_FOUND = 'Crucible not found';

const signedIn = (id: number, isModerator = false) => ({
  id,
  isModerator,
  tier: 'free',
  muted: false,
  bannedAt: null,
  onboarding: 0x1f,
  emailVerified: new Date('2026-01-01'),
});

const caller = (user = signedIn(VIEWER_ID)) =>
  crucibleRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { crucible: true } as never,
    track: undefined,
  } as never);

const openCrucible = {
  id: CRUCIBLE_ID,
  userId: HOST_ID,
  buzzType: 'yellow',
  nsfwLevel: 1,
  textNsfw: false,
  ingestion: 'Scanned',
  image: { ingestion: 'Scanned' },
  status: CrucibleStatus.Active,
  endAt: new Date(Date.now() + 60_000),
  startAt: new Date(Date.now() - 60_000),
  createdAt: new Date(Date.now() - 120_000),
  allowedResources: [],
  allowedBaseModels: [],
  minViewSeconds: null,
};

const directions = [
  ['a host who blocked the viewer', blockedBy, blocked],
  ['a viewer who blocked the host', blocked, blockedBy],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  blockedBy.mockResolvedValue([]);
  blocked.mockResolvedValue([]);
  mockGetCrucibles.mockResolvedValue({ items: [], nextCursor: undefined });
  mockGetFeaturedCrucible.mockResolvedValue(null);
  dbMock.dbRead.crucible.findUnique.mockResolvedValue(openCrucible);
  dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([]);
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    meta: { scores: { total: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } },
  });
  dbMock.dbWrite.crucibleEngagement.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.crucibleEngagement.create.mockResolvedValue({});
  dbMock.dbRead.crucibleEntry.aggregate.mockResolvedValue({
    _sum: { voteCount: 0 },
    _count: { _all: 0 },
  });
  redisMock.sysRedis.sCard.mockResolvedValue(3);
  redisMock.sysRedis.set.mockResolvedValue('OK');
});

describe.each(directions)('%s', (_, blockingList, otherList) => {
  beforeEach(() => {
    blockingList.mockResolvedValue([{ id: HOST_ID }]);
    otherList.mockResolvedValue([]);
  });

  it('gets no crucible from the detail page', async () => {
    await expect(caller().getById({ id: CRUCIBLE_ID })).resolves.toBeNull();
  });

  it('still gives a moderator the detail page', async () => {
    await expect(caller(signedIn(1, true)).getById({ id: CRUCIBLE_ID })).resolves.toBeTruthy();
  });

  it("has the host's crucibles left out of the list", async () => {
    await caller().getInfinite({});

    expect(mockGetCrucibles).toHaveBeenCalledWith(
      expect.objectContaining({ excludedUserIds: [HOST_ID] })
    );
  });

  it('leaves a moderator’s list unfiltered', async () => {
    await caller(signedIn(1, true)).getInfinite({});

    expect(mockGetCrucibles).toHaveBeenCalledWith(expect.objectContaining({ excludedUserIds: [] }));
  });

  it("has the host's crucible left out of the featured pick", async () => {
    await caller().getFeatured({});

    expect(mockGetFeaturedCrucible).toHaveBeenCalledWith(
      expect.objectContaining({ excludedUserIds: [HOST_ID] })
    );
  });

  it.each([
    ['entries', () => caller().getEntries({ crucibleId: CRUCIBLE_ID })],
    ['required models', () => caller().getRequiredModels({ id: CRUCIBLE_ID })],
    ['minimum votes', () => caller().getMinVotesToPlace({ id: CRUCIBLE_ID })],
    [
      'entry eligibility',
      () => caller().checkEntryEligibility({ crucibleId: CRUCIBLE_ID, imageIds: [1] }),
    ],
    ['judge count', () => caller().getJudgesCount({ crucibleId: CRUCIBLE_ID })],
    ['follow', () => caller().toggleFollow({ crucibleId: CRUCIBLE_ID, setTo: true })],
    ['judging progress', () => caller().getJudgingProgress({ crucibleId: CRUCIBLE_ID })],
    ['judging pair', () => caller().getJudgingPair({ crucibleId: CRUCIBLE_ID })],
    [
      'vote',
      () => caller().submitVote({ crucibleId: CRUCIBLE_ID, winnerEntryId: 1, loserEntryId: 2 }),
    ],
    ['entry', () => caller().submitEntry({ crucibleId: CRUCIBLE_ID, imageId: 1 })],
  ])('gets not found for the crucible’s %s', async (__, call) => {
    await expect(call()).rejects.toThrow(NOT_FOUND);
    expect(dbMock.dbWrite.crucibleEngagement.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('still lets a moderator follow, and read the side endpoints', async () => {
    const mod = caller(signedIn(1, true));

    await expect(mod.toggleFollow({ crucibleId: CRUCIBLE_ID, setTo: true })).resolves.toBe(true);
    await expect(mod.getJudgesCount({ crucibleId: CRUCIBLE_ID })).resolves.toEqual({ count: 3 });
    await expect(mod.getRequiredModels({ id: CRUCIBLE_ID })).resolves.toBeDefined();
  });
});

describe('a viewer with no block either way', () => {
  it('sees the detail page and the side endpoints', async () => {
    await expect(caller().getById({ id: CRUCIBLE_ID })).resolves.toBeTruthy();
    await expect(caller().getJudgesCount({ crucibleId: CRUCIBLE_ID })).resolves.toEqual({
      count: 3,
    });
    await expect(caller().toggleFollow({ crucibleId: CRUCIBLE_ID, setTo: true })).resolves.toBe(
      true
    );
  });

  it('gets not found for the judge count of a crucible that does not exist', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(null);

    await expect(caller().getJudgesCount({ crucibleId: CRUCIBLE_ID })).rejects.toThrow(NOT_FOUND);
  });
});

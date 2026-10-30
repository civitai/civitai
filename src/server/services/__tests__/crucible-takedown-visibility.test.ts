import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

/**
 * A moderator's takedown hides the crucible from everyone but moderators: the detail page gives
 * the owner a removed view with the reason and everyone else nothing, and every side endpoint is
 * not-found. Drives the REAL router.
 */

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  BlockedByUsers: { getCached: async () => [] },
  BlockedUsers: { getCached: async () => [] },
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ crucible: true }),
}));

import { crucibleRouter } from '~/server/routers/crucible.router';
import { assertCrucibleVisible } from '~/server/services/crucible.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const CRUCIBLE_ID = 213;
const OWNER_ID = 555;
const STRANGER_ID = 999;
const MOD_ID = 1;
const NOT_FOUND = 'Crucible not found';
const REASON = 'Brief breaks the content rules';

const signedIn = (id: number, isModerator = false) => ({
  id,
  isModerator,
  tier: 'free',
  muted: false,
  bannedAt: null,
  onboarding: 0x1f,
  emailVerified: new Date('2026-01-01'),
});

const caller = (user: ReturnType<typeof signedIn> | undefined) =>
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

const takenDown = {
  id: CRUCIBLE_ID,
  userId: OWNER_ID,
  name: 'A crucible',
  description: 'The brief',
  buzzType: 'yellow',
  nsfwLevel: 1,
  textNsfw: false,
  ingestion: 'Scanned',
  image: { id: 5, ingestion: 'Scanned' },
  heroImage: { id: 6, ingestion: 'Scanned' },
  status: CrucibleStatus.Cancelled,
  entryFee: 100,
  seededPrizePool: 0,
  prizePositions: [],
  endAt: new Date(Date.now() + 60_000),
  startAt: new Date(Date.now() - 60_000),
  createdAt: new Date(Date.now() - 120_000),
  allowedResources: [],
  allowedBaseModels: [],
  minViewSeconds: null,
  takenDownAt: new Date('2026-10-30T07:19:00Z'),
  takedownReason: REASON,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.crucible.findUnique.mockResolvedValue(takenDown);
  dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([]);
  dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([]);
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  dbMock.dbRead.crucibleEntry.count.mockResolvedValue(0);
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    meta: { scores: { total: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } },
  });
  redisMock.sysRedis.sCard.mockResolvedValue(0);
});

const viewers = [
  ['a signed-out visitor', undefined],
  ['a signed-in stranger', signedIn(STRANGER_ID)],
] as const;

describe.each(viewers)('%s', (_, user) => {
  it('gets no crucible from the detail page', async () => {
    await expect(caller(user).getById({ id: CRUCIBLE_ID })).resolves.toBeNull();
  });

  it.each([
    ['entries', () => caller(user).getEntries({ crucibleId: CRUCIBLE_ID })],
    ['required models', () => caller(user).getRequiredModels({ id: CRUCIBLE_ID })],
    ['judge count', () => caller(user).getJudgesCount({ crucibleId: CRUCIBLE_ID })],
  ])('gets not found for its %s', async (_, call) => {
    await expect(call()).rejects.toThrow(NOT_FOUND);
  });

  it('gets not found for its comment thread', async () => {
    await expect(
      assertCrucibleVisible(CRUCIBLE_ID, { viewerId: user?.id, isModerator: false })
    ).rejects.toThrow(NOT_FOUND);
  });
});

describe('a signed-in stranger', () => {
  it.each([
    ['minimum votes', () => caller(signedIn(STRANGER_ID)).getMinVotesToPlace({ id: CRUCIBLE_ID })],
    [
      'entry eligibility',
      () =>
        caller(signedIn(STRANGER_ID)).checkEntryEligibility({
          crucibleId: CRUCIBLE_ID,
          imageIds: [1],
        }),
    ],
    [
      'follow',
      () => caller(signedIn(STRANGER_ID)).toggleFollow({ crucibleId: CRUCIBLE_ID, setTo: true }),
    ],
    [
      'judging progress',
      () => caller(signedIn(STRANGER_ID)).getJudgingProgress({ crucibleId: CRUCIBLE_ID }),
    ],
    [
      'judging pair',
      () => caller(signedIn(STRANGER_ID)).getJudgingPair({ crucibleId: CRUCIBLE_ID }),
    ],
    [
      'entry',
      () => caller(signedIn(STRANGER_ID)).submitEntry({ crucibleId: CRUCIBLE_ID, imageId: 1 }),
    ],
    [
      'entry post',
      () => caller(signedIn(STRANGER_ID)).createEntryPost({ crucibleId: CRUCIBLE_ID }),
    ],
  ])('gets not found for its %s', async (_, call) => {
    await expect(call()).rejects.toThrow(NOT_FOUND);
  });

  it('cannot take a crucible down', async () => {
    await expect(
      caller(signedIn(STRANGER_ID)).takeDown({ id: CRUCIBLE_ID, reason: REASON })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('the owner', () => {
  it('sees the removed state and the reason, not the brief, cover or entries', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([{ id: 1, image: { id: 9 } }]);

    const crucible = await caller(signedIn(OWNER_ID)).getById({ id: CRUCIBLE_ID });

    expect(crucible).toMatchObject({
      id: CRUCIBLE_ID,
      takedownReason: REASON,
      description: null,
      image: null,
      heroImage: null,
      viewerEntries: [],
      prizeWinners: [],
    });
  });

  it('gets not found for its entries', async () => {
    await expect(
      caller(signedIn(OWNER_ID)).getEntries({ crucibleId: CRUCIBLE_ID })
    ).rejects.toThrow(NOT_FOUND);
  });

  it('cannot take their own crucible down', async () => {
    await expect(
      caller(signedIn(OWNER_ID)).takeDown({ id: CRUCIBLE_ID, reason: REASON })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('a moderator', () => {
  it('sees the full detail page with the takedown', async () => {
    await expect(
      caller(signedIn(MOD_ID, true)).getById({ id: CRUCIBLE_ID })
    ).resolves.toMatchObject({ description: 'The brief', takedownReason: REASON });
  });

  it('can still list its entries and open its comment thread', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ count: 0 }]);
    await expect(
      caller(signedIn(MOD_ID, true)).getEntries({ crucibleId: CRUCIBLE_ID })
    ).resolves.toBeTruthy();
    await expect(
      assertCrucibleVisible(CRUCIBLE_ID, { viewerId: MOD_ID, isModerator: true })
    ).resolves.toBeUndefined();
  });
});

describe('a crucible an owner cancelled', () => {
  it('keeps its public detail page', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...takenDown,
      takenDownAt: null,
      takedownReason: null,
    });

    await expect(caller(undefined).getById({ id: CRUCIBLE_ID })).resolves.toMatchObject({
      description: 'The brief',
    });
  });
});

describe('the list feed', () => {
  // A crucible taken down after it completed stays Completed, so the Cancelled filter misses it.
  const rows = [
    { id: 1, status: CrucibleStatus.Completed, takenDownAt: new Date() },
    { id: 2, status: CrucibleStatus.Completed, takenDownAt: null },
  ];
  beforeEach(() => {
    dbMock.dbRead.crucible.findMany.mockImplementation(
      async ({ where }: { where: { takenDownAt?: null } }) =>
        rows
          .filter((r) => !('takenDownAt' in where) || r.takenDownAt === where.takenDownAt)
          .map(({ id }) => ({ id }))
    );
  });

  it('leaves a taken-down completed crucible out for everyone but moderators', async () => {
    const list = (user?: ReturnType<typeof signedIn>) =>
      caller(user)
        .getInfinite({ status: [CrucibleStatus.Completed] })
        .then((page) => page.items.map((item: { id: number }) => item.id));

    await expect(list()).resolves.toEqual([2]);
    await expect(list(signedIn(OWNER_ID))).resolves.toEqual([2]);
    await expect(list(signedIn(MOD_ID, true))).resolves.toEqual([1, 2]);
  });
});

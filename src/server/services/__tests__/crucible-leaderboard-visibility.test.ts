import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import type * as CrucibleService from '~/server/services/crucible.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * A crucible's ranking is secret until it ends: a live leaderboard tells judges which entry is
 * already winning, which is the thing the head-to-head vote is supposed to decide.
 *
 * Drives the REAL router through `createCaller`, so what a caller receives is what decides —
 * not the service in isolation. `getById` is a public procedure, so the plumbing of the caller's
 * own id into the service is part of the behaviour under test.
 */

const { mockGetJudgingPair } = vi.hoisted(() => ({ mockGetJudgingPair: vi.fn() }));

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  getJudgingPair: mockGetJudgingPair,
}));

// Every procedure here sits behind `isFlagProtected('crucible')`. Left off, the assertions below
// would pass on the flag's FORBIDDEN rather than on the redaction they are meant to test.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ crucible: true }),
}));

import { crucibleRouter } from '~/server/routers/crucible.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const findUnique = dbMock.dbRead.crucible.findUnique;

const CRUCIBLE_ID = 7;
const OWNER_ID = 102;
const STRANGER_ID = 999;

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { crucible: true } as never,
    track: undefined,
  };
}

const signedIn = (id: number) => ({
  id,
  isModerator: false,
  tier: 'free',
  muted: false,
  bannedAt: null,
  onboarding: 0x1f,
  emailVerified: new Date('2026-01-01'),
});

const caller = (user?: unknown) => crucibleRouter.createCaller(fakeCtx(user) as never);

const START = new Date('2026-09-01T00:00:00Z').getTime();

const entry = ({
  id,
  userId,
  score,
  position,
  minutes,
}: {
  id: number;
  userId: number;
  score: number;
  position: number | null;
  minutes: number;
}) => ({
  id,
  userId,
  imageId: id * 10,
  score,
  position,
  createdAt: new Date(START + minutes * 60_000),
  user: { id: userId, username: `user${userId}`, image: null },
  image: {
    id: id * 10,
    name: `entry-${id}`,
    url: `image-${id}`,
    nsfwLevel: 1,
    width: 512,
    height: 512,
  },
});

/**
 * Entry time, score and the order the database hands them back are three DIFFERENT orders here,
 * so neither ordering assertion below can pass by accident.
 */
const earliestAndLast = entry({ id: 1, userId: 101, score: 1200, position: 3, minutes: 0 });
const ownedAndFirst = entry({ id: 2, userId: OWNER_ID, score: 1800, position: 1, minutes: 5 });
const latestAndSecond = entry({ id: 3, userId: 103, score: 1500, position: 2, minutes: 10 });

const crucibleRow = (
  status: CrucibleStatus,
  entries = [latestAndSecond, earliestAndLast, ownedAndFirst]
) => ({
  id: CRUCIBLE_ID,
  userId: 1,
  name: 'Test Crucible',
  status,
  entryFee: 100,
  entries,
  _count: { entries: entries.length },
});

const ids = (entries: { id: number }[]) => entries.map((e) => e.id);

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(crucibleRow(CrucibleStatus.Active));
});

describe('crucible.getById — while the crucible is still running', () => {
  it.each([CrucibleStatus.Pending, CrucibleStatus.Active])(
    'gives a caller who owns no entries no score and no position (%s)',
    async (status) => {
      findUnique.mockResolvedValue(crucibleRow(status));

      const crucible = await caller(signedIn(STRANGER_ID)).getById({ id: CRUCIBLE_ID });

      expect(crucible!.entries).toHaveLength(3);
      for (const e of crucible!.entries) {
        expect(e.score).toBeNull();
        expect(e.position).toBeNull();
      }
    }
  );

  it('gives an anonymous caller no score and no position', async () => {
    const crucible = await caller(undefined).getById({ id: CRUCIBLE_ID });

    expect(crucible!.entries.map((e) => e.score)).toEqual([null, null, null]);
    expect(crucible!.entries.map((e) => e.position)).toEqual([null, null, null]);
  });

  it('gives the caller their own score and position, and nobody else any', async () => {
    const crucible = await caller(signedIn(OWNER_ID)).getById({ id: CRUCIBLE_ID });

    const own = crucible!.entries.find((e) => e.id === ownedAndFirst.id);
    expect(own).toMatchObject({ score: 1800, position: 1 });

    const others = crucible!.entries.filter((e) => e.id !== ownedAndFirst.id);
    expect(others.map((e) => e.score)).toEqual([null, null]);
    expect(others.map((e) => e.position)).toEqual([null, null]);
  });

  it('returns entries in entry-time order, which is not their score order', async () => {
    const crucible = await caller(signedIn(STRANGER_ID)).getById({ id: CRUCIBLE_ID });

    expect(ids(crucible!.entries)).toEqual([1, 2, 3]);
    expect(ids(crucible!.entries)).not.toEqual([2, 3, 1]);
  });

  it('does not ask postgres for a score ordering either', async () => {
    await caller(signedIn(STRANGER_ID)).getById({ id: CRUCIBLE_ID });

    const { select } = findUnique.mock.calls[0][0] as {
      select: { entries: { orderBy: unknown } };
    };
    expect(select.entries.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('returns null for a crucible that does not exist', async () => {
    findUnique.mockResolvedValue(null);

    expect(await caller(signedIn(OWNER_ID)).getById({ id: CRUCIBLE_ID })).toBeNull();
  });
});

describe('crucible.getById — once the crucible is over', () => {
  it.each([CrucibleStatus.Completed, CrucibleStatus.Cancelled])(
    'reveals every score and position (%s)',
    async (status) => {
      findUnique.mockResolvedValue(crucibleRow(status));

      const crucible = await caller(signedIn(STRANGER_ID)).getById({ id: CRUCIBLE_ID });

      expect(crucible!.entries.map((e) => e.score)).toEqual([1800, 1500, 1200]);
      expect(crucible!.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    }
  );

  it('orders entries by score, highest first', async () => {
    findUnique.mockResolvedValue(crucibleRow(CrucibleStatus.Completed));

    const crucible = await caller(undefined).getById({ id: CRUCIBLE_ID });

    expect(ids(crucible!.entries)).toEqual([2, 3, 1]);
  });

  it('ranks the earlier entry first on a tied score', async () => {
    const later = entry({ id: 20, userId: 201, score: 1500, position: 2, minutes: 30 });
    const earlier = entry({ id: 21, userId: 202, score: 1500, position: 1, minutes: 10 });
    findUnique.mockResolvedValue(crucibleRow(CrucibleStatus.Completed, [later, earlier]));

    const crucible = await caller(undefined).getById({ id: CRUCIBLE_ID });

    expect(ids(crucible!.entries)).toEqual([21, 20]);
  });
});

describe('crucible.getJudgingPair', () => {
  const judgingEntry = (id: number, userId: number, score: number) => ({
    id,
    imageId: id * 10,
    userId,
    score,
    image: { id: id * 10, url: `image-${id}`, width: 512, height: 512, nsfwLevel: 1 },
    user: { id: userId, username: `user${userId}`, deletedAt: null, image: null },
  });

  it('hands the judge two entries carrying no ELO score', async () => {
    mockGetJudgingPair.mockResolvedValue({
      left: judgingEntry(1, 101, 1800),
      right: judgingEntry(2, 102, 1200),
    });

    const pair = await caller(signedIn(STRANGER_ID)).getJudgingPair({ crucibleId: CRUCIBLE_ID });

    expect(pair).not.toBeNull();
    expect(pair!.left).not.toHaveProperty('score');
    expect(pair!.right).not.toHaveProperty('score');
    expect(pair!.left.id).toBe(1);
  });

  it('passes an exhausted pair through as null', async () => {
    mockGetJudgingPair.mockResolvedValue(null);

    expect(
      await caller(signedIn(STRANGER_ID)).getJudgingPair({ crucibleId: CRUCIBLE_ID })
    ).toBeNull();
  });

  it('refuses an anonymous judge', async () => {
    await expect(
      caller(undefined).getJudgingPair({ crucibleId: CRUCIBLE_ID })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetJudgingPair).not.toHaveBeenCalled();
  });
});

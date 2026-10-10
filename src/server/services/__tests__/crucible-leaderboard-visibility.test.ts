import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';
import type * as ImageService from '~/server/services/image.service';
import type * as CrucibleService from '~/server/services/crucible.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

/**
 * A crucible's ranking is secret until it ends: a live leaderboard tells judges which entry is
 * already winning, which is the thing the head-to-head vote is supposed to decide.
 *
 * Drives the REAL router through `createCaller`, so what a caller receives is what decides —
 * not the service in isolation. `getById` is a public procedure, so the plumbing of the caller's
 * own id into the service is part of the behaviour under test.
 */

const { mockGetJudgingPair, imagesFetch, blockedBy } = vi.hoisted(() => ({
  mockGetJudgingPair: vi.fn(),
  imagesFetch: vi.fn(),
  blockedBy: vi.fn(),
}));

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  BlockedByUsers: { getCached: blockedBy },
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  imagesForModelVersionsCache: { fetch: imagesFetch },
}));

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

const caller = (user?: unknown, features: Record<string, boolean> = {}) =>
  crucibleRouter.createCaller({
    ...fakeCtx(user),
    features: { crucible: true, ...features },
  } as never);

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

const findEntries = dbMock.dbRead.crucibleEntry.findMany;
const judgeHasMinScore = () =>
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    meta: { scores: { total: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } },
  });
const queryRaw = dbMock.dbRead.$queryRaw;
const rows = [latestAndSecond, earliestAndLast, ownedAndFirst];

const ids = (entries: { id: number }[]) => entries.map((e) => e.id);
const lastFindManyArgs = () =>
  findEntries.mock.calls.at(-1)![0] as { orderBy: unknown; take: number; cursor?: unknown };
/** The raw query's text, nested `Prisma.sql` fragments included, with its bound values. */
/** The raw query as Postgres receives it, nested fragments in place. */
const lastRendered = () => {
  const [strings, ...values] = queryRaw.mock.calls.at(-1) as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
};
const lastRenderedSql = () => lastRendered().text.replace(/\s+/g, ' ');
const lastRawQuery = () => {
  const [strings, ...values] = queryRaw.mock.calls.at(-1) as [TemplateStringsArray, ...unknown[]];
  const fragments = values.filter(
    (value): value is { strings: string[] } =>
      !!value && typeof value === 'object' && 'strings' in value
  );
  return {
    text: [...strings, ...fragments.flatMap((fragment) => fragment.strings)].join(' '),
    values,
  };
};

/**
 * A review hold, a ToS flag or an unpublished post after submission takes the entry out; a post
 * scheduled for the crucible's end does not.
 */
const expectEnteredEntryImage = (sql: string) => {
  expect(sql).toContain('i."needsReview" IS NULL');
  expect(sql).toContain('NOT i."tosViolation"');
  expect(sql).toMatch(
    /EXISTS \( ?SELECT 1 FROM "Post" ep WHERE ep\.id = i\."postId" AND ep\."publishedAt" IS NOT NULL ?\)/
  );
};

/** A crucible that passed its scans and accepts mature entries, so only off the green site. */
const scanned = {
  userId: 555,
  buzzType: 'yellow',
  nsfwLevel: 31,
  textNsfw: false,
  ingestion: 'Scanned',
  image: { ingestion: 'Scanned' },
};

beforeEach(() => {
  vi.clearAllMocks();
  blockedBy.mockResolvedValue([]);
  findUnique.mockResolvedValue({ ...scanned, status: CrucibleStatus.Active });
  findEntries.mockImplementation(async () => [...rows]);
  queryRaw.mockResolvedValue(ids(rows).map((id) => ({ id })));
  dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([]);
});

describe('crucible.getEntries — while the crucible is still running', () => {
  it.each([CrucibleStatus.Pending, CrucibleStatus.Active])(
    'gives a caller who owns no entries no score and no position (%s)',
    async (status) => {
      findUnique.mockResolvedValue({ ...scanned, status });

      const { items } = await caller(signedIn(STRANGER_ID)).getEntries({ crucibleId: CRUCIBLE_ID });

      expect(items).toHaveLength(3);
      for (const e of items) {
        expect(e.score).toBeNull();
        expect(e.position).toBeNull();
      }
    }
  );

  it('gives an anonymous caller no score and no position', async () => {
    const { items } = await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID });

    expect(items.map((e) => e.score)).toEqual([null, null, null]);
    expect(items.map((e) => e.position)).toEqual([null, null, null]);
  });

  it('gives the caller their own score and position, and nobody else any', async () => {
    const { items } = await caller(signedIn(OWNER_ID)).getEntries({ crucibleId: CRUCIBLE_ID });

    expect(items.find((e) => e.id === ownedAndFirst.id)).toMatchObject({
      score: 1800,
      position: 1,
    });
    const others = items.filter((e) => e.id !== ownedAndFirst.id);
    expect(others.map((e) => e.score)).toEqual([null, null]);
    expect(others.map((e) => e.position)).toEqual([null, null]);
  });

  it('asks postgres for a seeded shuffle, never a score ordering', async () => {
    await caller(signedIn(STRANGER_ID)).getEntries({ crucibleId: CRUCIBLE_ID, seed: 42 });

    const { text, values } = lastRawQuery();
    expect(text).toMatch(/ORDER BY md5\(/);
    expect(text).not.toMatch(/score/i);
    expect(values).toContain(':42');
  });

  it('returns entries in the order postgres shuffled them, not the order they were loaded', async () => {
    findEntries.mockResolvedValue([ownedAndFirst, earliestAndLast, latestAndSecond]);

    const { items } = await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID });

    expect(ids(items)).toEqual(ids(rows));
  });

  it('rejects a crucible that does not exist', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      caller(signedIn(OWNER_ID)).getEntries({ crucibleId: CRUCIBLE_ID })
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

describe('crucible.getEntries — once the crucible is over', () => {
  it.each([CrucibleStatus.Completed, CrucibleStatus.Cancelled])(
    'reveals every score and position (%s)',
    async (status) => {
      findUnique.mockResolvedValue({ ...scanned, status });
      queryRaw.mockResolvedValue(
        ids([ownedAndFirst, latestAndSecond, earliestAndLast]).map((id) => ({ id }))
      );

      const { items } = await caller(signedIn(STRANGER_ID)).getEntries({ crucibleId: CRUCIBLE_ID });

      expect(items.map((e) => e.score)).toEqual([1800, 1500, 1200]);
      expect(items.map((e) => e.position)).toEqual([1, 2, 3]);
    }
  );

  it('pages by placing, unplaced entries last by score, the earlier entry first, with a LIMIT', async () => {
    findUnique.mockResolvedValue({ ...scanned, status: CrucibleStatus.Completed });

    await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID, limit: 2 });

    // Prisma drops the LIMIT for a nullable column in orderBy with a cursor, so this is SQL.
    expect(lastRenderedSql()).toMatch(
      /ORDER BY COALESCE\(ce\.position, \$\d+::int\), -ce\.score, ce\."createdAt", ce\.id LIMIT \$\d+/
    );
    expect(lastRawQuery().values).toContain(3);
    expect(lastFindManyArgs().orderBy).toBeUndefined();
  });
});

describe('crucible.getEntries — podium', () => {
  const first = entry({ id: 1, userId: OWNER_ID, score: 1800, position: 1, minutes: 0 });
  const second = entry({ id: 2, userId: OWNER_ID, score: 1700, position: 2, minutes: 5 });
  const third = entry({ id: 3, userId: 103, score: 1500, position: 3, minutes: 10 });
  const fourth = entry({ id: 4, userId: 104, score: 1400, position: 4, minutes: 15 });
  const fifth = entry({ id: 5, userId: 105, score: 1300, position: 5, minutes: 20 });
  const all = [first, second, third, fourth, fifth];
  const placings = all.map(({ id, userId, position }) => ({
    crucibleId: CRUCIBLE_ID,
    entryId: id,
    userId,
    position,
  }));
  const rendered = ([strings, ...values]: unknown[]) =>
    Prisma.sql(strings as TemplateStringsArray, ...values).text.replace(/\s+/g, ' ');
  const isPlacingsQuery = (sql: string) => sql.includes('ce.position IS NOT NULL');
  const isPodiumQuery = (sql: string) => /WHERE ce\.id = ANY\(\$\d+::int\[\]\)/.test(sql);
  const podiumQuery = () => queryRaw.mock.calls.map(rendered).find(isPodiumQuery);
  const podiumIds = ([strings, ...values]: unknown[]) =>
    Prisma.sql(strings as TemplateStringsArray, ...values).values.find(Array.isArray) as number[];
  const visibleRow = (id: number) => ({ id, imageVisible: true });
  const completedWith = (prizePositions: Record<string, number>) =>
    findUnique.mockResolvedValue({ ...scanned, status: CrucibleStatus.Completed, prizePositions });

  beforeEach(() => {
    completedWith({ '1': 60, '2': 40 });
    findEntries.mockImplementation(async () => all);
    queryRaw.mockImplementation(async (...call: unknown[]) => {
      const sql = rendered(call);
      if (isPlacingsQuery(sql)) return placings;
      // Every requested winner is visible; returned out of prize order.
      if (isPodiumQuery(sql)) return [...podiumIds(call)].reverse().map(visibleRow);
      return all.map(({ id }) => ({ id }));
    });
  });

  it("puts the next creator on the podium in place of a creator's second entry", async () => {
    const { items, podium } = await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID });

    expect(items.map((e) => [e.id, e.position])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
    expect(podium.map((e) => [e.id, e.position, e.prizePlace])).toEqual([
      [1, 1, 1],
      [3, 3, 2],
    ]);
  });

  it('caps the podium at three prizes when more are paid', async () => {
    completedWith({ '1': 40, '2': 30, '3': 20, '4': 10 });

    const { podium } = await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID });

    expect(podium.map((e) => [e.id, e.prizePlace])).toEqual([
      [1, 1],
      [3, 2],
      [4, 3],
    ]);
  });

  it("judges a podium image by its moderation and the crucible's levels, not the viewer's", async () => {
    await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID, browsingLevel: 1 });

    const sql = podiumQuery();
    expect(sql).toBeDefined();
    expect(sql).toMatch(
      /LEFT JOIN "Image" i ON i\.id = ce\."imageId" WHERE ce\.id = ANY\(\$\d+::int\[\]\) ?$/
    );
    expectEnteredEntryImage(sql!);
    expect(sql).toContain('i."nsfwLevel" &');
    expect(sql!.match(/i\."nsfwLevel" &/g)).toHaveLength(1);
  });

  it('keeps a winner whose image the viewer cannot see on the podium, without the image', async () => {
    const page = queryRaw.getMockImplementation()!;
    queryRaw.mockImplementation(async (...call: unknown[]) => {
      const rows = (await page(...call)) as { id: number }[];
      return isPodiumQuery(rendered(call))
        ? rows.map((row) => ({ ...row, imageVisible: row.id !== 3 }))
        : rows;
    });

    const { podium } = await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID });

    expect(podium.map((e) => [e.id, e.prizePlace, e.image?.url ?? null])).toEqual([
      [1, 1, 'image-1'],
      [3, 2, null],
    ]);
  });

  it('keeps a winner whose image was deleted on the podium', async () => {
    findEntries.mockImplementation(async () =>
      all.map((e) => (e.id === 3 ? { ...e, imageId: null, image: null } : e))
    );

    const { podium } = await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID });

    expect(podium.map((e) => [e.id, e.prizePlace, e.image])).toEqual([
      [1, 1, expect.objectContaining({ url: 'image-1' })],
      [3, 2, null],
    ]);
  });

  it('withholds the url, not the hash, of a mature winner image on green', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      nsfwLevel: 3,
      status: CrucibleStatus.Completed,
      prizePositions: { '1': 60, '2': 40 },
    });
    findEntries.mockImplementation(async () =>
      all.map((e) => (e.id === 3 ? { ...e, image: { ...e.image, nsfwLevel: 2, hash: 'h3' } } : e))
    );

    const { podium } = await caller(undefined, { isGreen: true }).getEntries({
      crucibleId: CRUCIBLE_ID,
    });

    expect(podium.map((e) => [e.id, e.image?.url ?? null, e.image?.hash])).toEqual([
      [1, 'image-1', undefined],
      [3, null, 'h3'],
    ]);
  });

  it('shows a signed-in creator their own podium image', async () => {
    await caller(signedIn(OWNER_ID)).getEntries({ crucibleId: CRUCIBLE_ID });

    expect(podiumQuery()).toMatch(/COALESCE\(\(ce\."userId" = \$\d+ OR \(/);
    const call = queryRaw.mock.calls.find((c) => isPodiumQuery(rendered(c)))!;
    expect(Prisma.sql(call[0] as TemplateStringsArray, ...call.slice(1)).values).toContain(
      OWNER_ID
    );
  });

  it('sends no podium with a later page', async () => {
    const { podium } = await caller(undefined).getEntries({ crucibleId: CRUCIBLE_ID, cursor: 3 });

    expect(podium).toEqual([]);
    expect(podiumQuery()).toBeUndefined();
  });
});

describe('crucible.getById — prize winners', () => {
  const completed = {
    ...scanned,
    id: CRUCIBLE_ID,
    status: CrucibleStatus.Completed,
    entryFee: 100,
    seededPrizePool: 0,
    prizePositions: { '1': 50, '2': 30, '3': 20 },
  };

  it('pays one prize per creator from the stored placings once completed', async () => {
    findUnique.mockResolvedValue(completed);
    dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([
      { crucibleId: CRUCIBLE_ID, _count: { _all: 6 } },
    ]);
    queryRaw.mockResolvedValue(
      [
        [1, 10, 1],
        [2, 10, 2],
        [3, 10, 3],
        [4, 11, 4],
        [5, 12, 5],
        [6, 13, 6],
      ].map(([entryId, userId, position]) => ({
        crucibleId: CRUCIBLE_ID,
        entryId,
        userId,
        position,
      }))
    );

    const crucible = await caller(undefined).getById({ id: CRUCIBLE_ID });

    expect(crucible?.prizeWinners).toEqual([
      { entryId: 1, position: 1, prizePlace: 1, prizeAmount: 300 },
      { entryId: 4, position: 4, prizePlace: 2, prizeAmount: 180 },
      { entryId: 5, position: 5, prizePlace: 3, prizeAmount: 120 },
    ]);
    expect(lastRenderedSql()).toMatch(
      /WHERE ce\."crucibleId" = ANY\(\$1::int\[\]\) AND ce\.position IS NOT NULL\s*$/
    );
    expect(lastRendered().values).toEqual([[CRUCIBLE_ID]]);
  });

  it('has no prize winners while the crucible runs', async () => {
    const crucible = await caller(undefined).getById({ id: CRUCIBLE_ID });

    expect(crucible?.prizeWinners).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('crucible.getRequiredModels', () => {
  const findVersions = dbMock.dbRead.modelVersion.findMany;
  const cover = (id: number, nsfwLevel: number) => ({
    id,
    url: `cover-${id}`,
    nsfwLevel,
    hash: 'h',
    width: 512,
    height: 512,
    type: 'image',
  });
  const requiring = (allowedResources: number[] | null) =>
    findUnique.mockResolvedValue({ ...scanned, status: CrucibleStatus.Active, allowedResources });

  beforeEach(() => {
    findVersions.mockResolvedValue([
      { id: 101, name: 'SDXL V1.0', baseModel: 'SDXL 1.0', model: { id: 9, name: 'Gyroid' } },
    ]);
  });

  it('lists each required version with its model, base model and a cover the viewer may see', async () => {
    requiring([101]);
    imagesFetch.mockResolvedValue({
      101: { images: [cover(1, 4), { ...cover(2, 1), extra: 'x' }] },
    });

    const models = await caller(undefined).getRequiredModels({ id: CRUCIBLE_ID, browsingLevel: 1 });

    expect(models).toEqual([
      {
        id: 9,
        name: 'Gyroid',
        versionId: 101,
        versionName: 'SDXL V1.0',
        baseModel: 'SDXL 1.0',
        image: cover(2, 1),
      },
    ]);
  });

  it('sends no cover when every image is above the viewer level', async () => {
    requiring([101]);
    imagesFetch.mockResolvedValue({ 101: { images: [cover(1, 4)] } });

    const [model] = await caller(undefined).getRequiredModels({
      id: CRUCIBLE_ID,
      browsingLevel: 1,
    });

    expect(model.image).toBeNull();
  });

  it('caps the cover at the SFW levels on the green site whatever level is asked for', async () => {
    requiring([101]);
    imagesFetch.mockResolvedValue({ 101: { images: [cover(1, 4)] } });
    findUnique.mockResolvedValue({
      ...scanned,
      nsfwLevel: 1 | 2,
      status: CrucibleStatus.Active,
      allowedResources: [101],
    });

    const [model] = await caller(signedIn(STRANGER_ID), { isGreen: true }).getRequiredModels({
      id: CRUCIBLE_ID,
      browsingLevel: 31,
    });

    expect(model.image).toBeNull();
  });

  it('looks nothing up when any model may enter', async () => {
    requiring(null);

    expect(await caller(undefined).getRequiredModels({ id: CRUCIBLE_ID })).toEqual([]);
    expect(findVersions).not.toHaveBeenCalled();
  });

  it('is not found for a crucible still under review, like its entries', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      ingestion: 'Pending',
      status: CrucibleStatus.Active,
      allowedResources: [101],
    });

    await expect(
      caller(signedIn(STRANGER_ID)).getRequiredModels({ id: CRUCIBLE_ID })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(findVersions).not.toHaveBeenCalled();
  });

  it('is not found off its site, like its entries', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      status: CrucibleStatus.Active,
      allowedResources: [101],
    });

    await expect(
      caller(signedIn(STRANGER_ID), { isGreen: true }).getRequiredModels({ id: CRUCIBLE_ID })
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

describe('crucible.getJudgingProgress', () => {
  it("counts the caller's pairs left among the entries they can judge", async () => {
    queryRaw.mockResolvedValue([
      { crucibleId: CRUCIBLE_ID, id: 1 },
      { crucibleId: CRUCIBLE_ID, id: 2 },
      { crucibleId: CRUCIBLE_ID, id: 3 },
    ]);
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    redisMock.sysRedis.sMembers.mockResolvedValue(['1:2']);

    const progress = await caller(signedIn(STRANGER_ID)).getJudgingProgress({
      crucibleId: CRUCIBLE_ID,
    });

    expect(progress).toEqual({ remainingPairs: 2, judgedPairs: 1, votesUsedUp: false });
    expect(lastRenderedSql()).toContain('ce."userId" !=');
  });

  it('is not found for a crucible still under review, like its pairs', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      ingestion: 'Pending',
      status: CrucibleStatus.Active,
    });

    await expect(
      caller(signedIn(STRANGER_ID)).getJudgingProgress({ crucibleId: CRUCIBLE_ID })
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('has nothing left once the crucible has ended', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      status: CrucibleStatus.Active,
      endAt: new Date(Date.now() - 1000),
    });

    expect(
      await caller(signedIn(STRANGER_ID)).getJudgingProgress({ crucibleId: CRUCIBLE_ID })
    ).toEqual({ remainingPairs: 0, judgedPairs: 0, votesUsedUp: false });
  });

  // The judge page shows "you've used all your votes" only on votesUsedUp. Zero pairs from too few
  // visible entries is the browsing level hiding them, and must not read as votes spent.
  it('reports votes used up only when the judge exhausted pairs among entries they can see', async () => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    redisMock.sysRedis.sMembers.mockResolvedValue(['1:2']);

    queryRaw.mockResolvedValue([
      { crucibleId: CRUCIBLE_ID, id: 1 },
      { crucibleId: CRUCIBLE_ID, id: 2 },
    ]);
    expect(
      await caller(signedIn(STRANGER_ID)).getJudgingProgress({ crucibleId: CRUCIBLE_ID })
    ).toEqual({ remainingPairs: 0, judgedPairs: 1, votesUsedUp: true });

    queryRaw.mockResolvedValue([{ crucibleId: CRUCIBLE_ID, id: 1 }]);
    expect(
      await caller(signedIn(STRANGER_ID)).getJudgingProgress({ crucibleId: CRUCIBLE_ID })
    ).toEqual({ remainingPairs: 0, judgedPairs: 0, votesUsedUp: false });
  });
});

describe('crucible.getMinVotesToPlace', () => {
  const aggregate = dbMock.dbRead.crucibleEntry.aggregate;

  it('asks for 75% of the average vote count across the entries that can place', async () => {
    aggregate.mockResolvedValue({ _sum: { voteCount: 56 }, _count: { _all: 4 } });

    const result = await caller(signedIn(STRANGER_ID)).getMinVotesToPlace({ id: CRUCIBLE_ID });

    expect(result).toEqual({ minVotes: 11 });
    expect(aggregate.mock.calls[0][0].where).toMatchObject({
      crucibleId: CRUCIBLE_ID,
      image: {
        ingestion: { not: 'Blocked' },
        needsReview: null,
        tosViolation: false,
        post: { publishedAt: { not: null } },
      },
    });
  });

  it('is not found for a crucible still under review, like its entries', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      ingestion: 'Pending',
      status: CrucibleStatus.Active,
    });

    await expect(
      caller(signedIn(STRANGER_ID)).getMinVotesToPlace({ id: CRUCIBLE_ID })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(aggregate).not.toHaveBeenCalled();
  });
});

describe('crucible.getEntries — paging', () => {
  it('fetches one row past the page and hands back its id as the next cursor', async () => {
    const { items, nextCursor } = await caller(undefined).getEntries({
      crucibleId: CRUCIBLE_ID,
      limit: 2,
    });

    expect(lastRawQuery().values).toContain(3);
    expect(lastRawQuery().text).not.toMatch(/>=? \(md5\(/);
    expect(ids(items)).toEqual([3, 1]);
    expect(nextCursor).toBe(2);
  });

  // The cursor is the row fetched past the previous page and not returned, so it opens this one.
  it('continues from the cursor entry in shuffled order, and reports no more on a short page', async () => {
    queryRaw.mockResolvedValue([{ id: 2 }]);

    const { items, nextCursor } = await caller(undefined).getEntries({
      crucibleId: CRUCIBLE_ID,
      limit: 2,
      cursor: 2,
    });

    expect(lastRawQuery().text).toContain('>= (md5(');
    expect(ids(items)).toEqual([2]);
    expect(nextCursor).toBeUndefined();
  });

  it('continues from the cursor entry by placing once the ranking is final', async () => {
    findUnique.mockResolvedValue({ ...scanned, status: CrucibleStatus.Completed });
    queryRaw.mockResolvedValue([{ id: 1 }]);

    const { items, nextCursor } = await caller(undefined).getEntries({
      crucibleId: CRUCIBLE_ID,
      limit: 2,
      cursor: 2,
    });

    expect(lastRenderedSql()).toMatch(
      /AND \(COALESCE\(ce\.position, .*\) >= \(SELECT COALESCE\(c\.position, .* FROM "CrucibleEntry" c WHERE c\.id = \$\d+\)/
    );
    const cursorParam = Number(lastRenderedSql().match(/WHERE c\.id = \$(\d+)/)![1]);
    expect(lastRendered().values[cursorParam - 1]).toBe(2);
    expect(ids(items)).toEqual([1]);
    expect(nextCursor).toBeUndefined();
  });
});

describe('crucible.getById', () => {
  beforeEach(() => {
    findUnique.mockResolvedValue({ ...scanned, id: CRUCIBLE_ID, status: CrucibleStatus.Active });
    findEntries.mockResolvedValue([ownedAndFirst]);
  });

  it("returns only the caller's own entries, with their score", async () => {
    const crucible = await caller(signedIn(OWNER_ID)).getById({ id: CRUCIBLE_ID });

    expect(crucible).not.toHaveProperty('entries');
    expect(crucible!.viewerEntries).toEqual([ownedAndFirst]);
    expect(findEntries).toHaveBeenCalledWith(
      expect.objectContaining({ where: { crucibleId: CRUCIBLE_ID, userId: OWNER_ID } })
    );
  });

  it('frees the slot of an own entry whose image is gone, but counts it for the free-entry math', async () => {
    const imageGone = { ...latestAndSecond, userId: OWNER_ID, imageId: null, image: null };
    findEntries.mockResolvedValue([ownedAndFirst, imageGone]);

    const crucible = await caller(signedIn(OWNER_ID)).getById({ id: CRUCIBLE_ID });

    expect(crucible!.viewerEntries).toEqual([ownedAndFirst]);
    expect(crucible!.viewerEntryCount).toBe(1);
    expect(crucible!.viewerEntriesSoFar).toBe(2);
  });

  it('gives an anonymous caller no entries without querying for any', async () => {
    const crucible = await caller(undefined).getById({ id: CRUCIBLE_ID });

    expect(crucible!.viewerEntries).toEqual([]);
    expect(crucible!.viewerEntryCount).toBe(0);
    expect(findEntries).not.toHaveBeenCalled();
  });

  it('returns null for a crucible that does not exist', async () => {
    findUnique.mockResolvedValue(null);

    expect(await caller(signedIn(OWNER_ID)).getById({ id: CRUCIBLE_ID })).toBeNull();
  });
  it('shows a crucible created on the green site off it too', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      id: CRUCIBLE_ID,
      userId: 555,
      status: CrucibleStatus.Active,
      buzzType: 'green',
      nsfwLevel: 1 | 2,
    });

    expect(await caller(signedIn(STRANGER_ID)).getById({ id: CRUCIBLE_ID })).toMatchObject({
      id: CRUCIBLE_ID,
    });
  });
});

describe('crucible.getJudgingPair', () => {
  beforeEach(judgeHasMinScore);

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

describe('crucible.removeEntry', () => {
  it('is for moderators only, and touches nothing for anyone else', async () => {
    await expect(caller(signedIn(OWNER_ID)).removeEntry({ entryId: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(dbMock.dbWrite.crucibleEntry.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.crucibleEntry.delete).not.toHaveBeenCalled();
  });

  it("passes the moderator through, so one can't remove their own entry", async () => {
    dbMock.dbWrite.crucibleEntry.findUnique.mockResolvedValue({
      crucibleId: CRUCIBLE_ID,
      userId: STRANGER_ID,
      buzzTransactionId: null,
      crucible: { ...scanned, status: CrucibleStatus.Active, endAt: null, entryFee: 0 },
    });

    await expect(
      caller({ ...signedIn(STRANGER_ID), isModerator: true }).removeEntry({ entryId: 1 })
    ).rejects.toThrow("You can't remove your own entry");
  });
});

describe('a creator who blocked the caller', () => {
  beforeEach(() => {
    blockedBy.mockResolvedValue([{ id: scanned.userId }]);
    judgeHasMinScore();
  });

  it('hides the entries from them, as the detail page does', async () => {
    await expect(
      caller(signedIn(STRANGER_ID)).getEntries({ crucibleId: CRUCIBLE_ID })
    ).rejects.toThrow('Crucible not found');
  });

  it('still shows the entries to a moderator', async () => {
    await expect(
      caller({ ...signedIn(STRANGER_ID), isModerator: true }).getEntries({
        crucibleId: CRUCIBLE_ID,
      })
    ).resolves.toBeDefined();
  });

  it('hands judging the list of creators who blocked the caller', async () => {
    mockGetJudgingPair.mockResolvedValue(null);

    await caller(signedIn(STRANGER_ID)).getJudgingPair({ crucibleId: CRUCIBLE_ID });

    expect(mockGetJudgingPair).toHaveBeenCalledWith(
      expect.objectContaining({ blockedByUserIds: [scanned.userId] })
    );
  });

  it('hides their judging progress', async () => {
    await expect(
      caller(signedIn(STRANGER_ID)).getJudgingProgress({ crucibleId: CRUCIBLE_ID })
    ).rejects.toThrow('Crucible not found');
  });

  it('refuses their vote', async () => {
    await expect(
      caller(signedIn(STRANGER_ID)).submitVote({
        crucibleId: CRUCIBLE_ID,
        winnerEntryId: 1,
        loserEntryId: 3,
      })
    ).rejects.toThrow('Crucible not found');
  });

  it('refuses their entry', async () => {
    redisMock.sysRedis.set.mockResolvedValue('OK');

    await expect(
      caller(signedIn(STRANGER_ID)).submitEntry({ crucibleId: CRUCIBLE_ID, imageId: 1 })
    ).rejects.toThrow('Crucible not found');
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });
});

describe('crucible.getEntries — what a viewer may see', () => {
  it("while running, keeps the caller's own entries and others' only when scanned, published and in range", async () => {
    await caller(signedIn(STRANGER_ID)).getEntries({ crucibleId: CRUCIBLE_ID, browsingLevel: 1 });

    const sql = lastRenderedSql();
    expect(sql).toContain('JOIN "Image" i');
    expect(sql).toContain('ce."userId" =');
    expect(sql).toContain('i.ingestion =');
    expectEnteredEntryImage(sql);
  });

  it('once over, applies the same rule in the entries query', async () => {
    findUnique.mockResolvedValue({ ...scanned, status: CrucibleStatus.Completed, nsfwLevel: 1 });

    await caller(signedIn(STRANGER_ID)).getEntries({ crucibleId: CRUCIBLE_ID, browsingLevel: 1 });

    const sql = lastRenderedSql();
    expect(sql).toContain('ORDER BY COALESCE(ce.position');
    expect(sql).toContain('JOIN "Image" i');
    expect(sql).toContain('ce."userId" =');
    expect(sql).toContain('i.ingestion =');
    expectEnteredEntryImage(sql);
  });

  it('is not found for others while the crucible is under review', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      status: CrucibleStatus.Active,
      ingestion: 'Pending',
    });

    await expect(
      caller(signedIn(STRANGER_ID)).getEntries({ crucibleId: CRUCIBLE_ID })
    ).rejects.toThrow(/not found/i);
    await expect(
      caller(signedIn(555)).getEntries({ crucibleId: CRUCIBLE_ID })
    ).resolves.toBeTruthy();
  });

  it('is not found on the green site for a mature-site crucible', async () => {
    await expect(
      caller(signedIn(STRANGER_ID), { isGreen: true }).getEntries({ crucibleId: CRUCIBLE_ID })
    ).rejects.toThrow(/not found/i);
  });
});

describe('crucible.getById — review gates', () => {
  it('hides a crucible under review from everyone but its creator', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      id: CRUCIBLE_ID,
      status: CrucibleStatus.Active,
      ingestion: 'Pending',
    });
    findEntries.mockResolvedValue([]);

    expect(await caller(signedIn(STRANGER_ID)).getById({ id: CRUCIBLE_ID })).toBeNull();
    expect(await caller(signedIn(555)).getById({ id: CRUCIBLE_ID })).not.toBeNull();
  });

  it('drops a background image that has not passed its scan, for everyone but its creator', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      id: CRUCIBLE_ID,
      status: CrucibleStatus.Active,
      heroImage: { id: 3, ingestion: 'Pending' },
    });
    findEntries.mockResolvedValue([]);

    expect(
      (await caller(signedIn(STRANGER_ID)).getById({ id: CRUCIBLE_ID }))!.heroImage
    ).toBeNull();
    expect((await caller(signedIn(555)).getById({ id: CRUCIBLE_ID }))!.heroImage).toEqual({
      id: 3,
      ingestion: 'Pending',
    });
  });
});

describe('crucible.getById — adult text on the green site', () => {
  it("keeps a mature-site crucible's adult text off green, except for its creator", async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      id: CRUCIBLE_ID,
      status: CrucibleStatus.Active,
      name: 'Adult name',
      description: 'Adult description',
      textNsfw: true,
    });
    findEntries.mockResolvedValue([]);

    const stranger = await caller(signedIn(STRANGER_ID), { isGreen: true }).getById({
      id: CRUCIBLE_ID,
    });
    expect(stranger).toMatchObject({ name: 'Crucible', description: null });
    const creator = await caller(signedIn(555), { isGreen: true }).getById({ id: CRUCIBLE_ID });
    expect(creator).toMatchObject({ name: 'Adult name', description: 'Adult description' });
  });

  it("shows a crucible's clean text on green, even one accepting mature entries", async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      id: CRUCIBLE_ID,
      status: CrucibleStatus.Active,
      name: 'Clean name',
      description: 'Clean description',
      textNsfw: false,
    });
    findEntries.mockResolvedValue([]);

    const stranger = await caller(signedIn(STRANGER_ID), { isGreen: true }).getById({
      id: CRUCIBLE_ID,
    });
    expect(stranger).toMatchObject({ name: 'Clean name', description: 'Clean description' });
  });

  it('keeps adult text off green whatever currency the creator paid in', async () => {
    findUnique.mockResolvedValue({
      ...scanned,
      id: CRUCIBLE_ID,
      status: CrucibleStatus.Active,
      buzzType: 'green',
      nsfwLevel: 1,
      name: 'Adult name',
      description: 'Adult description',
      textNsfw: true,
    });
    findEntries.mockResolvedValue([]);

    const stranger = await caller(signedIn(STRANGER_ID), { isGreen: true }).getById({
      id: CRUCIBLE_ID,
    });
    expect(stranger).toMatchObject({ name: 'Crucible', description: null });
  });
});

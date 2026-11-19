import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import type { CandidateFilter, CandidateSource } from '~/server/services/semantic-search-client';
import type { SessionUser } from '~/types/session';
import { describeSemanticAuditContract } from './semantic-audit.harness';

const h = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  fetched: [] as number[][],
  // The feed filters each hydration was asked for.
  fetchArgs: [] as Record<string, unknown>[],
  follows: [] as number[],
  stripBenignPhrases: vi.fn(async (text: string) => text),
  includesInappropriate:
    vi.fn<(input: { prompt?: string }, nsfw?: boolean) => 'minor' | 'poi' | false>(),
  includesPoi: vi.fn<(prompt?: string) => string | false>(),
  includesMinor: vi.fn<(prompt?: string) => boolean>(),
  addons: [] as unknown[],
  isFlipt: vi.fn<(flag: string) => Promise<boolean>>(),
  evalBoolean: vi.fn<() => { enabled: unknown }>(),
  fliptClient: null as null | { evaluateBoolean: () => { enabled: unknown } },
}));
vi.mock('~/server/services/semantic-search-audit.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordSemanticAudit: h.recordAudit,
  recordRefusedSemanticAudit: h.recordAudit,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: h.isFlipt,
  ensureFliptInitialized: async () => undefined,
  getFliptClientSync: () => h.fliptClient,
}));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: h.stripBenignPhrases,
}));
vi.mock('~/server/services/search-query-rules', () => ({ matchesQueryRule: async () => false }));
vi.mock('~/utils/metadata/audit', () => ({
  includesNsfw: () => false,
  includesInappropriate: h.includesInappropriate,
  includesPoi: h.includesPoi,
  includesMinor: h.includesMinor,
}));
vi.mock('~/server/services/system-cache', () => ({
  getBrowsingSettingAddons: async () => h.addons,
}));

vi.mock('~/server/redis/caches', () => ({ getUserFollows: async () => h.follows }));

// The feed's fetch path: every id it is asked for comes back, owned by `owner(id)`.
const owner = (id: number) => (id >= 20 ? 7 : id);
vi.mock('~/server/services/article.service', () => ({
  getArticles: async (args: { ids: number[] }) => {
    const { ids } = args;
    h.fetched.push(ids);
    h.fetchArgs.push(args);
    return {
      items: ids.map((id) => ({
        id,
        user: { id: owner(id) },
        coverImage: id === 13 ? undefined : { id: id * 10, tags: [] },
      })),
    };
  },
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async () => ({
    hiddenUsers: [{ id: 901 }],
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: [
      { id: 801, hidden: true },
      { id: 802, hidden: false },
    ],
  }),
}));

const { searchSemanticArticles, MAX_HITS_PER_USER } = await import(
  '~/server/services/semantic-article-search.service'
);

// What the site's eligibility re-check reads. Article 11 is unlisted, 12's owner is banned, 14's
// owner is deleted: Qdrant can still propose all three.
const SCHEMA = `
  CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published');
  CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "userId" int NOT NULL REFERENCES "User"(id), unlisted boolean NOT NULL,
    "publishedAt" timestamp(3), status "ArticleStatus" NOT NULL,
    ingestion "ArticleIngestionStatus" NOT NULL, "tosViolation" boolean NOT NULL,
    availability "Availability" NOT NULL
  );
`;
const ELIGIBLE = `now(), 'Published', 'Scanned', false, 'Public'`;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  await harness.pg.exec(`
    INSERT INTO "User" VALUES (7, NULL, NULL), (10, NULL, NULL), (11, NULL, NULL),
      (12, now(), NULL), (13, NULL, NULL), (14, NULL, now());
    INSERT INTO "Article" VALUES (10, 10, false, ${ELIGIBLE}), (11, 11, true, ${ELIGIBLE}),
      (12, 12, false, ${ELIGIBLE}), (13, 13, false, ${ELIGIBLE}), (14, 14, false, ${ELIGIBLE});
    INSERT INTO "Article" SELECT g, 7, false, ${ELIGIBLE} FROM generate_series(20, 25) g;
  `);
});
afterAll(() => harness.stop());

let sent: CandidateFilter[];
const ranking =
  (ids: number[], correctedQuery?: string): CandidateSource =>
  async ({ filter, offset, limit }) => {
    sent.push(filter);
    return { ids: ids.slice(offset, offset + limit), correctedQuery };
  };

beforeEach(() => {
  h.isFlipt.mockReset().mockResolvedValue(false);
  h.evalBoolean.mockReset().mockReturnValue({ enabled: false });
  h.fliptClient = { evaluateBoolean: () => h.evalBoolean() };
  sent = [];
  h.fetched = [];
  h.fetchArgs = [];
  h.follows = [];
  h.stripBenignPhrases.mockReset().mockImplementation(async (text: string) => text);
  h.includesInappropriate.mockReset().mockReturnValue(false);
  h.includesPoi.mockReset().mockReturnValue(false);
  h.includesMinor.mockReset().mockReturnValue(false);
  h.addons = [];
  dbMock.dbRead.article.findMany.mockImplementation((args: never) =>
    harness.prisma.article.findMany(args)
  );
  // Calls are asserted per test, so none may carry over from an earlier one.
  dbMock.dbRead.articleEngagement.findMany.mockClear();
  dbMock.dbRead.collectionItem.findMany.mockClear();
});

const MOD = { id: 501, isModerator: true } as SessionUser;
const search = (ids: number[], browsingLevel = 1, user?: SessionUser) =>
  searchSemanticArticles({
    input: { query: 'guide', browsingLevel, limit: 10 },
    user,
    candidateSource: ranking(ids),
  });

describe('semantic article search', () => {
  it('re-checks eligibility: never shows an unlisted, banned-owner or deleted-owner article', async () => {
    const { items } = await search([11, 12, 14, 10]);
    expect(items.map((a) => a.id)).toEqual([10]);
    // The feed's fetch path is only asked for what passed the re-check.
    expect(h.fetched).toEqual([[10]]);
  });

  it('keeps rank order, caps one creator per page, and drops an article with no card image', async () => {
    const { items } = await search([20, 13, 21, 10, 22, 23, 24]);
    expect(items.map((a) => a.id)).toEqual([20, 21, 10, 22]);
    expect(items.filter((a) => a.user.id === 7)).toHaveLength(MAX_HITS_PER_USER);
  });

  it("asks the service for the viewer's browsing level, without hidden users or tags", async () => {
    await search([10], 1 | 4, MOD);
    expect(sent[0]).toMatchObject({
      gate: { kind: 'level', nsfwLevels: [1, 4] },
      excludedUserIds: [901],
      excludedTagIds: [801],
    });
  });
});

describe('semantic article search refinements', () => {
  // A refinement that names nothing must narrow to nothing, never fall back to every article.
  const refined = (input: { usernames?: string[]; tagNames?: string[] }) =>
    searchSemanticArticles({
      input: { query: 'guide', browsingLevel: 1, limit: 10, ...input },
      candidateSource: ranking([10]),
    });

  it('returns nothing for a username that does not exist, without asking the service', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([] as never);
    expect((await refined({ usernames: ['nobody'] })).items).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('returns nothing when any named tag does not exist, without asking the service', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([{ id: 1 }] as never);
    expect((await refined({ tagNames: ['anime', 'missing'] })).items).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('searches with the ids of names that all exist', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 10 }] as never);
    dbMock.dbRead.tag.findMany.mockResolvedValue([{ id: 1 }] as never);
    await refined({ usernames: ['someone'], tagNames: ['anime'] });
    expect(sent[0]).toMatchObject({ userIds: [10], tagIds: [1] });
  });
});

describe("the articles feed's filters", () => {
  const feedSearch = (input: Partial<Parameters<typeof searchSemanticArticles>[0]['input']>) =>
    searchSemanticArticles({
      input: { query: 'guide', browsingLevel: 1, limit: 10, ...input },
      user: { id: 5, isModerator: false } as SessionUser,
      candidateSource: ranking([10, 11]),
    });

  it("narrows the index to the feed's tags, beside any named ones", async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([{ id: 1 }] as never);
    await feedSearch({ tagIds: [4], tagNames: ['anime'] });
    expect(sent[0].tagIds).toEqual([1, 4]);
  });

  it("bounds the published date by the feed's period, to the hour, and not for all time", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-16T10:37:00Z'), toFake: ['Date'] });
    try {
      await feedSearch({ period: MetricTimeframe.Week });
      expect(sent[0].range).toEqual({ key: 'publishedAt', gte: '2026-11-09T10:00:00.000Z' });
      await feedSearch({ period: MetricTimeframe.AllTime });
      expect(sent[1].range).toEqual({ key: 'publishedAt', gte: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('narrows the index to the creators the viewer follows', async () => {
    h.follows = [7, 8];
    await feedSearch({ followed: true });
    expect(sent[0].userIds).toEqual([7, 8]);
  });

  it('finds nothing in Followed for a viewer who follows no one, without asking the service', async () => {
    expect((await feedSearch({ followed: true })).items).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('leaves a very long follow list to hydration rather than the index filter', async () => {
    h.follows = Array.from({ length: 1001 }, (_, i) => i + 1);
    await feedSearch({ followed: true });
    expect(sent[0].userIds).toBeUndefined();
    expect(h.fetchArgs[0]).toMatchObject({ followed: true });
  });

  // The viewer's Bookmarked/Hidden list and the collection, as getArticles reads them.
  const lists = (over: { engaged?: number[]; collected?: number[] }) => {
    dbMock.dbRead.articleEngagement.findMany.mockResolvedValue(
      (over.engaged ?? []).map((articleId) => ({ articleId })) as never
    );
    dbMock.dbRead.collectionItem.findMany.mockResolvedValue(
      (over.collected ?? []).map((articleId) => ({ articleId })) as never
    );
  };

  it("narrows the index to the viewer's bookmarks, so a short list is not a page of misses", async () => {
    lists({ engaged: [10, 20] });
    await feedSearch({ favorites: true });
    expect(sent[0].ids).toEqual([10, 20]);
    expect(dbMock.dbRead.articleEngagement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 5, type: 'Favorite' } })
    );
  });

  it('narrows the index to the hidden list in the Hidden view', async () => {
    lists({ engaged: [11] });
    await feedSearch({ hidden: true });
    expect(sent[0].ids).toEqual([11]);
    expect(dbMock.dbRead.articleEngagement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 5, type: 'Hide' } })
    );
  });

  it("narrows the index to the collection's articles, within the bookmarks when both apply", async () => {
    lists({ engaged: [10, 20, 21], collected: [21, 10, 30] });
    await feedSearch({ favorites: true, collectionId: 9 });
    expect(sent[0].ids).toEqual([10, 21]);
  });

  it('finds nothing for an empty list, without asking the service', async () => {
    lists({ engaged: [10], collected: [20] });
    expect((await feedSearch({ favorites: true, collectionId: 9 })).items).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('leaves a very long list to hydration rather than the index filter', async () => {
    lists({ collected: Array.from({ length: 1001 }, (_, i) => i + 1) });
    await feedSearch({ collectionId: 9 });
    expect(sent[0].ids).toBeUndefined();
    expect(h.fetchArgs[0]).toMatchObject({ collectionId: 9 });
    // Reads one past the cap, never the whole collection.
    expect(dbMock.dbRead.collectionItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { collectionId: 9, articleId: { not: null } },
        take: 1001,
      })
    );
  });

  it('narrows by the short list alone when the other is past the cap', async () => {
    // The long list lacks 10: intersecting it in would leave nothing.
    lists({ engaged: Array.from({ length: 1001 }, (_, i) => i + 100), collected: [10] });
    await feedSearch({ favorites: true, collectionId: 9 });
    expect(sent[0].ids).toEqual([10]);
    expect(dbMock.dbRead.articleEngagement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1001 })
    );
  });

  it("reads no one's bookmarks for a signed-out visitor", async () => {
    lists({ engaged: [10] });
    await searchSemanticArticles({
      input: { query: 'guide', browsingLevel: 1, limit: 10, favorites: true, hidden: true },
      candidateSource: ranking([10]),
    });
    expect(dbMock.dbRead.articleEngagement.findMany).not.toHaveBeenCalled();
    expect(sent[0].ids).toBeUndefined();
  });

  it("hydrates through the feed's views of the viewer's lists", async () => {
    h.follows = [10];
    lists({ engaged: [10], collected: [10] });
    await feedSearch({ followed: true, favorites: true, hidden: true, collectionId: 9 });
    expect(h.fetchArgs[0]).toMatchObject({
      followed: true,
      favorites: true,
      hidden: true,
      collectionId: 9,
    });
    // Bookmarked wins over Hidden, as in getArticles.
    expect(dbMock.dbRead.articleEngagement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 5, type: 'Favorite' } })
    );
  });
});

describe('semantic article search: the query audit and the browsing level', () => {
  const VIEWER = { id: 500, isModerator: false } as SessionUser;
  const run = (
    over: { browsingLevel?: number; user?: SessionUser; correctedQuery?: string } = {}
  ) => {
    const track = { action: vi.fn().mockResolvedValue(undefined) };
    return searchSemanticArticles({
      input: { query: 'guide', browsingLevel: over.browsingLevel ?? 1, limit: 10 },
      user: 'user' in over ? over.user : VIEWER,
      track,
      candidateSource: ranking([10], over.correctedQuery),
    }).then((result) => ({ result, track }));
  };

  it('refuses a minor query for a moderator, before asking the service', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    const { result } = await run({ browsingLevel: 31, user: MOD });
    expect(result).toEqual({ items: [], nextCursor: undefined, correctedQuery: undefined });
    expect(sent).toHaveLength(0);
  });

  it('searches a minor query for a non-moderator instead of refusing it, and records it', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    const { result, track } = await run({ browsingLevel: 31 });
    expect(result.items.map((a) => a.id)).toEqual([10]);
    expect(track.action).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CSAM_Help_Triggered' })
    );
  });

  it('refuses a POI verdict for a moderator at NSFW levels, and records a masked minor match', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    h.includesMinor.mockReturnValue(true);
    const { result, track } = await run({ browsingLevel: 31, user: MOD });
    expect(result.items).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(h.includesInappropriate).toHaveBeenLastCalledWith(expect.anything(), true);
    expect(track.action).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CSAM_Help_Triggered' })
    );
  });

  it("refuses a person-of-interest query when the viewer's add-on disables them", async () => {
    h.addons = [{ type: 'some', nsfwLevels: [1], disablePoi: true }];
    h.includesPoi.mockReturnValue('someone');
    const { result } = await run();
    expect(result.items).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('refuses a person-of-interest query from a non-moderator with no add-on', async () => {
    h.includesPoi.mockReturnValue('someone');
    const { result } = await run();
    expect(result.items).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('counts each flagged query by verdict and stage', async () => {
    const { register } = await import('prom-client');
    const count = async () =>
      (
        (await register.getSingleMetric('semantic_search_query_verdicts_total')?.get())?.values ??
        []
      )
        .filter((v) => v.labels.verdict === 'poi' && v.labels.stage === 'query')
        .reduce((n, v) => n + v.value, 0);
    const before = await count();
    h.includesPoi.mockReturnValue('someone');
    await run();
    expect(await count()).toBe(before + 1);
  });

  it('lets a moderator with no add-on search a person-of-interest query', async () => {
    h.includesPoi.mockReturnValue('someone');
    const { result } = await run({ user: MOD });
    expect(result.items.map((a) => a.id)).toEqual([10]);
  });

  it('refuses when the benign list cannot be read', async () => {
    h.stripBenignPhrases.mockRejectedValue(new Error('redis down'));
    const { result } = await run();
    expect(result.items).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['all levels', 31, [1, 2]],
    ['NSFW levels only', 4 | 8, [1]],
  ])('clamps a non-moderator asking for %s to the safe levels', async (_name, level, expected) => {
    h.evalBoolean.mockReturnValue({ enabled: true });
    await run({ browsingLevel: level });
    expect(sent[0].gate).toMatchObject({ nsfwLevels: expected });
    expect(h.includesInappropriate).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it('clamps a signed-out visitor too', async () => {
    h.evalBoolean.mockReturnValue({ enabled: true });
    await run({ browsingLevel: 31, user: undefined });
    expect(sent[0].gate).toMatchObject({ nsfwLevels: [1, 2] });
  });

  it('lifts the clamp when the key is present and disabled', async () => {
    h.evalBoolean.mockReturnValue({ enabled: false });
    await run({ browsingLevel: 31 });
    expect(sent[0].gate).toMatchObject({ nsfwLevels: [1, 2, 4, 8, 16] });
  });

  it.each([
    ['the client is unavailable', () => (h.fliptClient = null)],
    [
      'the key is missing',
      () =>
        h.evalBoolean.mockImplementation(() => {
          throw new Error('flag not found');
        }),
    ],
    ['the answer is malformed', () => h.evalBoolean.mockReturnValue({ enabled: undefined })],
  ])('holds the clamp when %s', async (_name, arrange) => {
    arrange();
    await run({ browsingLevel: 31 });
    expect(sent[0].gate).toMatchObject({ nsfwLevels: [1, 2] });
  });

  it("applies the level's add-on tag exclusions server-side", async () => {
    h.addons = [{ type: 'some', nsfwLevels: [4], excludedTagIds: [9001] }];
    await run({ browsingLevel: 31 });
    expect(sent[0].excludedTagIds).toContain(9001);
  });

  it('recomputes the add-ons at the narrowed level', async () => {
    h.addons = [{ type: 'none', nsfwLevels: [4, 8, 16], excludedTagIds: [9200] }];
    h.includesInappropriate.mockReturnValue('minor');
    await run({ browsingLevel: 31 });
    expect(sent[0].excludedTagIds).toContain(9200);
  });

  it('narrows a minor query to the safe levels once the clamp is off', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    await run({ browsingLevel: 31 });
    expect(sent[0].gate).toMatchObject({ nsfwLevels: [1, 2] });
  });

  it("refuses when the service's spelling correction fails the audit", async () => {
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'corrected' ? 'minor' : false
    );
    const { register } = await import('prom-client');
    const counted = async () =>
      (
        (await register.getSingleMetric('semantic_search_query_verdicts_total')?.get())?.values ??
        []
      )
        .filter((v) => v.labels.verdict === 'minor' && v.labels.stage === 'correction')
        .reduce((n, v) => n + v.value, 0);
    const before = await counted();
    const { result, track } = await run({ correctedQuery: 'corrected' });
    expect(result).toMatchObject({ items: [], correctedQuery: undefined });
    expect(await counted()).toBe(before + 1);
    expect(h.fetched).toEqual([]);
    expect(track.action).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CSAM_Help_Triggered' })
    );
  });

  it('shows results for a spelling correction that passes the audit', async () => {
    const { result } = await run({ correctedQuery: 'corrected' });
    expect(result.items.map((a) => a.id)).toEqual([10]);
    expect(result.correctedQuery).toBe('corrected');
  });
});

describeSemanticAuditContract({
  index: 'articles',
  run: ({ source, user, cursor }) =>
    searchSemanticArticles({
      input: { query: 'guide', browsingLevel: 1, limit: 10, cursor },
      user,
      candidateSource: source,
    }),
  ids: [10, 20],
  recorded: h.recordAudit,
  narrowToMinor: () => h.includesInappropriate.mockReturnValue('minor'),
  refuse: () => h.includesInappropriate.mockReturnValue('poi'),
});

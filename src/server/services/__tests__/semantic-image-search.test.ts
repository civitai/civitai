import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as MeilisearchClient from '~/server/meilisearch/client';
import type * as PromClient from '~/server/prom/client';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as Audit from '~/utils/metadata/audit';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import type { SessionUser } from '~/types/session';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

// Qdrant's payload lags Postgres: an image blocked, unpublished, made private or re-rated a moment
// ago can still be a candidate. These tests pin that the search only ever returns what the
// image fetch path returns, and that the fetch path keeps every visibility filter for an id list.

const h = vi.hoisted(() => {
  return {
    queryWithTimeout: vi.fn(),
    fakeGetAllImages: undefined as undefined | ((input: { ids: number[] }) => unknown),
    stripBenignPhrases: vi.fn(async (text: string) => text),
    includesInappropriate:
      vi.fn<(input: { prompt?: string }, nsfw?: boolean) => 'minor' | 'poi' | false>(),
    includesPoi: vi.fn<(prompt?: string) => string | false>(),
    includesMinor: vi.fn<(prompt?: string) => boolean>(),
    isFlipt: vi.fn<(flag: string) => Promise<boolean>>(),
  };
});

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  stripBenignPhrases: h.stripBenignPhrases,
}));
vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  includesInappropriate: h.includesInappropriate,
  includesPoi: h.includesPoi,
  includesMinor: h.includesMinor,
}));

vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  registerCounter: () => ({ inc: vi.fn() }),
}));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout: h.queryWithTimeout,
}));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeilisearchClient>()),
  metricsSearchClient: {},
  getMetricsSearchClient: () => ({}),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: h.isFlipt,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageService>();
  return {
    ...actual,
    getAllImages: (input: Parameters<typeof actual.getAllImages>[0]) =>
      h.fakeGetAllImages
        ? h.fakeGetAllImages(input as { ids: number[] })
        : actual.getAllImages(input),
  };
});
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getAllHiddenForUser: vi.fn().mockResolvedValue({
    hiddenUsers: [{ id: 901 }],
    blockedUsers: [{ id: 902 }],
    blockedByUsers: [{ id: 903 }],
    hiddenTags: [
      { id: 801, hidden: true },
      { id: 802, hidden: false },
    ],
    hiddenImages: [{ id: 109 }, { id: 110, tagId: 801 }, { id: 111, tagId: 802 }],
  }),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBlockedBrowsingTags: vi.fn().mockResolvedValue([{ id: 601, name: 'not browsable' }]),
  getBrowsingSettingAddons: vi.fn().mockResolvedValue([
    {
      type: 'some',
      nsfwLevels: [1],
      disablePoi: true,
      disableMinor: true,
      excludedTagIds: [701],
    },
  ]),
}));

import { searchSemanticImages } from '~/server/services/semantic-image-search.service';
import { anchorBrowsingLevel } from '~/server/services/semantic-query-guard';
import type { CandidateSource } from '~/server/services/semantic-search-client';

const VIEWER = { id: 500, isModerator: false } as SessionUser;
const PG = 1;

const ANCHOR = 1;
const input = (over: Partial<SemanticImageSearchInput> = {}) =>
  ({ imageId: ANCHOR, browsingLevel: PG, limit: 50, ...over } as SemanticImageSearchInput);

/** A Qdrant stand-in that serves a fixed ranking and records how often it was asked. */
function rankedSource(ranking: number[]) {
  const calls: Parameters<CandidateSource>[0][] = [];
  const source: CandidateSource = async (args) => {
    const { offset, limit } = args;
    calls.push(args);
    return { ids: ranking.slice(offset, offset + limit) };
  };
  return { source, calls };
}

/** The image fetch path's verdict: rows for visible ids only, in its own (id) order. */
function visibleOnly(visible: Set<number>) {
  return async ({ ids }: { ids: number[] }) => ({
    items: ids
      .filter((id) => id === ANCHOR || visible.has(id))
      .sort((a, b) => b - a)
      .map((id) => ({ id })),
    nextCursor: undefined,
  });
}

beforeEach(() => {
  h.fakeGetAllImages = undefined;
  h.queryWithTimeout.mockReset().mockRejectedValue(new Error('stop here'));
  h.stripBenignPhrases.mockReset().mockImplementation(async (text: string) => text);
  h.includesInappropriate.mockReset().mockReturnValue(false);
  h.includesPoi.mockReset().mockReturnValue(false);
  h.includesMinor.mockReset().mockReturnValue(false);
  h.isFlipt.mockReset().mockResolvedValue(false);
});

describe('a stale index cannot surface a hidden image', () => {
  // The index still holds all of these; Postgres says only the first, third and last are visible.
  const BLOCKED = 102;
  const UNPUBLISHED_POST = 104;
  const PRIVATE_POST = 105;
  const ABOVE_BROWSING_LEVEL = 106;
  const BLOCKED_CREATOR = 107;
  const ranking = [
    101,
    BLOCKED,
    103,
    UNPUBLISHED_POST,
    PRIVATE_POST,
    ABOVE_BROWSING_LEVEL,
    BLOCKED_CREATOR,
    108,
  ];

  it('returns only what hydration returned, in the index order', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([101, 103, 108]));
    const { source } = rankedSource(ranking);

    const { items } = await searchSemanticImages({
      input: input({ imageId: 1 }),
      user: VIEWER,
      candidateSource: source,
    });

    expect(items.map((x) => x.id)).toEqual([101, 103, 108]);
  });

  it('fills a page from further candidates when hydration drops most of them', async () => {
    // Every fourth candidate is visible.
    const long = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const visible = new Set(long.filter((_, i) => i % 4 === 0));
    h.fakeGetAllImages = visibleOnly(visible);
    const { source, calls } = rankedSource(long);

    const first = await searchSemanticImages({
      input: input({ limit: 3 }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(first.items.map((x) => x.id)).toEqual([1000, 1004, 1008]);
    expect(calls.length).toBeLessThanOrEqual(3);

    const second = await searchSemanticImages({
      input: input({ limit: 3, cursor: first.nextCursor }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(second.items.map((x) => x.id)).toEqual([1012, 1016, 1020]);
  });

  it('resumes after the last candidate shown when a page fills mid-batch', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([11, 12, 13, 14, 15]));
    const { source } = rankedSource([11, 12, 13, 14, 15]);

    const first = await searchSemanticImages({
      input: input({ limit: 2 }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(first.items.map((x) => x.id)).toEqual([11, 12]);

    const second = await searchSemanticImages({
      input: input({ limit: 2, cursor: first.nextCursor }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(second.items.map((x) => x.id)).toEqual([13, 14]);
  });

  it('ends paging when the index runs out', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([101, 103]));
    const { source } = rankedSource([101, 102, 103]);
    const page = await searchSemanticImages({
      input: input({ limit: 10 }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(page.items.map((x) => x.id)).toEqual([101, 103]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('never returns the source image of "more like this"', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([5, 6, 7]));
    const { source } = rankedSource([5, 6, 7]);
    const { items } = await searchSemanticImages({
      input: input({ imageId: 6 }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(items.map((x) => x.id)).toEqual([5, 7]);
  });

  // The image query has no per-viewer hidden-image filter, so this one is the search's own job.
  it('drops images the viewer hid, and those hidden through a tag they still hide', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([108, 109, 110, 111]));
    const { source } = rankedSource([108, 109, 110, 111]);
    const { items } = await searchSemanticImages({
      input: input(),
      user: VIEWER,
      candidateSource: source,
    });
    expect(items.map((x) => x.id)).toEqual([108, 111]);
  });

  it('refuses "more like this" from an image the viewer cannot see', async () => {
    h.fakeGetAllImages = async () => ({ items: [], nextCursor: undefined });
    const { source, calls } = rankedSource([5, 7]);
    await expect(
      searchSemanticImages({ input: input({ imageId: 6 }), user: VIEWER, candidateSource: source })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toEqual([]);
  });
});

describe('tags that cannot be browsed', () => {
  it('returns an empty page when every chosen tag is one', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([5]));
    const { source, calls } = rankedSource([5]);
    const page = await searchSemanticImages({
      input: input({ tagIds: [601] }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(page.items).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('drops one from the index filter and from hydration', async () => {
    const hydratedTags: unknown[] = [];
    h.fakeGetAllImages = async (args) => {
      hydratedTags.push((args as { tags?: number[] }).tags);
      return visibleOnly(new Set([5]))(args);
    };
    const { source, calls } = rankedSource([5]);
    await searchSemanticImages({
      input: input({ tagIds: [601, 42] }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(JSON.stringify(calls[0].filter)).not.toContain('601');
    expect(JSON.stringify(calls[0].filter)).toContain('42');
    expect(hydratedTags.at(-1)).toEqual([42]);
  });
});

describe.each([
  ['a text query', { query: 'a red fox', imageId: undefined }],
  ['the "more like this" anchor check', {}],
])('the image query behind %s keeps every visibility filter', (_name, over) => {
  async function firstImageSql() {
    const { source } = rankedSource([101, 102, 103]);
    await searchSemanticImages({
      input: input(over),
      user: VIEWER,
      candidateSource: source,
    }).catch(() => undefined);
    expect(h.queryWithTimeout, 'the search no longer reaches the image query').toHaveBeenCalled();
    const stmt = h.queryWithTimeout.mock.calls[0][2] as { text: string; values: unknown[] };
    return { text: stmt.text.replace(/\s+/g, ' '), values: stmt.values };
  }

  it.each([
    ['the candidate ids', /i\."id" = ANY\(/],
    ['published posts only', /p\."publishedAt" < now\(\)/],
    ['no private posts', /p\."availability" != \$\d+/],
    ['no blocked ingestion', /i\."ingestion" != 'Blocked'/],
    ['no blocked images', /i\."blockedFor" IS NULL/],
    ['no images awaiting review', /i\."needsReview" IS NULL/],
    ["the viewer's browsing level", /i\."nsfwLevel" & \$\d+/],
    ['the person-of-interest add-on', /i\."poi" != TRUE/],
    ['the minor add-on', /i\."minor" != TRUE/],
    ['hidden and blocked creators', /i\."userId" != ALL\(/],
    ['hidden tags', /FROM "TagsOnImageDetails" toi/],
  ])('%s', async (_clause, clause) => {
    const { text } = await firstImageSql();
    expect(text).toMatch(clause);
  });

  it("binds the viewer's hidden users and tags, and the add-on's tags", async () => {
    const { values } = await firstImageSql();
    expect(values).toContainEqual(expect.arrayContaining([901, 902, 903]));
    expect(values).toEqual(expect.arrayContaining([801, 701]));
    expect(values).not.toContain(802);
  });
});

describe('filters', () => {
  const textQuery = (over: Partial<SemanticImageSearchInput> = {}) =>
    input({ imageId: undefined, query: 'a red fox', ...over });

  it('searches for a signed-out visitor', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([101, 103]));
    const { source } = rankedSource([101, 102, 103]);
    const { items } = await searchSemanticImages({ input: textQuery(), candidateSource: source });
    expect(items.map((x) => x.id)).toEqual([101, 103]);
  });

  it("narrows to the chosen users' images", async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 31 }, { id: 32 }]);
    h.fakeGetAllImages = visibleOnly(new Set([101]));
    const { source, calls } = rankedSource([101]);
    await searchSemanticImages({
      input: textQuery({ usernames: ['fox', 'vixen'] }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(calls[0].filter.userIds).toEqual([31, 32]);
  });

  it('returns nothing, without asking the index, when no chosen user exists', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([]);
    const { source, calls } = rankedSource([101]);
    const result = await searchSemanticImages({
      input: textQuery({ usernames: ['nobody'] }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(result.items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('narrows to tags chosen by name', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([{ id: 77 }]);
    const { source, calls } = rankedSource([]);
    await searchSemanticImages({
      input: textQuery({ tagNames: ['Fox'] }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(calls[0].filter.tagIds).toEqual([77]);
  });

  it('returns nothing, without asking the index, for a tag name that does not exist', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([]);
    const { source, calls } = rankedSource([101]);
    const result = await searchSemanticImages({
      input: textQuery({ tagNames: ['no-such-tag'] }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(result.items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("leaves the viewer's hidden tags, users and images out of the Qdrant filter", async () => {
    const { source, calls } = rankedSource([]);
    await searchSemanticImages({ input: textQuery(), user: VIEWER, candidateSource: source });
    expect(calls[0].filter).not.toHaveProperty('excludedTagIds');
    expect(calls[0].filter).not.toHaveProperty('excludedUserIds');
    expect(calls[0].filter).not.toHaveProperty('excludedIds');
  });

  it('bounds the posted date', async () => {
    const { source, calls } = rankedSource([]);
    await searchSemanticImages({
      input: textQuery({ postedAfter: new Date('2026-01-01T00:00:00Z') }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(calls[0].filter.range).toMatchObject({ key: 'sortAt', gte: '2026-01-01T00:00:00.000Z' });
  });

  it('never proposes NSFW images on a base model that forbids NSFW', async () => {
    const { source, calls } = rankedSource([]);
    await searchSemanticImages({ input: textQuery(), candidateSource: source });
    const [restricted] = calls[0].filter.mustNot as {
      must: { key: string; match: { any: unknown[] } }[];
    }[];
    expect(restricted.must.map((c) => c.key)).toEqual(['nsfwLevel', 'baseModels']);
    for (const c of restricted.must) expect(c.match.any.length).toBeGreaterThan(0);
  });

  it("sends the viewer's browsing level, never an empty one", async () => {
    const { source, calls } = rankedSource([]);
    await searchSemanticImages({ input: textQuery({ browsingLevel: 0 }), candidateSource: source });
    expect(calls[0].filter.gate.nsfwLevels.length).toBeGreaterThan(0);
  });
});

describe('"more like this" never rates above its anchor', () => {
  const PG13 = 2;
  const R = 4;
  const X = 8;
  const ALL_LEVELS = 1 | 2 | 4 | 8 | 16;

  it.each([
    ['a PG anchor, for a viewer at every level', ALL_LEVELS, PG, PG],
    ['an R anchor, for a viewer at every level', ALL_LEVELS, R, PG | PG13 | R],
    ['an X anchor, for a viewer at PG and PG13', PG | PG13, X, PG | PG13],
    ['an anchor with no level, for a viewer at every level', ALL_LEVELS, undefined, PG | PG13],
    ['an anchor at level 0, for a viewer at every level', ALL_LEVELS, 0, PG | PG13],
    ['an anchor with no level, for an X-only viewer', X, undefined, PG],
  ])('caps %s', (_name, viewer, anchor, expected) => {
    expect(anchorBrowsingLevel(viewer, anchor)).toBe(expected);
  });

  const run = (anchorLevel: number | undefined, user: SessionUser) => {
    const { source, calls } = rankedSource([101]);
    const seen: unknown[] = [];
    h.fakeGetAllImages = async (args) => {
      seen.push((args as { browsingLevel?: number }).browsingLevel);
      return {
        items: args.ids.map((id) => ({ id, nsfwLevel: id === ANCHOR ? anchorLevel : PG })),
        nextCursor: undefined,
      };
    };
    return searchSemanticImages({
      input: input({ imageId: ANCHOR, browsingLevel: ALL_LEVELS }),
      user,
      candidateSource: source,
    }).then(() => ({ gate: calls[0].filter.gate.nsfwLevels, hydrated: seen.slice(1) }));
  };

  it('narrows a PG13 viewer to PG from a PG anchor, in the index filter and in hydration', async () => {
    const { gate, hydrated } = await run(PG, VIEWER);
    expect(gate).toEqual([PG]);
    expect(hydrated).toEqual([PG]);
  });

  it('leaves a moderator at every level', async () => {
    const { gate } = await run(PG, { id: 501, isModerator: true } as SessionUser);
    expect(gate).toEqual([1, 2, 4, 8, 16]);
  });

  it('lifts the cap when the kill switch is on', async () => {
    h.isFlipt.mockResolvedValue(true);
    const { gate } = await run(PG, VIEWER);
    expect(gate).toEqual([PG, PG13]);
  });
});

describe('the query audit and the browsing level', () => {
  const MOD = { id: 501, isModerator: true } as SessionUser;
  const SAFE = 1 | 2;
  const ALL_LEVELS = 1 | 2 | 4 | 8 | 16;
  const textQuery = (over: Partial<SemanticImageSearchInput> = {}) =>
    input({ imageId: undefined, query: 'q', ...over });
  const run = (over: Partial<SemanticImageSearchInput>, user: SessionUser = VIEWER) => {
    const { source, calls } = rankedSource([101]);
    const track = { action: vi.fn().mockResolvedValue(undefined) };
    h.fakeGetAllImages = visibleOnly(new Set([101]));
    return searchSemanticImages({
      input: textQuery(over),
      user,
      track,
      candidateSource: source,
    }).then((result) => ({ result, calls, track }));
  };

  // The blanket non-moderator clamp already sits at the safe levels; this pins search-not-refuse.
  it('searches a minor query for a non-moderator instead of refusing it, and records it', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    const { result, track } = await run({ browsingLevel: ALL_LEVELS });
    expect(result.items.map((i) => i.id)).toEqual([101]);
    expect(track.action).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CSAM_Help_Triggered' })
    );
  });

  it('audits the query as NSFW when the resolved level includes an NSFW level', async () => {
    await run({ browsingLevel: ALL_LEVELS }, MOD);
    expect(h.includesInappropriate).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it('audits the query as before at the safe levels', async () => {
    await run({ browsingLevel: SAFE }, MOD);
    expect(h.includesInappropriate).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it('audits the text left after the benign phrases are stripped', async () => {
    h.stripBenignPhrases.mockResolvedValue('stripped');
    const { result } = await run({});
    expect(h.includesInappropriate).toHaveBeenLastCalledWith(
      { prompt: 'stripped' },
      expect.any(Boolean)
    );
    expect(result.items.map((x) => x.id)).toEqual([101]);
  });

  it('refuses when the benign list cannot be read', async () => {
    h.stripBenignPhrases.mockRejectedValue(new Error('redis down'));
    const { result, calls, track } = await run({});
    expect(result.items).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(track.action).not.toHaveBeenCalled();
  });

  it('refuses any flagged verdict, for a moderator without the POI add-on too', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    const { result, calls, track } = await run({ browsingLevel: ALL_LEVELS }, MOD);
    expect(result.items).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(track.action).not.toHaveBeenCalled();
  });

  it('refuses a minor query for a moderator, before asking the index', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    const { result, calls } = await run({ browsingLevel: ALL_LEVELS }, MOD);
    expect(result).toEqual({ items: [], nextCursor: undefined, correctedQuery: undefined });
    expect(calls).toHaveLength(0);
  });

  it('refuses, and records, a minor match that a POI verdict came back ahead of', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    h.includesMinor.mockReturnValue(true);
    const { result, calls, track } = await run({ browsingLevel: ALL_LEVELS }, MOD);
    expect(result.items).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(track.action).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CSAM_Help_Triggered' })
    );
  });

  it('refuses a person-of-interest query when the add-on disables them', async () => {
    h.includesPoi.mockReturnValue('someone');
    const { result, calls } = await run({});
    expect(result.items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('clamps a non-moderator to the safe levels, in the index filter and in hydration', async () => {
    const seen: unknown[] = [];
    const { source, calls } = rankedSource([101]);
    h.fakeGetAllImages = async (args) => {
      seen.push((args as { browsingLevel?: number }).browsingLevel);
      return visibleOnly(new Set([101]))(args);
    };
    await searchSemanticImages({
      input: textQuery({ browsingLevel: ALL_LEVELS }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(calls[0].filter.gate.nsfwLevels).toEqual([1, 2]);
    expect(seen).toEqual([SAFE]);
    expect(h.includesInappropriate).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it.each([
    ['R and X', 4 | 8],
    ['XXX alone', 16],
  ])('gives a non-moderator who asks only for %s the public level', async (_name, level) => {
    const seen: unknown[] = [];
    const { source, calls } = rankedSource([101]);
    h.fakeGetAllImages = async (args) => {
      seen.push((args as { browsingLevel?: number }).browsingLevel);
      return visibleOnly(new Set([101]))(args);
    };
    await searchSemanticImages({
      input: textQuery({ browsingLevel: level }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(calls[0].filter.gate.nsfwLevels).toEqual([PG]);
    expect(seen).toEqual([PG]);
  });

  it("refuses when the service's spelling correction fails the audit", async () => {
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'corrected' ? 'minor' : false
    );
    const hydrated: number[][] = [];
    h.fakeGetAllImages = async (args) => {
      hydrated.push(args.ids);
      return visibleOnly(new Set([101]))(args);
    };
    const track = { action: vi.fn().mockResolvedValue(undefined) };
    const source: CandidateSource = async () => ({ ids: [101], correctedQuery: 'corrected' });
    const result = await searchSemanticImages({
      input: textQuery(),
      user: VIEWER,
      track,
      candidateSource: source,
    });
    expect(result).toMatchObject({ items: [], correctedQuery: undefined });
    expect(hydrated).toEqual([]);
    expect(track.action).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CSAM_Help_Triggered' })
    );
  });

  it("keeps a moderator's requested level", async () => {
    const { calls } = await run({ browsingLevel: ALL_LEVELS }, MOD);
    expect(calls[0].filter.gate.nsfwLevels).toEqual([1, 2, 4, 8, 16]);
  });
});

describe('the search service call', () => {
  type SentBody = {
    query: unknown;
    filter: { must: unknown[]; must_not: unknown[] };
  } & Record<string, unknown>;
  type Sent = { url: string; auth: string | null; body: SentBody };
  function stubService(respond: (url: string) => Response) {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)),
      });
      return respond(url);
    });
    return sent;
  }

  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    setEnv({ SEARCH_SERVICE_URL: 'http://search.test/', SEARCH_SERVICE_TOKEN: 'tok' });
    h.fakeGetAllImages = visibleOnly(new Set([101, 102]));
  });

  it('sends text, the token and the Qdrant filter, and returns the spelling correction', async () => {
    const sent = stubService(() =>
      Response.json({
        query: 'batmen',
        corrected: 'batman',
        changes: [{ from: 'batmen', to: 'batman', distance: 1 }],
        hits: [
          { id: 101, score: 0.7 },
          { id: 102, score: 0.6 },
        ],
      })
    );
    const result = await searchSemanticImages({
      input: input({ imageId: undefined, query: 'batmen', tagIds: [42] }),
      user: VIEWER,
    });

    expect(result.items.map((x) => x.id)).toEqual([101, 102]);
    expect(result.correctedQuery).toBe('batman');
    expect(sent[0].url).toBe('http://search.test/v1/search');
    expect(sent[0].auth).toBe('Bearer tok');
    expect(sent[0].body).toMatchObject({ collection: 'images', query: 'batmen', offset: 0 });
    expect(sent[0].body.filter.must).toEqual(
      expect.arrayContaining([
        { key: 'nsfwLevel', match: { any: [PG] } },
        { key: 'tagIds', match: { value: 42 } },
      ])
    );
    // The base-model license rule, as a nested must_not.
    expect(sent[0].body.filter.must_not).toContainEqual(
      expect.objectContaining({ must: expect.any(Array) })
    );
  });

  it('reports no correction when the service changed nothing', async () => {
    stubService(() => Response.json({ query: 'fox', corrected: 'fox', changes: [], hits: [] }));
    const result = await searchSemanticImages({
      input: input({ imageId: undefined, query: 'fox' }),
      user: VIEWER,
    });
    expect(result.correctedQuery).toBeUndefined();
  });

  it('asks "more like this" through the Qdrant pass-through, without the source image', async () => {
    const sent = stubService(() => Response.json({ result: { points: [{ id: 101 }] } }));
    await searchSemanticImages({ input: input({ imageId: ANCHOR }), user: VIEWER });

    expect(sent[0].url).toBe('http://search.test/qdrant/collections/images/points/query');
    expect(sent[0].body.query).toBe(ANCHOR);
    expect(sent[0].body.filter.must_not).toContainEqual({ has_id: [ANCHOR] });
  });

  it('answers NOT_FOUND for an image the index does not hold', async () => {
    stubService(() => new Response('{}', { status: 404 }));
    await expect(
      searchSemanticImages({ input: input({ imageId: ANCHOR }), user: VIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers BAD_GATEWAY when the service fails', async () => {
    stubService(() => new Response('{}', { status: 503 }));
    await expect(
      searchSemanticImages({ input: input({ imageId: undefined, query: 'fox' }), user: VIEWER })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { ModelSort, NsfwLevel } from '~/server/common/enums';
import type { SemanticModelSearchInput } from '~/server/schema/semantic-model-search.schema';
import { semanticModelSearchSchema } from '~/server/schema/semantic-model-search.schema';
import type * as SearchClient from '~/server/services/semantic-search-client';
import type { CandidateFilter, CandidateSource } from '~/server/services/semantic-search-client';
import { MetricTimeframe, ModelType } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';
import { describeSemanticAuditContract } from './semantic-audit.harness';

// The index lags Postgres: a model unpublished, made private or re-rated a moment ago can still be
// a candidate. The search shows only what the models feed's own query returns for the candidates.

type FeedCall = {
  input: Record<string, unknown>;
  onlyModelIds?: number[];
  imagesPerModel?: number;
};

const h = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  // The ids the feed's query returns, as getModelsWithImagesAndModelVersions would.
  visible: new Set<number>(),
  calls: [] as FeedCall[],
  isPrivate: false,
  includesInappropriate:
    vi.fn<(input: { prompt?: string }, nsfw?: boolean) => 'minor' | 'poi' | false>(),
  hidden: {
    hiddenUsers: [{ id: 901 }],
    blockedUsers: [] as { id: number }[],
    blockedByUsers: [] as { id: number }[],
    hiddenTags: [] as { id: number; hidden: boolean }[],
    hiddenModels: [{ id: 7, hidden: true }],
  },
  users: new Map<string, number>([['someone', 42]]),
}));

vi.mock('~/server/services/semantic-search-audit.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordSemanticAudit: h.recordAudit,
  recordRefusedSemanticAudit: h.recordAudit,
}));
vi.mock('~/server/services/model.service', () => ({
  getModelsWithImagesAndModelVersions: async (args: FeedCall) => {
    h.calls.push(args);
    const ids = (args.onlyModelIds ?? []).filter((id) => h.visible.has(id));
    // The feed's order, not the candidates': hydration must not decide the ranking.
    return { items: [...ids].sort((a, b) => b - a).map((id) => ({ id })), isPrivate: h.isPrivate };
  },
}));
vi.mock('~/server/services/semantic-search-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchClient>()),
  resolveUserIds: async (names: string[]) => names.flatMap((n) => h.users.get(n) ?? []),
}));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registerCounter: () => ({ inc: vi.fn() }),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: async () => false,
  ensureFliptInitialized: async () => undefined,
  // The non-moderator clamp off, so the requested levels reach the index.
  getFliptClientSync: () => ({ evaluateBoolean: () => ({ enabled: false }) }),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/services/search-query-rules', () => ({ matchesQueryRule: async () => false }));
vi.mock('~/utils/metadata/audit', () => ({
  includesNsfw: () => false,
  includesInappropriate: h.includesInappropriate,
  includesPoi: () => false,
  includesMinor: () => false,
}));
vi.mock('~/server/services/system-cache', () => ({ getBrowsingSettingAddons: async () => [] }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async () => h.hidden,
}));

const { searchSemanticModels } = await import('~/server/services/semantic-model-search.service');

const { PG, PG13, R } = NsfwLevel;
const VIEWER = { id: 500, isModerator: false } as SessionUser;
const OPTIONS = { imagesPerModel: 4 } as Parameters<typeof searchSemanticModels>[0]['queryOptions'];

const input = (over: Partial<SemanticModelSearchInput> = {}) =>
  semanticModelSearchSchema.parse({ query: 'anime', browsingLevel: PG, ...over });

let sent: CandidateFilter[];
// The index: `ids` in similarity order; `words` the points whose text holds every query word.
const ranking =
  (ids: number[], correctedQuery?: string, words: number[] = []): CandidateSource =>
  async ({ filter, offset, limit }) => {
    sent.push(filter);
    const excluded = new Set(filter.excludedIds ?? []);
    const pool = filter.allWords
      ? ids.filter((id) => words.includes(id))
      : ids.filter((id) => !excluded.has(id));
    return { ids: pool.slice(offset, offset + limit), correctedQuery };
  };

const run = (
  ids: number[],
  over: Partial<SemanticModelSearchInput> = {},
  user: SessionUser | undefined = VIEWER,
  correctedQuery?: string
) =>
  searchSemanticModels({
    input: input(over),
    user,
    queryOptions: OPTIONS,
    candidateSource: ranking(ids, correctedQuery),
  });

beforeEach(() => {
  installFakeCacheRedis();
  h.visible = new Set();
  h.calls = [];
  h.isPrivate = false;
  h.includesInappropriate.mockReset().mockReturnValue(false);
  sent = [];
});

describe('hydration through the models feed', () => {
  it("shows only what the feed's query returns, in the index's order", async () => {
    h.visible = new Set([1, 3, 4]);
    const result = await run([1, 2, 3, 4]);
    expect(result.items.map((m) => m.id)).toEqual([1, 3, 4]);
  });

  it("narrows the feed's query to the candidates, with the feed's options and no text query", async () => {
    h.visible = new Set([1]);
    await run([1, 2], {
      followed: true,
      fileFormats: ['SafeTensor'],
      sort: ModelSort.HighestRated,
    });
    const [call] = h.calls;
    expect(call.onlyModelIds).toEqual([1, 2]);
    expect(call.imagesPerModel).toBe(4);
    expect(call.input).toMatchObject({
      followed: true,
      fileFormats: ['SafeTensor'],
      sort: ModelSort.Newest,
      period: MetricTimeframe.AllTime,
      browsingLevel: PG,
    });
    expect(call.input).not.toHaveProperty('query');
    expect(call.input).not.toHaveProperty('ids');
  });

  it("keeps the viewer's hidden and blocked users out, beside the ones the feed sent", async () => {
    h.visible = new Set([1]);
    await run([1], { excludedUserIds: [77] });
    expect(h.calls[0].input.excludedUserIds).toEqual([77, 901]);
  });

  it('never shows a model the viewer hid, except in the Hidden view', async () => {
    h.visible = new Set([7, 8]);
    expect((await run([7, 8])).items.map((m) => m.id)).toEqual([8]);
    expect((await run([7, 8], { hidden: true })).items.map((m) => m.id)).toEqual([7, 8]);
  });

  it('reports a result that depends on the viewer', async () => {
    h.visible = new Set([1]);
    h.isPrivate = true;
    const onViewerDependent = vi.fn();
    await searchSemanticModels({
      input: input(),
      user: VIEWER,
      queryOptions: OPTIONS,
      candidateSource: ranking([1]),
      onViewerDependent,
    });
    expect(onViewerDependent).toHaveBeenCalled();
  });
});

describe('name and keyword matches', () => {
  it('rank a model whose text holds every query word ahead of closer meanings', async () => {
    h.visible = new Set([1, 2, 3, 9]);
    const result = await searchSemanticModels({
      input: input({ query: 'civetai' }),
      user: VIEWER,
      queryOptions: OPTIONS,
      candidateSource: ranking([1, 2, 3, 9], undefined, [9]),
    });
    expect(result.items.map((m) => m.id)).toEqual([9, 1, 2, 3]);
    expect(sent[0].allWords).toEqual({ key: 'name', text: 'civetai' });
  });
});

describe('the index filter', () => {
  it("carries the viewer's levels and the feed's type, base model and checkpoint filters", async () => {
    await run([], {
      browsingLevel: PG | R,
      types: [ModelType.LORA],
      baseModels: ['SDXL 1.0'],
      checkpointType: 'Merge',
    });
    expect(sent[0]).toMatchObject({
      gate: { kind: 'level', nsfwLevels: [PG, R] },
      anyOf: { type: [ModelType.LORA], baseModels: ['SDXL 1.0'], checkpointType: ['Merge'] },
    });
  });

  it('bounds the published date by whole days', async () => {
    await run([], { publishedFrom: '2026-01-01', publishedTo: '2026-01-31' });
    expect(sent[0].range).toEqual({
      key: 'publishedAt',
      gte: '2026-01-01T00:00:00.000Z',
      lte: '2026-01-31T23:59:59.999Z',
    });
  });

  it("narrows to the feed's user, and finds nothing for a user who doesn't exist", async () => {
    await run([], { username: 'someone' });
    expect(sent[0].userIds).toEqual([42]);
    const asked = sent.length;
    expect((await run([1], { username: 'nobody' })).items).toEqual([]);
    expect(sent).toHaveLength(asked);
  });
});

describe('the query audit', () => {
  it('refuses a flagged query before asking the index', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    const result = await run([1]);
    expect(result.items).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('searched as typed, still refuses a flagged query before asking the index', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    const result = await run([1], { spellcheck: false });
    expect(result.items).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('searched as typed, asks the index for the text with its spelling correction off', async () => {
    const queries: unknown[] = [];
    await searchSemanticModels({
      input: input({ query: 'Shikata nee', spellcheck: false }),
      user: VIEWER,
      queryOptions: OPTIONS,
      candidateSource: async ({ query }) => {
        queries.push(query);
        return { ids: [] };
      },
    });
    expect(queries[0]).toEqual({ text: 'Shikata nee', spellcheck: false });
  });

  it("refuses when the service's spelling correction fails the audit", async () => {
    h.visible = new Set([1]);
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'flagged' ? 'poi' : false
    );
    const result = await run([1], {}, VIEWER, 'flagged');
    expect(result.items).toEqual([]);
  });

  it('searches the safe levels for a minor-meaning query from a non-moderator', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    await run([], { browsingLevel: PG | PG13 | R });
    expect(sent[0].gate.nsfwLevels).toEqual([PG, PG13]);
  });
});

describe('the input', () => {
  it('never accepts ids, which would relax the private-model rule', () => {
    const parsed = semanticModelSearchSchema.parse({ query: 'x', ids: '1,2' } as object);
    expect(parsed).not.toHaveProperty('ids');
  });
});

describeSemanticAuditContract({
  index: 'models',
  run: ({ source, user, cursor }) => {
    h.visible = new Set([1, 2]);
    return searchSemanticModels({
      input: input({ cursor }),
      user,
      queryOptions: OPTIONS,
      candidateSource: source,
    });
  },
  ids: [1, 2],
  recorded: h.recordAudit,
  narrowToMinor: () => h.includesInappropriate.mockReturnValue('minor'),
  refuse: () => h.includesInappropriate.mockReturnValue('poi'),
  ownCache: true,
});

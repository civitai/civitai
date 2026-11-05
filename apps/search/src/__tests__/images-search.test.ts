import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createQueryEmbedder, type VectorCache } from '../lib/server/embedder';
import type { QdrantFilter, VectorIndex } from '../lib/server/qdrant';

const TOKEN = 'test-token';
vi.stubEnv('SEARCH_TOKEN', TOKEN);

const STAMP = { model: 'wemm-2b', modelRevision: 'r1', profile: 'p1' };
const VECTOR = [0.1, 0.2];

function fakeIndex(ranking: number[]) {
  const calls: { query: number[] | number; filter: QdrantFilter; offset: number; limit: number }[] =
    [];
  const index: VectorIndex = {
    stamp: async () => STAMP,
    query: async (args) => {
      calls.push(args);
      return ranking.slice(args.offset, args.offset + args.limit);
    },
  };
  return { index, calls };
}

function memoryCache(): VectorCache & { store: Map<string, number[]> } {
  const store = new Map<string, number[]>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, vector) => void store.set(key, vector),
  };
}

let app: FastifyInstance;
const { index, calls } = fakeIndex([11, 12, 13, 14]);
const embedText = vi.fn(async () => ({ ...STAMP, embedding: VECTOR }));
const cache = memoryCache();

beforeAll(async () => {
  const { buildServer } = await import('../app');
  app = await buildServer({
    deps: {
      images: { index, embed: createQueryEmbedder({ embedText, cache, cachePrefix: 'test' }) },
    },
  });
});

const search = (payload: unknown, token: string | null = TOKEN) =>
  app.inject({
    method: 'POST',
    url: '/images/search',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as object,
  });

describe('POST /images/search', () => {
  it('refuses a caller without the token', async () => {
    const res = await search({ query: { text: 'fox' }, filter: { nsfwLevels: [1] } }, null);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a request with no browsing level rather than searching everything', async () => {
    const res = await search({ query: { text: 'fox' }, filter: {} });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('returns ranked ids for a text query, filtered to the allowed levels', async () => {
    const res = await search({
      query: { text: '  red   fox ' },
      filter: { nsfwLevels: [1, 2] },
      limit: 2,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ids: [11, 12] });
    expect(embedText).toHaveBeenCalledWith('red fox');
    const last = calls.at(-1)!;
    expect(last.query).toEqual(VECTOR);
    expect(last.filter.must).toContainEqual({ key: 'nsfwLevel', match: { any: [1, 2] } });
  });

  it('serves a repeated query from the cache', async () => {
    embedText.mockClear();
    await search({ query: { text: 'red fox' }, filter: { nsfwLevels: [1] } });
    expect(embedText).not.toHaveBeenCalled();
  });

  it('never returns the source image of "more like this", and embeds nothing', async () => {
    embedText.mockClear();
    const res = await search({ query: { similarTo: 12 }, filter: { nsfwLevels: [1] } });
    expect(res.statusCode).toBe(200);
    expect(embedText).not.toHaveBeenCalled();
    const last = calls.at(-1)!;
    expect(last.query).toBe(12);
    expect(last.filter.must_not).toContainEqual({ has_id: [12] });
  });

  it('excludes NSFW images on restricted base models', async () => {
    await search({
      query: { text: 'fox' },
      filter: { nsfwLevels: [1, 4], restrictedBaseModels: { nsfwLevels: [4], baseModels: ['X'] } },
    });
    expect(calls.at(-1)!.filter.must_not).toContainEqual({
      must: [
        { key: 'nsfwLevel', match: { any: [4] } },
        { key: 'baseModels', match: { any: ['X'] } },
      ],
    });
  });
});

describe('query embedder', () => {
  it('refuses, and does not cache, a vector from another model revision', async () => {
    const store = memoryCache();
    const embed = createQueryEmbedder({
      embedText: async () => ({ ...STAMP, modelRevision: 'r2', embedding: VECTOR }),
      cache: store,
      cachePrefix: 'test',
    });
    await expect(embed('fox', STAMP)).rejects.toMatchObject({ status: 412 });
    expect(store.store.size).toBe(0);
  });

  it('refuses before embedding when the index has no vectors yet', async () => {
    const embedFn = vi.fn();
    const embed = createQueryEmbedder({ embedText: embedFn, cachePrefix: 'test' });
    await expect(embed('fox', {})).rejects.toMatchObject({ status: 412 });
    expect(embedFn).not.toHaveBeenCalled();
  });
});

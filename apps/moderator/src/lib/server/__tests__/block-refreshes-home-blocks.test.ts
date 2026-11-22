import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A block in this app writes Postgres directly, so the main app's home blocks hear of it only through
// the callback (src/pages/api/internal/home-block-evict.ts).

vi.mock('$env/dynamic/private', () => ({
  env: { WEBHOOK_TOKEN: 'test-token', CIVITAI_APP_URL: 'https://main.test' },
}));

// Every query builder call chains and finds no rows, so only the steps under test do any work.
vi.mock('../db', () => {
  const chain: unknown = new Proxy(() => chain, {
    get: (_t, key) =>
      key === 'execute'
        ? async () => []
        : key === 'executeQuery'
        ? async () => ({ rows: [] })
        : key === 'then'
        ? undefined
        : chain,
    apply: () => chain,
  });
  return { dbRead: chain, dbWrite: chain };
});
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    insert: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ json: async () => [] })),
  }),
}));
vi.mock('../axiom', () => ({ logAxiomError: vi.fn(), logToAxiom: vi.fn() }));
vi.mock('../notifications', () => ({ getNotifications: vi.fn() }));
vi.mock('../redis', () => ({
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
  getRedis: vi.fn(),
}));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../buzz', () => ({ getBuzz: vi.fn() }));
vi.mock('../cache', () => ({ bustCacheTag: vi.fn(), bustCachedObject: vi.fn() }));

const { applyBlockSideEffects } = await import('../image-moderation-effects');

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'));

const homeBlockCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/internal/home-block-evict'));

const block = () =>
  applyBlockSideEffects(
    { pHash: null, needsReview: null, blockedFor: null, nsfwLevel: 1, postId: null, userId: 42 },
    { imageId: 7, actorUserId: 9, heldImage: true }
  );

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('an image block', () => {
  it('asks the main app to refresh the home blocks showing the image', async () => {
    await block();

    expect(homeBlockCalls()).toHaveLength(1);
    const [url, init] = homeBlockCalls()[0];
    expect(String(url).startsWith('https://main.test/api/internal/home-block-evict')).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ imageIds: [7] });
  });

  it('still completes when the refresh call fails', async () => {
    fetchMock.mockRejectedValue(new Error('main app down'));

    await expect(block()).resolves.toBeUndefined();
    expect(homeBlockCalls()).toHaveLength(1);
  });
});

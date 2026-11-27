import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordLikenessRequest = vi.hoisted(() => vi.fn(async () => undefined));

// A single-image block for a likeness/DMCA request marks the image, as the bulk removal does: the main
// app's appeal-decision-records sweep deletes the image's appeal training copies by that row.

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

vi.mock('../mod-activity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordLikenessRequest,
}));

const { applyBlockSideEffects } = await import('../image-moderation-effects');

const block = (violationType?: string) =>
  applyBlockSideEffects(
    { pHash: null, needsReview: null, blockedFor: null, nsfwLevel: 1, postId: null, userId: 42 },
    { imageId: 7, actorUserId: 9, violationType }
  );

beforeEach(() => {
  recordLikenessRequest.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}'))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('an image block for a likeness request', () => {
  it('marks the image, naming the moderator', async () => {
    await block('likenessRequest');

    expect(recordLikenessRequest).toHaveBeenCalledExactlyOnceWith(9, 7);
  });

  it.each([['realPerson'], ['other'], [undefined]])(
    'marks nothing for %s',
    async (violationType) => {
      await block(violationType);

      expect(recordLikenessRequest).not.toHaveBeenCalled();
    }
  );
});

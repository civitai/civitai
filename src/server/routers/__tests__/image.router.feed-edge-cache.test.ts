import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpers from '~/server/db/db-helpers';
import { buildTrpcCacheHeaders } from '~/server/trpc/edge-cache-headers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * A signed-out answer is stored by the edge under its URL. When the input names something only a
 * signed-in viewer has (their reactions, the people they follow, their drafts...), a signed-in caller
 * can send the same URL, so the signed-out answer must not be stored. Read through the procedure and
 * the same header builder the tRPC route's responseMeta uses.
 */

// The feed's own query is the process boundary: it answers no rows.
const { queryWithTimeoutMock } = vi.hoisted(() => ({ queryWithTimeoutMock: vi.fn() }));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout: queryWithTimeoutMock,
}));

import { imageRouter } from '../image.router';

// createContext's cache for a request without a session.
const signedOutCache = () => ({
  browserTTL: 60,
  edgeTTL: 60,
  staleWhileRevalidate: 30,
  canCache: true,
  skip: false,
});
const signedInCache = () => ({
  ...signedOutCache(),
  browserTTL: 0,
  edgeTTL: 0,
  staleWhileRevalidate: 0,
});

function call(path: 'getInfinite' | 'getImagesAsPostsInfinite', input: object, signedIn = false) {
  const ctx = {
    user: signedIn ? { id: 7, isModerator: false, username: 'viewer' } : undefined,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: { host: 'localhost' } },
    res: { setHeader: () => undefined },
    cache: signedIn ? signedInCache() : signedOutCache(),
    features: { imageIndexFeed: false, canViewNsfw: true, datapacketRead: false },
    track: {},
    ip: '127.0.0.1',
  };
  const caller = imageRouter.createCaller(ctx as never);
  const run = (caller[path] as (i: object) => Promise<unknown>)({
    browsingLevel: 1,
    include: [],
    ...input,
  });
  return run.then(() =>
    buildTrpcCacheHeaders({
      cache: ctx.cache,
      type: 'query',
      errorCount: 0,
      paths: [`image.${path}`],
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockResolvedValue({ rows: [] });
});

describe.each(['getInfinite', 'getImagesAsPostsInfinite'] as const)(
  'image.%s edge cache for viewer-scoped inputs',
  (path) => {
    it.each([
      ['reactions', { reactions: ['Heart'] }],
      ['followed', { followed: true }],
      ['pending', { pending: true }],
      ['notPublished', { notPublished: true }],
      ['scheduled', { scheduled: true }],
    ])('does not store a signed-out answer to %s', async (_name, input) => {
      const { edgeCached, headers } = await call(path, input);
      expect(edgeCached).toBe(false);
      expect(headers['Cache-Control']).toBeUndefined();
    });

    it('still stores a signed-out answer to a plain feed', async () => {
      const { edgeCached, headers } = await call(path, {});
      expect(edgeCached).toBe(true);
      expect(headers['Cache-Control']).toMatch(/^public, /);
    });

    it('never stores a signed-in answer', async () => {
      expect((await call(path, {}, true)).edgeCached).toBe(false);
      expect((await call(path, { reactions: ['Heart'] }, true)).edgeCached).toBe(false);
    });
  }
);

// The Hat Turf inputs are read by image.getInfinite only; the gallery answers them the same for everyone.
describe('Hat Turf inputs', () => {
  it('image.getInfinite does not store a signed-out answer to a hat filter', async () => {
    expect((await call('getInfinite', { hideWornHats: true })).edgeCached).toBe(false);
  });
  it('image.getImagesAsPostsInfinite still stores it', async () => {
    expect((await call('getImagesAsPostsInfinite', { hideWornHats: true })).edgeCached).toBe(true);
  });
});

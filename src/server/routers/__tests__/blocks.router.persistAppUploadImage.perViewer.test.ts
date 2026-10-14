import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlockBridgeAuth from '~/server/services/blocks/block-bridge-auth.service';
import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as SessionClient from '~/server/auth/session-client';
import type * as BlockImageUpload from '~/server/services/blocks/block-image-upload.service';

/**
 * `blocks.persistAppUploadImage` through the REAL limiter: an upload's allowance belongs to one
 * viewer of one app.
 *
 * A page app's install id is `page_<appBlockId>`, one string for every viewer of the app. The
 * sibling suite mocks the limiter, so it can only see which function was called with which
 * arguments. Here `~/server/utils/block-catalog-rate-limit` is not mocked: the procedure runs the
 * real key-building code against a counter per Redis key, which is what lets these cases say
 * what one viewer's uploads do to another's.
 *
 * The 60/hour per-account `rateLimit` middleware is shimmed out, as in the sibling suites, so
 * every refusal below is the upload bucket's.
 */

const {
  mockAuthorizeBlockBridgeToken,
  mockParseSubjectUserId,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksPostCreationEnabled,
  mockGetSessionUser,
  mockPersistUpload,
} = vi.hoisted(() => ({
  mockAuthorizeBlockBridgeToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksPostCreationEnabled: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockPersistUpload: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockBridgeAuth>()),
  authorizeBlockBridgeToken: (...a: unknown[]) => mockAuthorizeBlockBridgeToken(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockScopeMiddleware>()),
  parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a),
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksEnabled: (...a: unknown[]) => mockIsAppBlocksEnabled(...a),
  isAppBlocksPostCreationEnabled: (...a: unknown[]) => mockIsAppBlocksPostCreationEnabled(...a),
}));
vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClient>()),
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/services/blocks/block-image-upload.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockImageUpload>()),
  persistBlockUploadImage: (...a: unknown[]) => mockPersistUpload(...a),
}));
// Same import-chain shim the sibling blocks.router suites use: `rateLimit`
// transitively evaluates a top-level `Prisma.validator(...)`, which cannot run here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// Pairwise distinct, and distinct from the ceiling (60), the window (300) and every other
// constant in the limiter module, so a key built from a constant cannot spell a viewer.
const VIEWER_A = 8123;
const VIEWER_B = 9417;
const APP_ALPHA = 'page_apb_alpha';
const APP_BETA = 'page_apb_beta';
/** The upload allowance, as a literal: 60 per window per viewer of an app. */
const ALLOWANCE = 60;
const KEY = '33333333-3333-4333-8333-333333333333';

const REFUSAL = {
  code: 'TOO_MANY_REQUESTS',
  message: 'Rate limit exceeded, please retry shortly.',
};

/** One integer per Redis key, as Redis keeps them. */
let counters: Map<string, number>;

/** One upload by `viewer` on the page app whose install id is `install`. */
function upload(viewer: number, install: string) {
  const ctx = {
    acceptableOrigin: true,
    user: { id: viewer },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    ip: '203.0.113.9',
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: { post: vi.fn(async () => undefined) },
  };
  return blocksRouter
    .createCaller(ctx as never)
    .persistAppUploadImage({ blockToken: `${viewer}|${install}`, url: KEY, name: 'a.png' });
}

async function uploadTimes(times: number, viewer: number, install: string) {
  const outcomes: string[] = [];
  for (let i = 0; i < times; i++) {
    outcomes.push(
      await upload(viewer, install).then(
        () => 'ok',
        (err: { code?: string }) => err.code ?? 'threw'
      )
    );
  }
  return outcomes;
}

const allOk = (times: number) => Array.from({ length: times }, () => 'ok');

beforeEach(() => {
  vi.clearAllMocks();
  // The token names its viewer and its install; the test token spells both.
  mockAuthorizeBlockBridgeToken.mockImplementation(async (token: string) => {
    const [viewer, install] = token.split('|');
    return {
      sub: `user:${viewer}`,
      scopes: ['posts:write:self'],
      appId: `appblk-${install}`,
      appBlockId: install.slice('page_'.length),
      blockInstanceId: install,
      blockId: 'my-app',
      maxBrowsingLevel: 1,
      ctx: { slotId: 'page', entityType: 'none' },
    };
  });
  mockParseSubjectUserId.mockImplementation((sub: string) => Number(sub.slice('user:'.length)));
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockIsAppBlocksPostCreationEnabled.mockResolvedValue(true);
  mockGetSessionUser.mockImplementation(async (id: number) => ({ id }));
  mockPersistUpload.mockResolvedValue({ imageId: 777 });

  counters = new Map();
  redisMock.redis.incrBy.mockImplementation(async (key: string, by: number) => {
    const next = (counters.get(key) ?? 0) + by;
    counters.set(key, next);
    return next;
  });
  redisMock.redis.expire.mockResolvedValue(true);
  // 177: distinct from the window and every other constant in the module.
  redisMock.redis.ttl.mockResolvedValue(177);
});

describe('blocks.persistAppUploadImage — one allowance per viewer per app', () => {
  it('viewer B is not refused after viewer A used their whole allowance on the same app', async () => {
    expect(await uploadTimes(ALLOWANCE, VIEWER_A, APP_ALPHA)).toEqual(allOk(ALLOWANCE));

    // B has uploaded nothing. Same app, same install id, a different person.
    expect(await uploadTimes(ALLOWANCE, VIEWER_B, APP_ALPHA)).toEqual(allOk(ALLOWANCE));
    expect(mockPersistUpload).toHaveBeenCalledTimes(2 * ALLOWANCE);
  });

  it('viewer A is still refused past their own allowance, with the same refusal, and no Image row', async () => {
    expect(await uploadTimes(ALLOWANCE, VIEWER_A, APP_ALPHA)).toEqual(allOk(ALLOWANCE));
    expect(mockPersistUpload).toHaveBeenCalledTimes(ALLOWANCE);

    await expect(upload(VIEWER_A, APP_ALPHA)).rejects.toMatchObject(REFUSAL);
    // `persistBlockUploadImage` is what creates the row; the refused upload never reached it.
    expect(mockPersistUpload).toHaveBeenCalledTimes(ALLOWANCE);
  });

  it('the same viewer has a separate allowance on a different app', async () => {
    expect(await uploadTimes(ALLOWANCE, VIEWER_A, APP_ALPHA)).toEqual(allOk(ALLOWANCE));
    await expect(upload(VIEWER_A, APP_ALPHA)).rejects.toMatchObject(REFUSAL);

    expect(await uploadTimes(ALLOWANCE, VIEWER_A, APP_BETA)).toEqual(allOk(ALLOWANCE));
  });

  it('counts each (app, viewer) on its own key', async () => {
    await uploadTimes(3, VIEWER_A, APP_ALPHA);
    await uploadTimes(2, VIEWER_B, APP_ALPHA);
    await uploadTimes(1, VIEWER_A, APP_BETA);

    expect([...counters.entries()].sort()).toEqual([
      ['blocks:token-rate-limit:upload:page_apb_alpha:8123', 3],
      ['blocks:token-rate-limit:upload:page_apb_alpha:9417', 2],
      ['blocks:token-rate-limit:upload:page_apb_beta:8123', 1],
    ]);
  });

  it('an upload takes nothing from the app’s shared publish allowance', async () => {
    await uploadTimes(ALLOWANCE, VIEWER_A, APP_ALPHA);
    // The publish bucket is per install: what `publishGenerationOutputs` and a post's images
    // draw on, for every viewer of the app together.
    expect([...counters.keys()].filter((key) => key.includes(':publish:'))).toEqual([]);
    // Positive control for the filter above: the uploads did count somewhere.
    expect(counters.size).toBe(1);
  });
});

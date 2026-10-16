import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlockBridgeAuth from '~/server/services/blocks/block-bridge-auth.service';
import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as SessionClient from '~/server/auth/session-client';
import type * as BlockImageUpload from '~/server/services/blocks/block-image-upload.service';

/**
 * `blocks.persistAppUploadImage` through the REAL limiter: an upload charges ONE bucket, the
 * app-wide upload bucket keyed on `appId`, shared by every viewer and every install of the app,
 * and takes nothing from the per-install publish bucket.
 *
 * A page app's install id is `page_<appBlockId>`, one string for every viewer of the app, so the
 * publish bucket it used to charge is shared by all of them. The sibling suite mocks the limiter,
 * so it can only see which function was called with which arguments. Here
 * `~/server/utils/block-catalog-rate-limit` is not mocked: the procedure runs the real
 * key-building code against a counter per Redis key, which is what lets these cases say what one
 * viewer's uploads do to another's, and to the publish allowance.
 *
 * The 60/hour per-account `rateLimit` middleware is shimmed out, as in the sibling suites, so
 * every refusal below is the app bucket's. In prod that middleware is what bounds one
 * non-moderator viewer; there is no per-viewer upload bucket.
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
import { checkBlockPublishRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// Pairwise distinct, and distinct from the ceilings (60, 600), the window (300) and every other
// constant in the limiter module, so a key built from a constant cannot spell a viewer.
const VIEWER_A = 8123;
const VIEWER_B = 9417;
const APP_ALPHA = 'page_apb_alpha';
const APP_BETA = 'page_apb_beta';
/** A second install of the app whose first install is `APP_ALPHA`. */
const APP_ALPHA_SECOND_INSTALL = 'page_apb_alpha2';
/** The app each install belongs to. Two installs, one app, is what separates the two ids. */
const APP_ID_BY_INSTALL: Record<string, string> = {
  [APP_ALPHA]: 'appblk-alpha',
  [APP_ALPHA_SECOND_INSTALL]: 'appblk-alpha',
  [APP_BETA]: 'appblk-beta',
};
/** The app-wide upload allowance, as a literal: 600 per window per app. */
const APP_ALLOWANCE = 600;
/** The per-install publish allowance, as a literal: 60 images per window. */
const PUBLISH_ALLOWANCE = 60;
/** How far the app-wide cases overshoot. 607 is not a multiple of 600, 60 or the crowd size. */
const OVERSHOOT = 7;
/** Several distinct viewers, taking turns. */
const CROWD = Array.from({ length: 17 }, (_, i) => 20001 + i);
const KEY = '33333333-3333-4333-8333-333333333333';
const APP_KEY = 'blocks:token-rate-limit:upload-app:appblk-alpha';

const APP_REFUSAL_MESSAGE =
  'This app is handling too many uploads right now, please retry shortly.';

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

/** `times` uploads, each by `viewers[i % n]` on `installs[i % m]`. Each outcome is 'ok' or the refusal's message. */
async function uploads(times: number, viewers: number[], installs: string[]) {
  const outcomes: string[] = [];
  for (let i = 0; i < times; i++) {
    outcomes.push(
      await upload(viewers[i % viewers.length], installs[i % installs.length]).then(
        () => 'ok',
        (err: { message?: string }) => err.message ?? 'threw'
      )
    );
  }
  return outcomes;
}

const allOk = (times: number) => Array.from({ length: times }, () => 'ok');
const appRefused = (times: number) => Array.from({ length: times }, () => APP_REFUSAL_MESSAGE);

beforeEach(() => {
  vi.clearAllMocks();
  // The token names its viewer and its install; the test token spells both.
  mockAuthorizeBlockBridgeToken.mockImplementation(async (token: string) => {
    const [viewer, install] = token.split('|');
    return {
      sub: `user:${viewer}`,
      scopes: ['posts:write:self'],
      appId: APP_ID_BY_INSTALL[install],
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

describe('blocks.persistAppUploadImage — the per-install publish bucket is not charged', () => {
  it('an upload takes nothing from the install’s shared publish allowance', async () => {
    expect(await uploads(5, [VIEWER_A], [APP_ALPHA])).toEqual(allOk(5));

    // The publish bucket is per install: what `publishGenerationOutputs` and a post's images
    // draw on, for every viewer of the app together.
    expect([...counters.keys()].filter((key) => key.includes(':publish:'))).toEqual([]);
    // Positive control for the filter above: the uploads did count, on the app's key.
    expect([...counters.entries()]).toEqual([[APP_KEY, 5]]);
  });

  it('after the app’s whole upload allowance, the install can still publish its full allowance', async () => {
    expect(await uploads(APP_ALLOWANCE, CROWD, [APP_ALPHA])).toEqual(allOk(APP_ALLOWANCE));

    await expect(checkBlockPublishRateLimit(APP_ALPHA, PUBLISH_ALLOWANCE)).resolves.toEqual({
      allowed: true,
    });
    expect(counters.get(`blocks:token-rate-limit:publish:${APP_ALPHA}`)).toBe(PUBLISH_ALLOWANCE);
  });
});

describe('blocks.persistAppUploadImage — one allowance per app across its viewers and installs', () => {
  it('refuses the 601st upload on an app in a window, with the app’s refusal, and leaves another app alone', async () => {
    const outcomes = await uploads(APP_ALLOWANCE + OVERSHOOT, CROWD, [APP_ALPHA]);

    expect(outcomes.slice(0, APP_ALLOWANCE)).toEqual(allOk(APP_ALLOWANCE));
    expect(outcomes.slice(APP_ALLOWANCE)).toEqual(appRefused(OVERSHOOT));
    // Only the admitted uploads created an Image row.
    expect(mockPersistUpload).toHaveBeenCalledTimes(APP_ALLOWANCE);

    // A different app, even for the viewer the first app refused first.
    await expect(upload(CROWD[APP_ALLOWANCE % CROWD.length], APP_BETA)).resolves.toEqual({
      imageId: 777,
    });
  });

  it('two different viewers of one install draw on the same allowance', async () => {
    // Half each, so neither alone is near 600.
    expect(await uploads(APP_ALLOWANCE / 2, [VIEWER_A], [APP_ALPHA])).toEqual(
      allOk(APP_ALLOWANCE / 2)
    );
    expect(await uploads(APP_ALLOWANCE / 2, [VIEWER_B], [APP_ALPHA])).toEqual(
      allOk(APP_ALLOWANCE / 2)
    );

    // A, who has made only 300 uploads, is refused because of B's.
    await expect(upload(VIEWER_A, APP_ALPHA)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: APP_REFUSAL_MESSAGE,
    });
    expect([...counters.entries()]).toEqual([[APP_KEY, APP_ALLOWANCE + 1]]);
  });

  it('counts every install of an app against the one app allowance', async () => {
    const outcomes = await uploads(APP_ALLOWANCE + OVERSHOOT, CROWD, [
      APP_ALPHA,
      APP_ALPHA_SECOND_INSTALL,
    ]);

    expect(outcomes.slice(0, APP_ALLOWANCE)).toEqual(allOk(APP_ALLOWANCE));
    expect(outcomes.slice(APP_ALLOWANCE)).toEqual(appRefused(OVERSHOOT));
    expect([...counters.keys()]).toEqual([APP_KEY]);
  });

  it('has no per-viewer upload bucket: one viewer past 60 is still admitted (the per-user middleware bounds them in prod)', async () => {
    // Overshoots the publish (60) ceiling a per-viewer upload bucket would have mirrored.
    const times = PUBLISH_ALLOWANCE + OVERSHOOT;
    expect(await uploads(times, [VIEWER_A], [APP_ALPHA])).toEqual(allOk(times));
    expect([...counters.entries()]).toEqual([[APP_KEY, times]]);
  });
});

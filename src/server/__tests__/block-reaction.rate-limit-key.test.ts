import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App reactions and site reactions draw on ONE per-user quota.
 *
 * Proven in three links, each against the code that decides it:
 *   1. HERE, against the REAL `rateLimit` middleware: `{ sharedKey: SITE_REACTION_RATE_LIMIT_KEY }`
 *      on the app procedure's path addresses the SAME redis hash and field as the site's
 *      `reaction.toggle`, which passes no `sharedKey` and is keyed by its path.
 *   2. `blocks.router.appReactions.test.ts`: `setReactionFromApp` hands the limiter the site's
 *      own `reactionRateLimits` array and that `sharedKey`.
 *   3. `reaction.router.rate-limit.test.ts`: the site's `reaction.toggle` hands the limiter the
 *      same array and NO `sharedKey`, so its key really is the path-derived one used below.
 *
 * Harness shape copied from `middleware.trpc.rate-limit-key.test.ts`: capture the handler the
 * factory registers, then drive it. `~/env/other` is mocked production-like because the
 * middleware short-circuits under `isTest`, which would make every assertion vacuous.
 */

const { mockHSetWithTTL, captured } = vi.hoisted(() => ({
  mockHSetWithTTL: vi.fn(),
  captured: { handler: null as ((arg: unknown) => Promise<unknown>) | null },
}));

vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: mockHSetWithTTL }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/trpc', () => ({
  middleware: (fn: (arg: unknown) => Promise<unknown>) => {
    captured.handler = fn;
    return fn;
  },
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn(async () => ({
    hiddenImages: [],
    hiddenTags: [],
    hiddenModels: [],
    hiddenUsers: [],
  })),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(async () => undefined) }));
vi.mock('~/server/utils/server-domain', () => ({
  getRequestDomainColor: vi.fn(() => 'blue'),
  getRequestBoardDomainColor: vi.fn(() => 'blue'),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
}));

import { rateLimit } from '../middleware.trpc';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { reactionRateLimits } from '~/server/schema/reaction.schema';
import { SITE_REACTION_RATE_LIMIT_KEY } from '~/shared/constants/block-reaction.constants';

const mockHGet = redisMock.redis.packed.hGet;

beforeEach(() => {
  vi.clearAllMocks();
  captured.handler = null;
  mockHGet.mockResolvedValue([]);
  mockHSetWithTTL.mockResolvedValue(undefined);
});

/** Drive the real middleware once; return the (hash, field) it read the quota from. */
async function bucketFor(
  path: string,
  options?: { sharedKey?: string },
  userId = 42
): Promise<[string, string]> {
  rateLimit(reactionRateLimits, undefined, options);
  const handler = captured.handler;
  if (!handler) throw new Error('harness broken: rateLimit() registered no handler');
  const before = mockHGet.mock.calls.length;
  await handler({
    ctx: { user: { id: userId, isModerator: false }, req: { headers: {} } },
    input: undefined,
    path,
    next: vi.fn(async () => ({ ok: true })),
  });
  const calls = mockHGet.mock.calls;
  if (calls.length !== before + 1) {
    throw new Error(`harness broken: expected one hGet, saw ${calls.length - before}`);
  }
  const [hash, field] = calls[calls.length - 1] as [string, string];
  return [hash, field];
}

describe('app reactions share the site reaction quota', () => {
  it("the app procedure's sharedKey addresses the SAME bucket as the site's reaction.toggle", async () => {
    const site = await bucketFor('reaction.toggle');
    const app = await bucketFor('blocks.setReactionFromApp', {
      sharedKey: SITE_REACTION_RATE_LIMIT_KEY,
    });
    expect(app).toEqual(site);
    // Per USER, not per app: the field is the viewer.
    expect(site[1]).toBe('user:42');
  });

  it('POSITIVE CONTROL — without the sharedKey the app procedure gets a bucket of its own', async () => {
    // Proves the harness can observe a key difference, so the equality above means something.
    const site = await bucketFor('reaction.toggle');
    const own = await bucketFor('blocks.setReactionFromApp');
    expect(own[0]).not.toBe(site[0]);
  });

  it('POSITIVE CONTROL — a different viewer is a different bucket', async () => {
    const a = await bucketFor('blocks.setReactionFromApp', {
      sharedKey: SITE_REACTION_RATE_LIMIT_KEY,
    });
    const b = await bucketFor(
      'blocks.setReactionFromApp',
      { sharedKey: SITE_REACTION_RATE_LIMIT_KEY },
      7
    );
    expect(a[1]).not.toBe(b[1]);
  });
});

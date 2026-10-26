import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * `appAccessRequest.submit`'s limits, driven through the REAL `rateLimit()` middleware. The router
 * test pins that `submit` is built with these limits; this pins what they DO. The comparison is
 * `attempts > limit`, so a cap of N admits a caller holding N prior attempts and refuses N + 1.
 * Each case asserts both sides. Same harness as `post-rate-limits.test.ts`.
 */

const { capturedHandler } = vi.hoisted(() => ({
  capturedHandler: { handler: null as ((arg: unknown) => Promise<unknown>) | null },
}));

vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/trpc', () => ({
  middleware: (fn: (arg: unknown) => Promise<unknown>) => {
    capturedHandler.handler = fn;
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
// The middleware returns early under isTest, so without this nothing below runs.
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
}));

const { rateLimit } = await import('~/server/middleware.trpc');
const { redisMock } = await import('~/__tests__/mocks/redis.mock');
const { APP_ACCESS_REQUEST_SUBMIT_RATE_LIMITS: LIMITS } = await import(
  '~/shared/constants/app-access-request.constants'
);

const mockHGet = redisMock.redis.packed.hGet;
const HOUR_MS = 60 * 60 * 1000;
const MESSAGE = 'You have updated your request a lot. Try again later.';

const requester = { id: 5310, isModerator: false } as SessionUser;

/** `count` prior attempts `ageMs` ago; returns what the middleware did with the next one. */
async function attemptWith(user: SessionUser, count: number, ageMs: number) {
  const at = Date.now() - ageMs;
  mockHGet.mockResolvedValue(Array.from({ length: count }, () => at));
  capturedHandler.handler = null;
  rateLimit(LIMITS);
  const handler = capturedHandler.handler;
  if (!handler) throw new Error('harness broken: rateLimit() registered no handler');
  const next = vi.fn(async () => ({ ok: true }));
  await handler({
    ctx: { user, req: { headers: {} } },
    input: {},
    path: 'appAccessRequest.submit',
    next,
  });
  if (mockHGet.mock.calls.length === 0)
    throw new Error(
      'harness broken: the middleware never read attempts (check the ~/env/other mock)'
    );
  return next;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('appAccessRequest.submit rate limits', () => {
  it('admits 10 attempts in the last hour and refuses the 11th', async () => {
    expect(await attemptWith(requester, 10, 5 * 60 * 1000)).toHaveBeenCalledTimes(1);
    await expect(attemptWith(requester, 11, 5 * 60 * 1000)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: MESSAGE,
    });
  });

  it('admits 40 attempts in the last day and refuses the 41st (older than an hour)', async () => {
    expect(await attemptWith(requester, 40, 2 * HOUR_MS)).toHaveBeenCalledTimes(1);
    await expect(attemptWith(requester, 41, 2 * HOUR_MS)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: MESSAGE,
    });
  });

  it('forgets attempts older than a day', async () => {
    expect(await attemptWith(requester, 200, 25 * HOUR_MS)).toHaveBeenCalledTimes(1);
  });
});

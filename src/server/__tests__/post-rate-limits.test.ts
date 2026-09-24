import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * Drives `postRateLimits` through the real `rateLimit()` middleware, because the
 * outcome depends on how the middleware picks among matching rules (highest limit
 * per period), not on the rule list alone.
 *
 * The comparison is `attempts > limit`, so a cap of N admits a caller holding N
 * prior attempts and refuses one holding N + 1. Each case asserts both sides.
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

import { rateLimit } from '~/server/middleware.trpc';
import { postRateLimits } from '~/server/schema/post.schema';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockHGet = redisMock.redis.packed.hGet;

const HOUR = 60 * 60 * 1000;
const DAILY_MESSAGE = /daily limit for new posts/;
const NEW_ACCOUNT_MESSAGE = /New accounts have a lower hourly posting limit/;

const ESTABLISHED_CREATED_AT = new Date('2024-01-01T00:00:00Z');

function user(overrides: Partial<SessionUser> & { score?: number } = {}): SessionUser {
  const { score = 0, ...rest } = overrides;
  return {
    id: 42,
    isModerator: false,
    createdAt: ESTABLISHED_CREATED_AT,
    tier: 'free',
    meta: { scores: { total: score } },
    ...rest,
  } as SessionUser;
}

/** `count` prior attempts `ageMs` ago; returns what the middleware did with the next one. */
async function attemptWith(sessionUser: SessionUser, count: number, ageMs: number) {
  const at = Date.now() - ageMs;
  mockHGet.mockResolvedValue(Array.from({ length: count }, () => at));
  rateLimit(postRateLimits, undefined, { sharedKey: 'post:create' });
  const handler = capturedHandler.handler;
  if (!handler) throw new Error('harness broken: rateLimit() registered no handler');
  const next = vi.fn(async () => ({ ok: true }));
  await handler({
    ctx: { user: sessionUser, req: { headers: {} } },
    input: {},
    path: 'post.create',
    next,
  });
  if (mockHGet.mock.calls.length === 0)
    throw new Error(
      'harness broken: the middleware never read attempts (check the ~/env/other mock)'
    );
  return next;
}

/** Holding `limit` attempts from 2h ago passes; one more is refused with `message`. */
async function expectCap(sessionUser: SessionUser, limit: number, ageMs: number, message: RegExp) {
  const next = await attemptWith(sessionUser, limit, ageMs);
  expect(next, `${limit} prior attempts should still be admitted`).toHaveBeenCalledTimes(1);
  await expect(attemptWith(sessionUser, limit + 1, ageMs)).rejects.toThrow(message);
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandler.handler = null;
});

describe('postRateLimits daily cap', () => {
  const reputationTiers = [
    { label: 'base', score: 0, nonMember: 20, member: 40 },
    { label: 'established (1000+)', score: 1000, nonMember: 60, member: 120 },
    { label: 'high reputation (5000+)', score: 5000, nonMember: 150, member: 300 },
  ];

  describe.each(reputationTiers)('$label tier', ({ score, nonMember, member }) => {
    it(`caps a free account at ${nonMember}`, async () => {
      await expectCap(user({ score, tier: 'free' }), nonMember, 2 * HOUR, DAILY_MESSAGE);
    });

    it(`caps an account with no tier at ${nonMember}`, async () => {
      await expectCap(user({ score, tier: undefined }), nonMember, 2 * HOUR, DAILY_MESSAGE);
    });

    it(`caps a member at ${member}`, async () => {
      await expectCap(user({ score, tier: 'bronze' }), member, 2 * HOUR, DAILY_MESSAGE);
    });
  });

  it.each(['founder', 'bronze', 'silver', 'gold'])(
    'treats a %s account as a member',
    async (tier) => {
      await expectCap(user({ tier }), 40, 2 * HOUR, DAILY_MESSAGE);
    }
  );
});

describe('postRateLimits new-account clamp', () => {
  it.each(['free', 'gold'])('holds a same-day %s account to 2 posts an hour', async (tier) => {
    await expectCap(user({ tier, createdAt: new Date() }), 2, 10 * 60 * 1000, NEW_ACCOUNT_MESSAGE);
  });

  // The last millisecond of yesterday is under 24h old, so a clamp window wider than
  // the signup calendar day (24h, 7 days) still catches this account and fails here.
  it('does not apply once the signup day has passed', async () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const createdAt = new Date(startOfToday.getTime() - 1);
    const next = await attemptWith(user({ tier: 'free', createdAt }), 3, 10 * 60 * 1000);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

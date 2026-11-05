import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * Drives `postRateLimits` through the real `rateLimit()` middleware, because the
 * outcome depends on how the middleware picks among matching rules (highest limit
 * per period), not on the rule list alone.
 *
 * A cap of N admits exactly N: a caller holding N - 1 prior attempts makes the Nth
 * call, one holding N is refused. Each case asserts both sides.
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

import { CacheTTL } from '~/server/common/constants';
import { rateLimit } from '~/server/middleware.trpc';
import {
  getDailyPostLimit,
  isDailyPostLimitMessage,
  postRateLimits,
} from '~/server/schema/post.schema';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { rateLimitMetaOf } from '~/server/utils/rate-limit-error';

const mockHGet = redisMock.redis.packed.hGet;

const HOUR = 60 * 60 * 1000;
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

/** The `limit`th call passes; the next one is refused with `message`. */
async function expectCap(
  sessionUser: SessionUser,
  limit: number,
  ageMs: number,
  message: RegExp | string
) {
  const next = await attemptWith(sessionUser, limit - 1, ageMs);
  expect(next, `call ${limit} should still be admitted`).toHaveBeenCalledTimes(1);
  const refused = expect(attemptWith(sessionUser, limit, ageMs)).rejects;
  if (typeof message === 'string') await refused.toMatchObject({ message });
  else await refused.toThrow(message);
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandler.handler = null;
});

describe('postRateLimits daily cap', () => {
  // Each refusal names the caller's own limit and only the rises still ahead of them. The base
  // non-member line is the approved copy; the rest are its variants.
  const reputationTiers = [
    {
      label: 'base',
      score: 0,
      nonMember: 20,
      member: 40,
      nonMemberMessage:
        "You've reached today's limit of 20 posts. Limits rise at Creator Scores of 1,000 and 5,000, and members get double.",
      memberMessage:
        "You've reached today's limit of 40 posts. Limits rise at Creator Scores of 1,000 and 5,000.",
    },
    {
      label: 'established (1000+)',
      score: 1000,
      nonMember: 60,
      member: 120,
      nonMemberMessage:
        "You've reached today's limit of 60 posts. Limits rise at a Creator Score of 5,000, and members get double.",
      memberMessage:
        "You've reached today's limit of 120 posts. Limits rise at a Creator Score of 5,000.",
    },
    {
      label: 'high reputation (5000+)',
      score: 5000,
      nonMember: 150,
      member: 300,
      nonMemberMessage: "You've reached today's limit of 150 posts. Members get double.",
      memberMessage: "You've reached today's limit of 300 posts.",
    },
  ];

  describe.each(reputationTiers)(
    '$label tier',
    ({ score, nonMember, member, nonMemberMessage, memberMessage }) => {
      it(`caps a free account at ${nonMember}`, async () => {
        await expectCap(user({ score, tier: 'free' }), nonMember, 2 * HOUR, nonMemberMessage);
      });

      it(`caps an account with no tier at ${nonMember}`, async () => {
        await expectCap(user({ score, tier: undefined }), nonMember, 2 * HOUR, nonMemberMessage);
      });

      it(`caps a member at ${member}`, async () => {
        await expectCap(user({ score, tier: 'bronze' }), member, 2 * HOUR, memberMessage);
      });

      it('recognises both of its refusals as the daily post limit', () => {
        expect(isDailyPostLimitMessage(nonMemberMessage)).toBe(true);
        expect(isDailyPostLimitMessage(memberMessage)).toBe(true);
      });
    }
  );

  it.each(['founder', 'bronze', 'silver', 'gold'])(
    'treats a %s account as a member',
    async (tier) => {
      await expectCap(user({ tier }), 40, 2 * HOUR, reputationTiers[0].memberMessage);
    }
  );

  it('does not take the new-account clamp for the daily limit', () => {
    const clamp = postRateLimits.find((rule) => rule.period !== 24 * 60 * 60);
    expect(clamp?.errorMessage).toMatch(NEW_ACCOUNT_MESSAGE);
    expect(isDailyPostLimitMessage(clamp?.errorMessage ?? '')).toBe(false);
  });
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

/**
 * `getDailyPostLimit` is the batch scheduler's copy of the cap. It must say the same number the
 * middleware enforces, so each tier is checked against the middleware itself rather than the tier
 * table — a table edit that misses one side shows up here.
 */
describe('getDailyPostLimit', () => {
  const cases = [
    { score: 0, tier: 'free', limit: 20 },
    { score: 0, tier: 'bronze', limit: 40 },
    { score: 999, tier: 'free', limit: 20 },
    { score: 1000, tier: 'free', limit: 60 },
    { score: 1000, tier: 'gold', limit: 120 },
    { score: 5000, tier: 'free', limit: 150 },
    { score: 5000, tier: 'silver', limit: 300 },
    { score: 50_000, tier: 'founder', limit: 300 },
  ];

  it.each(cases)('score $score, tier $tier → $limit', async ({ score, tier, limit }) => {
    const sessionUser = user({ score, tier });
    expect(getDailyPostLimit(sessionUser)).toBe(limit);
    // The `limit`th call is admitted and the one after it refused.
    const admitted = await attemptWith(sessionUser, limit - 1, 2 * HOUR);
    expect(admitted).toHaveBeenCalledTimes(1);
    await expect(attemptWith(sessionUser, limit, 2 * HOUR)).rejects.toThrow(
      /reached today's limit/
    );
  });

  it('treats a missing score as the base tier', () => {
    expect(getDailyPostLimit(user({ meta: {} as SessionUser['meta'], tier: 'free' }))).toBe(20);
  });
});

describe('postRateLimits refusal meta', () => {
  const DAY = 24 * HOUR;

  async function refusalMeta(sessionUser: SessionUser, count: number, ageMs: number) {
    const error = await attemptWith(sessionUser, count, ageMs).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error, 'expected a refusal').toBeDefined();
    return rateLimitMetaOf(error);
  }

  it('a daily refusal carries posts.daily with its counts and window', async () => {
    const ageMs = 2 * HOUR;
    const meta = await refusalMeta(user({ tier: 'free' }), 20, ageMs);
    expect(meta).toMatchObject({
      id: 'posts.daily',
      kind: 'product',
      limit: 20,
      used: 20,
      remaining: 0,
      windowSeconds: DAY / 1000,
    });
    // Every attempt is ageMs old, so the window frees and clears together. The ±1 s absorbs the
    // clock moving between the harness stamping attempts and the middleware reading it.
    expect(meta?.retryAfterSeconds).toBeGreaterThanOrEqual((DAY - ageMs) / 1000 - 1);
    expect(meta?.retryAfterSeconds).toBeLessThanOrEqual((DAY - ageMs) / 1000);
    expect(meta?.resetAt).toBe(meta?.retryAt);
  });

  it('admits the 20th post of the day and refuses the 21st', async () => {
    const free = user({ tier: 'free' });
    expect(await attemptWith(free, 19, 2 * HOUR)).toHaveBeenCalledTimes(1);
    await expect(attemptWith(free, 20, 2 * HOUR)).rejects.toThrow(/reached today's limit of 20/);
  });

  it('a first-day refusal carries posts.hourly, a distinct id', async () => {
    const meta = await refusalMeta(user({ createdAt: new Date() }), 2, 10 * 60 * 1000);
    expect(meta).toMatchObject({ id: 'posts.hourly', kind: 'product', limit: 2, used: 2 });
    expect(meta?.retryAfterSeconds).toBeGreaterThanOrEqual(50 * 60 - 1);
    expect(meta?.retryAfterSeconds).toBeLessThanOrEqual(50 * 60);
  });
});

describe('rateLimit() with a limit-0 rule', () => {
  it('refuses with the rule message and promises no retry time', async () => {
    mockHGet.mockResolvedValue([]);
    rateLimit([{ limit: 0, period: CacheTTL.hour, errorMessage: 'Members only.' }]);
    const handler = capturedHandler.handler;
    if (!handler) throw new Error('harness broken: rateLimit() registered no handler');
    const error = await handler({
      ctx: { user: user(), req: { headers: {} } },
      input: {},
      path: 'resource.load',
      next: vi.fn(),
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'Members only.' });
    expect(rateLimitMetaOf(error)).toBeUndefined();
  });
});

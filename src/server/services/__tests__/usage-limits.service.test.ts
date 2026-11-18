import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { COMMENT_V3_RATE_LIMIT_KEY } from '~/server/schema/commentv3.schema';
import { POST_CREATE_RATE_LIMIT_KEY } from '~/server/schema/post.schema';
import { isBucketCountable, usageLimitDefs } from '~/shared/constants/usage-limits';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

const { hSetWithTTL } = vi.hoisted(() => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/redis/atomic', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hSetWithTTL,
}));

const { getUsageLimits } = await import('~/server/services/usage-limits.service');

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOUR = 3600_000;
const req = { headers: {}, socket: {} } as unknown as NextApiRequest;
const BUCKET = `${REDIS_KEYS.TRPC.LIMIT.BASE}:${POST_CREATE_RATE_LIMIT_KEY}`;
const COMMENTS_BUCKET = `${REDIS_KEYS.TRPC.LIMIT.BASE}:${COMMENT_V3_RATE_LIMIT_KEY}`;
const postsOnly = <T extends { area: string }>(limits: T[]) =>
  limits.filter((l) => l.area === 'posts');

const veteran = { id: 7, tier: 'free', createdAt: new Date(2020, 0, 1) } as unknown as SessionUser;
const newcomer = { id: 8, tier: 'free', createdAt: new Date(NOW - HOUR) } as unknown as SessionUser;
const member = { ...veteran, id: 9, tier: 'gold' } as unknown as SessionUser;
const moderator = { ...newcomer, id: 10, isModerator: true } as unknown as SessionUser;

const hGet = redisMock.redis.packed.hGet as unknown as ReturnType<typeof vi.fn>;
const attemptsBy: Record<string, number[]> = {};
const commentAttemptsBy: Record<string, number[]> = {};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  hSetWithTTL.mockReset();
  for (const key of Object.keys(attemptsBy)) delete attemptsBy[key];
  for (const key of Object.keys(commentAttemptsBy)) delete commentAttemptsBy[key];
  hGet.mockReset();
  hGet.mockImplementation(async (cacheKey: string, field: string) =>
    cacheKey === BUCKET
      ? attemptsBy[field] ?? null
      : cacheKey === COMMENTS_BUCKET
      ? commentAttemptsBy[field] ?? null
      : null
  );
});

describe('getUsageLimits', () => {
  it("reads the caller's own post bucket and counts it against the daily limit", async () => {
    attemptsBy['user:7'] = [NOW - 5 * HOUR, NOW - 2 * HOUR, NOW - 25 * HOUR];
    attemptsBy['user:999'] = Array.from({ length: 20 }, (_, i) => NOW - i * 1000);

    const { limits } = await getUsageLimits({ tokenScope: TokenScope.Full, user: veteran, req });

    expect(hGet).toHaveBeenCalledWith(BUCKET, 'user:7');
    expect(hGet).not.toHaveBeenCalledWith(BUCKET, 'user:999');
    expect(postsOnly(limits)).toEqual([
      {
        id: 'posts.daily',
        area: 'posts',
        label: 'Posts per day',
        limit: 20,
        used: 2,
        remaining: 18,
        windowSeconds: 86400,
        window: 'rolling',
        nextAt: null,
        resetAt: new Date(NOW - 2 * HOUR + 24 * HOUR).toISOString(),
      },
    ]);
  });

  it('reports the next free slot once the limit is reached', async () => {
    const oldest = NOW - 10 * HOUR;
    attemptsBy['user:7'] = [oldest, ...Array.from({ length: 19 }, (_, i) => NOW - i * 1000)];
    const [daily] = (await getUsageLimits({ tokenScope: TokenScope.Full, user: veteran, req }))
      .limits;
    expect(daily).toMatchObject({ used: 20, remaining: 0 });
    expect(daily.nextAt).toBe(new Date(oldest + 24 * HOUR).toISOString());
  });

  it('lists both post limits on the signup day, and only the daily one after', async () => {
    attemptsBy['user:8'] = [NOW - 1000];
    const day1 = (await getUsageLimits({ tokenScope: TokenScope.Full, user: newcomer, req }))
      .limits;
    expect(postsOnly(day1).map((l) => [l.id, l.limit, l.used])).toEqual([
      ['posts.hourly', 2, 1],
      ['posts.daily', 20, 1],
    ]);
    expect(
      (await getUsageLimits({ tokenScope: TokenScope.Full, user: veteran, req })).limits.map(
        (l) => l.id
      )
    ).toEqual(['posts.daily', 'comments.hourly', 'comments.daily']);
  });

  it('gives a paid member the multiplied daily limit', async () => {
    const [daily] = (await getUsageLimits({ tokenScope: TokenScope.Full, user: member, req }))
      .limits;
    expect(daily.limit).toBe(40);
  });

  it('ids narrow the list and can never add a rule the caller is not under', async () => {
    expect(
      (
        await getUsageLimits({
          tokenScope: TokenScope.Full,
          user: newcomer,
          req,
          ids: ['posts.daily'],
        })
      ).limits.map((l) => l.id)
    ).toEqual(['posts.daily']);
    expect(
      (
        await getUsageLimits({
          tokenScope: TokenScope.Full,
          user: veteran,
          req,
          ids: ['posts.hourly'],
        })
      ).limits
    ).toEqual([]);
    expect(
      (await getUsageLimits({ tokenScope: TokenScope.Full, user: veteran, req, ids: ['user:999'] }))
        .limits
    ).toEqual([]);
  });

  it('reports no limit for a moderator, whom rateLimit() never counts', async () => {
    const { limits } = await getUsageLimits({ tokenScope: TokenScope.Full, user: moderator, req });
    expect(limits.every((l) => l.limit === null && l.window === null)).toBe(true);
    expect(postsOnly(limits)).toEqual([
      expect.objectContaining({ id: 'posts.hourly', limit: null, used: null, remaining: null }),
      expect.objectContaining({
        id: 'posts.daily',
        limit: null,
        windowSeconds: null,
        nextAt: null,
      }),
    ]);
    expect(hGet).not.toHaveBeenCalled();
  });

  it("shows a moderator's exemption only to a session or a UserRead token", async () => {
    const asUserRead = await getUsageLimits({
      tokenScope: TokenScope.UserRead,
      user: moderator,
      req,
    });
    expect(asUserRead.limits.every((l) => l.limit === null)).toBe(true);

    const asMediaWrite = await getUsageLimits({
      tokenScope: TokenScope.MediaWrite,
      user: moderator,
      req,
    });
    expect(asMediaWrite.limits.map((l) => [l.id, l.limit, l.used])).toEqual([
      ['posts.hourly', 2, 0],
      ['posts.daily', 20, 0],
      ['comments.hourly', 10, 0],
      ['comments.daily', 40, 0],
    ]);
  });

  it('has a row for every product limit in the registry, comments read from the v3 bucket', async () => {
    commentAttemptsBy['user:8'] = [NOW - 1000, NOW - 2 * HOUR];
    const { limits } = await getUsageLimits({ tokenScope: TokenScope.Full, user: newcomer, req });
    const productIds = usageLimitDefs
      .filter((d) => d.kind === 'product' && isBucketCountable(d.window))
      .map((d) => d.id);
    expect(limits.map((l) => l.id)).toEqual(productIds);
    expect(limits.find((l) => l.id === 'comments.hourly')).toMatchObject({
      area: 'comments',
      label: 'Comments per hour',
      used: 1,
      window: 'rolling',
    });
    expect(limits.find((l) => l.id === 'comments.daily')).toMatchObject({ used: 2 });
  });

  it('never records an attempt', async () => {
    attemptsBy['user:7'] = [NOW - 1000];
    await getUsageLimits({ tokenScope: TokenScope.Full, user: veteran, req });
    await getUsageLimits({ tokenScope: TokenScope.Full, user: veteran, req });
    expect(hSetWithTTL).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.hSet).not.toHaveBeenCalled();
  });

  it('fails like the limiter does when the store read fails', async () => {
    hGet.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      getUsageLimits({ tokenScope: TokenScope.Full, user: veteran, req })
    ).rejects.toThrow('redis down');
  });
});

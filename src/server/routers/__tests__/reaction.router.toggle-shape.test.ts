import { describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbRead.imageReaction.count.mockImplementation(async () => 1);
// The viewer holds a birthday2026 team hat: only a joiner is handed their team's points.
dbMock.dbRead.$queryRaw.mockImplementation((async () => [{ event: 'birthday2026' }]) as never);

// To whoever is about to fold toggleWithPoints into toggle: `reaction.toggle` is a public API
// procedure whose answer API-key callers, comment reactions and app blocks read as a plain string.
// The event points ride on a second procedure so that answer never changes shape. The two share one
// rate-limit quota, so the second is no way around the first.

const { rateLimitKeys } = vi.hoisted(() => ({ rateLimitKeys: [] as (string | undefined)[] }));
vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const { middleware } = await import('~/server/trpc');
  return {
    ...(await importOriginal<typeof MiddlewareTrpc>()),
    rateLimit: (_limits: unknown, _x?: unknown, options?: { sharedKey?: string }) => {
      rateLimitKeys.push(options?.sharedKey);
      return middleware(async ({ next }) => next());
    },
  };
});
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getImagePostId: vi.fn(async () => ({ postId: 42 })),
  getImageNsfwLevelAndOwner: vi.fn(async () => ({ nsfwLevel: 1, userId: 99 })),
}));
// The service creates, and its award reports a grant for the caller's team.
vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: async (args: { onEventPoints?: (g: Promise<unknown[]>) => void }) => {
    args.onEventPoints?.(Promise.resolve([{ event: 'birthday2026', team: 'Yellow', points: 5 }]));
    return 'created';
  },
}));
vi.mock('~/server/events/load-events', () => ({
  loadEvents: async () => [{ name: 'birthday2026', getUserTeam: async () => 'Yellow' }],
}));
vi.mock('~/server/utils/metric-helpers', () => ({ updateEntityMetric: vi.fn(async () => 0) }));
vi.mock('~/server/services/collection.service', () => ({
  getContestsFromEntity: vi.fn(async () => []),
}));
vi.mock('~/server/services/common.service', () => ({
  hasEntityAccess: vi.fn(async () => [{ hasAccess: true }]),
}));
vi.mock('~/server/rewards', () => ({
  encouragementReward: { apply: vi.fn(async () => undefined) },
  goodContentReward: { apply: vi.fn(async () => undefined) },
}));
vi.mock('~/server/notifications/client', () => ({
  notifications: { notificationExists: vi.fn(async () => true) },
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIds: vi.fn(async () => []),
}));

const { reactionRouter } = await import('../reaction.router');
const { TokenScope } = await import('~/shared/constants/token-scope.constants');
const { SITE_REACTION_RATE_LIMIT_KEY } = await import(
  '~/shared/constants/block-reaction.constants'
);

const caller = reactionRouter.createCaller({
  user: { id: 5, isModerator: false, username: 'u', onboarding: 0xff },
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  apiKeyId: null,
  ip: '127.0.0.1',
  req: { headers: {} },
  res: { setHeader: () => undefined },
  cache: { edgeTTL: 0 },
  features: {},
  track: { reaction: vi.fn(async () => undefined) },
} as never);
const input = { entityType: 'image', entityId: 1, reaction: 'Like' } as const;

describe('reaction.toggle and reaction.toggleWithPoints', () => {
  it('reaction.toggle answers a plain string even when the reaction earned points', async () => {
    await expect(caller.toggle(input)).resolves.toBe('created');
  });

  it('reaction.toggleWithPoints answers the result and the points', async () => {
    await expect(caller.toggleWithPoints(input)).resolves.toEqual({
      result: 'created',
      eventPoints: [{ event: 'birthday2026', team: 'Yellow', points: 5 }],
    });
  });

  it("shares reaction.toggle's rate-limit quota", () => {
    // toggle's limit has no sharedKey: it is stored under its path, which is the shared key.
    expect(rateLimitKeys).toEqual([undefined, SITE_REACTION_RATE_LIMIT_KEY]);
    expect(SITE_REACTION_RATE_LIMIT_KEY).toBe('reaction:toggle');
  });
});

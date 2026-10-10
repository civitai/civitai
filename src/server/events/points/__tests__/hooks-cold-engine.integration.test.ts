import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * Removals on a server whose engine has not loaded its hat map yet: a freshly rolled pod. Awards
 * skip until the first load, but a removal must wait for it, or the add it pairs with keeps counting
 * at the referee. Nothing here touches the engine before the removals run.
 */

const ch = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: async ({ values }: { values: Record<string, unknown>[] }) =>
      void ch.rows.push(...values),
    query: vi.fn(),
  },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  getAccountSummary: vi.fn(),
  getTopContributors: vi.fn(async () => ({})),
  getUserBuzzAccount: vi.fn(async () => [{ balance: 0 }]),
}));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/integrations/discord', () => ({ discord: {} }));

const hooks = await import('~/server/events/points/hooks');
const { encodeHat, eventPointKeys } = await import('~/server/events/points/keys');
const { birthday2026 } = await import('~/server/events/birthday2026.event');

const NOW = new Date('2026-11-05T12:00:00.000Z');
const IMAGE = 100;
const MODEL = 200;
const HAT = { ownerId: 10, cosmeticId: 7, claimKey: 'claimed', team: 'Blue' };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const keys = eventPointKeys(birthday2026.name);
  const hats: Record<string, string> = {
    [`Image:${IMAGE}`]: encodeHat(HAT),
    [`Model:${MODEL}`]: encodeHat(HAT),
  };
  const sys = redisMock.sysRedis;
  sys.isReady = true;
  sys.hGetAll.mockImplementation(async (key: string) => (key === keys.hats ? hats : {}));
  sys.sRem.mockResolvedValue(0);
  sys.xRange.mockResolvedValue([]);
  sys.xRevRange.mockResolvedValue([]);
  // Importing the event registry is slow; preloading it keeps the engine itself cold.
  await (await import('~/server/events/load-events')).loadEvents();
});

afterAll(() => {
  vi.useRealTimers();
});

describe('removals on an engine that has not loaded yet', () => {
  it('waits for the first load and writes the remove rows', async () => {
    dbMock.dbWrite.imageReaction.count.mockResolvedValueOnce(0);
    dbMock.dbWrite.resourceReview.count.mockResolvedValueOnce(0);
    await Promise.all([
      hooks.onReactionRemoved({ entityType: 'image', entityId: IMAGE, userId: 1 }),
      hooks.onModelReviewsChanged([{ modelId: MODEL, userId: 2 }]),
    ]);
    expect(
      ch.rows.map((r) => `${r.op}:${r.type}:${r.entityType}:${r.actorId}:${r.sourceId}`).sort()
    ).toEqual([
      'remove:modelLike:Model:2:ResourceReview:200:2',
      'remove:reaction:Image:1:ImageReaction:100:1',
    ]);
  });
});

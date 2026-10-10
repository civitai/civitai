import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The engine's kill switch, through the real entry points: off, nothing reaches sysRedis or the
 * ledger; on (the control), the same calls do. The referee and ticker gates are pinned beside their
 * callers in event-engine.scored-event.test.ts and event-points-ticker.job.test.ts.
 */

const ENGINE_FLAG = 'event-points-engine';
const flag = vi.hoisted(() => ({ value: false as boolean | null }));
const ensureInit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  // Only the kill switch varies; every other flag (the event's own launch flag) reads on.
  isFlipt: async (key: string) => (key === ENGINE_FLAG ? flag.value === true : true),
  isFliptSync: (key: string) => (key === ENGINE_FLAG ? flag.value : true),
  ensureFliptInitialized: ensureInit,
}));
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

const { isEventPointsEnabled, isEventPointsEnabledSync } = await import(
  '~/server/events/points/enabled'
);
const award = await import('~/server/events/points/award');
const { syncEventHats } = await import('~/server/events/points/sync');
const { hattedImpressionEntities } = await import('~/server/events/points/hooks');
const { encodeHat, eventPointKeys } = await import('~/server/events/points/keys');
const { birthday2026 } = await import('~/server/events/birthday2026.event');

const NOW = new Date('2026-11-05T12:00:00.000Z');
const IMAGE = 100;
const HAT = { ownerId: 10, cosmeticId: 7, claimKey: 'claimed', team: 'Blue' };
const sys = redisMock.sysRedis;
const reaction = {
  type: 'reaction' as const,
  actorId: 1,
  entityType: 'Image' as const,
  entityId: IMAGE,
  sourceId: `ImageReaction:${IMAGE}:1`,
};
// Every sysRedis command, so a new write path on any command is seen.
const redisCalls = () =>
  Object.values(sys).reduce((n, fn) => n + (vi.isMockFunction(fn) ? fn.mock.calls.length : 0), 0);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // Importing the event registry is slow; preloading it keeps the engine itself untouched.
  await (await import('~/server/events/load-events')).loadEvents();
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  ch.rows = [];
  const hats = eventPointKeys(birthday2026.name).hats;
  sys.isReady = true;
  sys.hGetAll.mockImplementation(async (key: string) =>
    key === hats ? { [`Image:${IMAGE}`]: encodeHat(HAT) } : {}
  );
  sys.xRange.mockResolvedValue([]);
  sys.xRevRange.mockResolvedValue([]);
  sys.sAdd.mockResolvedValue(1);
  sys.sRem.mockResolvedValue(0);
  sys.hIncrBy.mockResolvedValue(5);
  sys.hSetNX.mockResolvedValue(true);
  sys.expire.mockResolvedValue(true);
  sys.expireAt.mockResolvedValue(true);
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
});

describe('the kill switch reading', () => {
  it('is on only when the flag reads true', async () => {
    flag.value = true;
    expect([await isEventPointsEnabled(), isEventPointsEnabledSync()]).toEqual([true, true]);
    flag.value = false;
    expect([await isEventPointsEnabled(), isEventPointsEnabledSync()]).toEqual([false, false]);
  });

  it('reads off before Flipt has initialised, and starts it initialising', () => {
    flag.value = null;
    expect(isEventPointsEnabledSync()).toBe(false);
    expect(ensureInit).toHaveBeenCalled();
  });
});

// Off runs first: the engine is created lazily, so nothing has loaded it before the off case.
describe('the engine entry points', () => {
  it('off: award, removal and both hat checks touch neither sysRedis nor the ledger', async () => {
    flag.value = false;
    await award.awardEventPoints([reaction]);
    await award.removeEventPoints([reaction]);
    expect(award.isHattedEntity('Image', IMAGE)).toBe(false);
    expect(await award.isHattedEntityOnceLoaded('Image', IMAGE)).toBe(false);
    expect(redisCalls()).toBe(0);
    expect(ch.rows).toEqual([]);
  });

  it('on: the same calls load the hats and write the ledger', async () => {
    flag.value = true;
    await award.awardEventPoints([reaction]);
    await award.removeEventPoints([reaction]);
    expect(await award.isHattedEntityOnceLoaded('Image', IMAGE)).toBe(true);
    expect(award.isHattedEntity('Image', IMAGE)).toBe(true);
    expect(ch.rows.map((r) => r.op)).toEqual(['add', 'remove']);
  });

  // With the hats loaded, only the switch can make these answer false.
  it('off again: a loaded engine still answers un-hatted and writes nothing', async () => {
    flag.value = false;
    expect(award.isHattedEntity('Image', IMAGE)).toBe(false);
    expect(await award.isHattedEntityOnceLoaded('Image', IMAGE)).toBe(false);
    await award.awardEventPoints([
      { ...reaction, actorId: 2, sourceId: `ImageReaction:${IMAGE}:2` },
    ]);
    expect(redisCalls()).toBe(0);
    expect(ch.rows).toEqual([]);
  });
});

describe('the impression filter', () => {
  const batch = [
    {
      kind: 'impression',
      data: {
        sessionKey: 'k',
        surface: 'images',
        entities: [{ entityType: 'Image', entityId: IMAGE }],
      },
    },
  ] as unknown as Parameters<typeof hattedImpressionEntities>[0];

  it('keeps nothing while off, and the hatted entity when on', () => {
    flag.value = false;
    expect(hattedImpressionEntities(batch)).toEqual([]);
    flag.value = true;
    expect(hattedImpressionEntities(batch)).toEqual([{ entityType: 'Image', entityId: IMAGE }]);
  });
});

describe('the hat sync', () => {
  it('does nothing while off, and syncs when on', async () => {
    flag.value = false;
    expect(await syncEventHats(NOW)).toEqual([]);
    expect(redisCalls()).toBe(0);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();

    flag.value = true;
    await syncEventHats(NOW);
    expect(sys.hSetNX).toHaveBeenCalled();
  });
});

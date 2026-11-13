import { prefixCacheKey } from '@civitai/redis';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as ExcludedUsers from '~/server/services/metric-excluded-users.service';

const excluded = vi.hoisted(() => ({ ids: [] as number[] }));

// `updateEntityMetric` reads the `disable-app-entity-metrics` kill switch.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async () => false),
}));
vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ExcludedUsers>()),
  getMetricExcludedUserIds: vi.fn(async () => excluded.ids),
}));
// The Redis and db clients come from the canonical shared mocks.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { trackRouter } from '~/server/routers/track.router';
import { imageVisibilityConditions } from '~/server/services/image-visibility.service';
import { countSongPlay, recordSongPlayStart } from '~/server/services/song-play.service';
import { SONG_PLAY_RATE_LIMIT_MAX } from '~/server/utils/song-play-rate-limit';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const SONG_ID = 501;
const OWNER_ID = 77;
const LISTENER_ID = 12;
const T0 = new Date('2026-11-13T12:00:00Z').getTime();

// The hybrid mock's nodes are vivified spies at any depth; typing each one buys nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const r = redisMock.redis as unknown as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryRaw = dbMock.dbRead.$queryRaw as unknown as any;

const track = { entityMetric: vi.fn(async () => true), view: vi.fn(async () => true) };

type Listener = { userId?: number; ip?: string; music?: boolean; edgeAttested?: boolean };
function ctxFor({
  userId = LISTENER_ID,
  ip = '203.0.113.7',
  music = true,
  edgeAttested = true,
}: Listener = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': ip };
  if (edgeAttested) headers['cf-ray'] = 'ray-1';
  return {
    user: userId ? ({ id: userId } as never) : undefined,
    features: { music, canViewNsfw: false } as never,
    req: { headers } as never,
    track: track as never,
  };
}

function songRow(overrides: Partial<{ type: string; userId: number; duration: unknown }> = {}) {
  return [{ id: SONG_ID, userId: OWNER_ID, type: 'audio', duration: 200, ...overrides }];
}

const at = (seconds: number) => vi.setSystemTime(T0 + seconds * 1000);

async function startAt(seconds: number, listener?: Listener) {
  at(seconds);
  return recordSongPlayStart({ ctx: ctxFor(listener), imageId: SONG_ID });
}
async function completeAt(seconds: number, listener?: Listener) {
  at(seconds);
  return countSongPlay({ ctx: ctxFor(listener), imageId: SONG_ID });
}

const notCounted = { counted: false };

let windows: Map<string, number>;
let store: ReturnType<typeof installFakeCacheRedis>;
const startKeys = () => [...store.keys()].filter((key) => key.includes('song-play:start:'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  track.entityMetric.mockClear();
  track.view.mockClear();
  excluded.ids = [];
  store = installFakeCacheRedis();
  // GETDEL is one command in Redis, so the fake reads and deletes without yielding.
  r.getDel.mockImplementation(async (key: string) => {
    const value = store.peek(key);
    const hit = store.get(key);
    store.delete(key);
    return hit && (hit.expiresAt === null || hit.expiresAt > Date.now()) ? value : null;
  });
  windows = new Map();
  r.incrBy.mockImplementation(async (key: string, by: number) => {
    const next = (windows.get(key) ?? 0) + by;
    windows.set(key, next);
    return next;
  });
  r.ttl.mockImplementation(async () => 60);
  queryRaw.mockResolvedValue(songRow());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('song play counting', () => {
  it('counts the song’s owner like any listener', async () => {
    await startAt(0, { userId: OWNER_ID });
    expect(await completeAt(30, { userId: OWNER_ID })).toEqual({ counted: true });
    expect(track.entityMetric).toHaveBeenCalledTimes(1);
  });

  it('counts a non-owner after 30 s and emits one Play metric for the song', async () => {
    expect(await startAt(0)).toEqual({ started: true });
    expect(await completeAt(30)).toEqual({ counted: true });

    expect(track.entityMetric).toHaveBeenCalledTimes(1);
    expect(track.entityMetric).toHaveBeenCalledWith(
      { entityType: 'Image', entityId: SONG_ID, metricType: 'Play', metricValue: 1 },
      { awaitDelivery: false }
    );
  });

  it('counts an anonymous listener by IP, and one actor cannot complete another actor’s start', async () => {
    const anon = { userId: 0, ip: '198.51.100.4' };
    await startAt(0, anon);
    expect(await completeAt(30, { userId: 0, ip: '198.51.100.5' })).toEqual(notCounted);
    expect(await completeAt(31, anon)).toEqual({ counted: true });
    expect(track.entityMetric).toHaveBeenCalledTimes(1);
  });

  it('counts one anonymous listener across the addresses of its IPv6 /64, and not another /64', async () => {
    await startAt(0, { userId: 0, ip: '2001:db8:1:2::a' });
    expect(await completeAt(30, { userId: 0, ip: '2001:db8:1:3::a' })).toEqual(notCounted);
    expect(await completeAt(31, { userId: 0, ip: '2001:db8:1:2:ffff:0:0:1' })).toEqual({
      counted: true,
    });
    expect(track.entityMetric).toHaveBeenCalledTimes(1);
  });

  it('falls back to 30 s when the stored duration is missing or invalid', async () => {
    for (const [i, duration] of [null, 'abc', 0, -4].entries()) {
      queryRaw.mockResolvedValue(songRow({ duration }));
      const t = i * 1000;
      await startAt(t);
      expect(await completeAt(t + 29)).toEqual(notCounted);
      await startAt(t + 100);
      expect(await completeAt(t + 130)).toEqual({ counted: true });
    }
    expect(track.entityMetric).toHaveBeenCalledTimes(4);
  });

  it('counts a second play after the repeat window, from a new start', async () => {
    await startAt(0);
    expect(await completeAt(30)).toEqual({ counted: true });
    await startAt(201);
    expect(await completeAt(231)).toEqual({ counted: true });
    expect(track.entityMetric).toHaveBeenCalledTimes(2);
  });

  it('answers counted: false when the event is not emitted, and the start stays spent', async () => {
    track.entityMetric.mockResolvedValueOnce(false);
    await startAt(0);
    expect(await completeAt(30)).toEqual(notCounted);
    expect(track.entityMetric).toHaveBeenCalledTimes(1);
    expect(await completeAt(31)).toEqual(notCounted);
    expect(track.entityMetric).toHaveBeenCalledTimes(1);
  });

  it('counts a 12 s song after 12 s and not after 11 s', async () => {
    queryRaw.mockResolvedValue(songRow({ duration: 12 }));
    await startAt(0);
    expect(await completeAt(11)).toEqual(notCounted);
    expect(track.entityMetric).not.toHaveBeenCalled();

    await startAt(100);
    expect(await completeAt(112)).toEqual({ counted: true });
  });

  it('reads the song through the public image visibility rule', async () => {
    await startAt(0);
    await completeAt(30);
    const [query] = queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(query.sql).toContain(Prisma.join(imageVisibilityConditions({}), ' AND ').sql);
    expect(query.values).toContain(SONG_ID);
  });

  describe('does not count, and writes nothing', () => {
    afterEach(() => {
      expect(track.entityMetric).not.toHaveBeenCalled();
    });

    it('for a metric-excluded user', async () => {
      excluded.ids = [LISTENER_ID];
      await startAt(0);
      expect(await completeAt(30)).toEqual(notCounted);
    });

    it('for an image that is not audio', async () => {
      queryRaw.mockResolvedValue(songRow({ type: 'image' }));
      await startAt(0);
      expect(await completeAt(30)).toEqual(notCounted);
    });

    it('for a song the public cannot see (hidden, unpublished or missing)', async () => {
      queryRaw.mockResolvedValue([]);
      await startAt(0);
      expect(await completeAt(30)).toEqual(notCounted);
    });

    it('without a start', async () => {
      expect(await completeAt(30)).toEqual(notCounted);
    });

    it('for anonymous callers whose address is not established, and records no start', async () => {
      const unattested = { userId: 0, edgeAttested: false };
      expect(await startAt(0, unattested)).toEqual({ started: false });
      expect(await completeAt(30, unattested)).toEqual(notCounted);
      expect(store.size).toBe(0);
      expect(windows.size).toBe(0);
    });

    it('when the start is less than 30 s old, and that early complete spends the start', async () => {
      await startAt(0);
      expect(await completeAt(29)).toEqual(notCounted);
      expect(await completeAt(31)).toEqual(notCounted);
    });

    it('for a second complete on the same start', async () => {
      await startAt(0);
      expect(await completeAt(30)).toEqual({ counted: true });
      track.entityMetric.mockClear();
      // Past the repeat window, so only the spent start refuses it.
      expect(await completeAt(500)).toEqual(notCounted);
    });

    it('for a repeat inside the song’s length', async () => {
      await startAt(0);
      expect(await completeAt(30)).toEqual({ counted: true });
      track.entityMetric.mockClear();
      await startAt(31);
      expect(await completeAt(61)).toEqual(notCounted);
    });

    it('for the loser of two concurrent completes on one start', async () => {
      const anon = { userId: 0 };
      await startAt(0, anon);
      // The repeat window always admits here, so only the start's consumption can refuse one.
      const set = r.set.getMockImplementation();
      r.set.mockImplementation(async (key: string, value: unknown, options?: { NX?: boolean }) =>
        options?.NX ? 'OK' : set(key, value, options)
      );
      // Both are held at the song read, the last await before an anonymous complete consumes the
      // start, so they reach the consumption together.
      let arrived = 0;
      let release = () => undefined as void;
      const bothArrived = new Promise<void>((resolve) => (release = resolve));
      const holdUntilBoth = async () => {
        if (++arrived === 2) release();
        await bothArrived;
        return songRow();
      };
      queryRaw.mockImplementationOnce(holdUntilBoth).mockImplementationOnce(holdUntilBoth);
      at(30);
      const results = await Promise.all([
        countSongPlay({ ctx: ctxFor(anon), imageId: SONG_ID }),
        countSongPlay({ ctx: ctxFor(anon), imageId: SONG_ID }),
      ]);
      expect(results).toContainEqual({ counted: true });
      expect(results).toContainEqual(notCounted);
      expect(track.entityMetric).toHaveBeenCalledTimes(1);
      track.entityMetric.mockClear();
    });

    it('over the per-actor cap', async () => {
      await startAt(0);
      // This actor has already used its whole window on completes.
      for (const key of [...windows.keys()])
        windows.set(key.replace(':start:', ':play:'), SONG_PLAY_RATE_LIMIT_MAX);
      expect(await completeAt(30)).toEqual(notCounted);
    });

    it('when Redis is unavailable (fail closed)', async () => {
      await startAt(0);
      const down = new Error('redis down');
      for (const command of ['get', 'getDel', 'set', 'del', 'incrBy', 'ttl', 'expire'])
        r[command].mockRejectedValue(down);
      expect(await completeAt(30)).toEqual(notCounted);
      expect(await startAt(40)).toEqual({ started: false });
    });

    it('when the music flag is off', async () => {
      await startAt(0);
      expect(await completeAt(30, { music: false })).toEqual(notCounted);
    });

    it('when the music flag is off for the start, which then records nothing', async () => {
      expect(await startAt(0, { music: false })).toEqual({ started: false });
      expect(await completeAt(30)).toEqual(notCounted);
    });

    it('when the start is over its own per-actor cap, which then records nothing', async () => {
      windows.set(
        prefixCacheKey(`song-play:rate-limit:start:user:${LISTENER_ID}`),
        SONG_PLAY_RATE_LIMIT_MAX
      );
      expect(await startAt(0)).toEqual({ started: false });
      expect(startKeys()).toEqual([]);
      expect(await completeAt(30)).toEqual(notCounted);
    });

    it.each([
      ['a song the public cannot see', () => queryRaw.mockResolvedValue([])],
      ['an image that is not audio', () => queryRaw.mockResolvedValue(songRow({ type: 'image' }))],
      ['a metric-excluded user', () => (excluded.ids = [LISTENER_ID])],
    ])('when the start is for %s, which then records nothing', async (_, refuse) => {
      refuse();
      expect(await startAt(0)).toEqual({ started: false });
      expect(startKeys()).toEqual([]);
      queryRaw.mockResolvedValue(songRow());
      excluded.ids = [];
      expect(await completeAt(30)).toEqual(notCounted);
    });
  });
});

describe('track router', () => {
  const caller = (music = true) =>
    trackRouter.createCaller({
      acceptableOrigin: true,
      user: { id: LISTENER_ID },
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      req: { headers: {} } as never,
      res: { setHeader: () => undefined } as never,
      cache: { edgeTTL: 0 },
      features: { canViewNsfw: false, music } as never,
      track: track as never,
    } as never);

  it('songPlayStart then songPlay count a play', async () => {
    await caller().songPlayStart({ imageId: SONG_ID });
    at(30);
    expect(await caller().songPlay({ imageId: SONG_ID })).toEqual({ counted: true });
    expect(track.entityMetric).toHaveBeenCalledTimes(1);
  });

  it('addView still dispatches to the view tracker', async () => {
    await caller().addView({ type: 'ImageView', entityType: 'Image', entityId: SONG_ID });
    expect(track.view).toHaveBeenCalledTimes(1);
    expect(track.entityMetric).not.toHaveBeenCalled();
  });
});

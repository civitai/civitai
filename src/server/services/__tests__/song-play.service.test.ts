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

type Listener = { userId?: number; ip?: string; music?: boolean };
function ctxFor({ userId = LISTENER_ID, ip = '203.0.113.7', music = true }: Listener = {}) {
  return {
    user: userId ? ({ id: userId } as never) : undefined,
    features: { music, canViewNsfw: false } as never,
    req: { headers: { 'cf-connecting-ip': ip } } as never,
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  track.entityMetric.mockClear();
  track.view.mockClear();
  excluded.ids = [];
  installFakeCacheRedis();
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

    it('for the song’s owner', async () => {
      await startAt(0, { userId: OWNER_ID });
      expect(await completeAt(30, { userId: OWNER_ID })).toEqual(notCounted);
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

    it('when a start lands between the complete reading the key and deleting it', async () => {
      await startAt(0);
      r.get.mockResolvedValueOnce(null);
      expect(await completeAt(30)).toEqual(notCounted);
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

    it('for a repeat inside the song’s length, and counts again after it', async () => {
      await startAt(0);
      expect(await completeAt(30)).toEqual({ counted: true });
      await startAt(31);
      expect(await completeAt(61)).toEqual(notCounted);
      expect(track.entityMetric).toHaveBeenCalledTimes(1);

      await startAt(201);
      expect(await completeAt(231)).toEqual({ counted: true });
      expect(track.entityMetric).toHaveBeenCalledTimes(2);
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
      for (const command of ['get', 'set', 'del', 'incrBy', 'ttl', 'expire'])
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

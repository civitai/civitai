import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { EventScoring } from '~/server/events/base.event';
import type { EventPointsRedis } from '~/server/events/points/award';
import type { SelfHealDeps } from '~/server/events/points/self-heal';
import type { JobLockRedis } from '~/server/jobs/job-lock';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { createEventPointsEngine } = await import('~/server/events/points/award');
const {
  createEventPointsSelfHeal,
  SELF_HEAL_COOLDOWN_S,
  selfHealCooldownKey,
  SETTLE_JOB,
  SETTLE_LOCK_S,
} = await import('~/server/events/points/self-heal');
const { acquireJobLock, jobLockKey } = await import('~/server/jobs/job-lock');
const { COUNT_BASE_MARK, encodeHat, eventPointKeys, eventSeasonKeys } = await import(
  '~/server/events/points/keys'
);

/**
 * The engine's self-heal: on switch-on, an empty hat map, or no count base, it runs the hourly job's
 * reconcile and settle itself, once across the cluster. The lock is the real job lock over a Redis
 * fake with real SET NX / EX and the lock's compare scripts, so "one pod runs it" is the lock's
 * doing, not a fake's.
 */

// Strings with SET NX / EX, the job lock's two scripts, and hashes and streams for the engine.
function fakeRedis() {
  const strings = new Map<string, string>();
  const ttls = new Map<string, number>();
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const redis = {
    async set(key: string, value: string, opts?: { NX?: boolean; EX?: number }) {
      if (opts?.NX && strings.has(key)) return null;
      strings.set(key, value);
      if (opts?.EX) ttls.set(key, opts.EX);
      return 'OK';
    },
    async eval(script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) {
      if (strings.get(keys[0]) !== args[0]) return 0;
      if (script.includes('"del"')) return Number(strings.delete(keys[0]));
      ttls.set(keys[0], Number(args[1]));
      return 'OK';
    },
    async hGet(key: string, field: string) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hGetAll(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hmGet(key: string, fields: string[]) {
      return fields.map((f) => hashes.get(key)?.get(f) ?? null);
    },
    async hIncrBy(key: string, field: string, by: number) {
      const hash = hashes.get(key) ?? new Map<string, string>();
      hashes.set(key, hash);
      const next = Number(hash.get(field) ?? 0) + by;
      hash.set(field, String(next));
      return next;
    },
    async sAdd(key: string, member: string) {
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      if (set.has(member)) return 0;
      set.add(member);
      return 1;
    },
    async sRem(key: string, member: string) {
      return Number(!!sets.get(key)?.delete(member));
    },
    async expire() {
      return true;
    },
    async expireAt() {
      return true;
    },
    // Only what the engine asks of the hat log: everything after a cursor, and the last entry.
    async xRange(key: string, start: string) {
      const all = streams.get(key) ?? [];
      const after = start.startsWith('(') ? Number(start.slice(1).split('-')[0]) : -1;
      return all.filter((e) => Number(e.id.split('-')[0]) > after);
    },
    async xRevRange(key: string) {
      return [...(streams.get(key) ?? [])].reverse().slice(0, 1);
    },
  };
  const streams = new Map<string, { id: string; message: Record<string, string> }[]>();
  const setHash = (key: string, field: string, value: string) => {
    const hash = hashes.get(key) ?? new Map<string, string>();
    hashes.set(key, hash);
    hash.set(field, value);
  };
  // A hat placed as the reconcile and the equip path place one: the hash, then the log.
  const placeHat = (event: string, entity: string, value: string) => {
    const keys = eventPointKeys(event);
    setHash(keys.hats, entity, value);
    const log = streams.get(keys.hatsLog) ?? [];
    streams.set(keys.hatsLog, log);
    log.push({ id: `${1000 + log.length}-0`, message: { k: entity, v: value } });
  };
  return { redis, strings, ttls, hashes, setHash, placeHat };
}

const START = new Date('2026-11-01T00:00:00.000Z');
const NOW = new Date('2026-11-05T12:00:00.000Z');
const scoring: EventScoring = {
  capPerActorPerOwnerPerDay: 50,
  types: { reaction: { weight: 5, once: 'event', entities: ['Image'] } },
  newAccountDays: 7,
  finalizeAfterMs: 24 * 60 * 60 * 1000,
};
const EVENT = {
  name: 'birthday2026',
  startDate: START,
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  teams: ['Blue'],
  scoring,
};
const HAT = { ownerId: 10, cosmeticId: 7, claimKey: 'claimed', team: 'Blue' };

type Fake = ReturnType<typeof fakeRedis>;

// One pod's heal over the shared fake. `sync` is the reconcile: by default it writes HAT onto
// Image:100, as the real one would from the placements.
function pod(fake: Fake, overrides: Partial<SelfHealDeps> = {}) {
  const calls = { sync: 0, referee: [] as string[], logs: [] as Record<string, unknown>[] };
  const healer = createEventPointsSelfHeal({
    isEnabled: async () => true,
    redis: fake.redis as unknown as SelfHealDeps['redis'],
    acquireLock: (name, lockExpiration) =>
      acquireJobLock(name, lockExpiration, fake.redis as unknown as JobLockRedis),
    loadEvent: async (name) =>
      (name === EVENT.name ? EVENT : undefined) as Awaited<ReturnType<SelfHealDeps['loadEvent']>>,
    syncEventHats: async () => {
      calls.sync++;
      fake.placeHat(EVENT.name, 'Image:100', encodeHat(HAT));
      return [{ event: EVENT.name, set: 1, removed: 0 }];
    },
    getScoringPhase: async () => ({ from: START }),
    runReferee: (async (_event, season) => {
      calls.referee.push(season);
      return { season, rows: 0, changed: 0, final: false };
    }) as SelfHealDeps['runReferee'],
    log: (entry) => void calls.logs.push(entry),
    now: () => NOW,
    pod: 'pod-a',
    ...overrides,
  });
  return { heal: healer.heal, calls };
}

describe('the self-heal', () => {
  it('runs the reconcile and the settle, logs who and why, and starts the cooldown', async () => {
    const fake = fakeRedis();
    const { heal, calls } = pod(fake);
    expect(await heal(EVENT.name, 'empty-map')).toBe('ran');
    expect(calls.sync).toBe(1);
    expect(calls.referee).toEqual(['live']);
    expect(calls.logs).toEqual([
      expect.objectContaining({
        name: 'event-points',
        fn: 'selfHeal',
        event: EVENT.name,
        reason: 'empty-map',
        pod: 'pod-a',
        outcome: 'ran',
        set: 1,
      }),
    ]);
    expect(fake.strings.get(selfHealCooldownKey(EVENT.name))).toBe('empty-map');
    expect(fake.ttls.get(selfHealCooldownKey(EVENT.name))).toBe(SELF_HEAL_COOLDOWN_S);
    // The job lock is released when it is done.
    expect(fake.strings.has(jobLockKey(SETTLE_JOB))).toBe(false);
  });

  it('does nothing at all while the switch is off', async () => {
    const fake = fakeRedis();
    const { heal, calls } = pod(fake, { isEnabled: async () => false });
    expect(await heal(EVENT.name, 'empty-map')).toBe('off');
    expect(calls).toEqual({ sync: 0, referee: [], logs: [] });
    expect(fake.strings.size).toBe(0);
  });

  // Right after a deploy every pod finds no count base at once.
  it('runs once across five pods asking at the same moment', async () => {
    const fake = fakeRedis();
    const pods = Array.from({ length: 5 }, () => pod(fake));
    const outcomes = await Promise.all(pods.map((p) => p.heal(EVENT.name, 'missing-count-base')));
    expect(outcomes.filter((o) => o === 'ran')).toHaveLength(1);
    expect(pods.reduce((n, p) => n + p.calls.referee.length, 0)).toBe(1);
  });

  // The lock alone, without the cooldown in the way: two pods past the cooldown in the same moment.
  it('lets only one of two pods past the cooldown hold the lock', async () => {
    const fake = fakeRedis();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = pod(fake, {
      syncEventHats: async () => {
        await held;
        return [];
      },
    });
    const first = slow.heal(EVENT.name, 'empty-map');
    await vi.waitFor(() => expect(fake.strings.has(jobLockKey(SETTLE_JOB))).toBe(true));
    fake.strings.delete(selfHealCooldownKey(EVENT.name));
    const other = pod(fake);
    expect(await other.heal(EVENT.name, 'empty-map')).toBe('locked');
    expect(other.calls.sync).toBe(0);
    release();
    expect(await first).toBe('ran');
  });

  // An event with no hats placed stays empty after a reconcile, and finds it empty again next load.
  it('does not heal again inside the cooldown, whatever the last one found', async () => {
    const fake = fakeRedis();
    const { heal, calls } = pod(fake, { syncEventHats: async () => (calls.sync++, []) });
    expect(await heal(EVENT.name, 'empty-map')).toBe('ran');
    expect(await heal(EVENT.name, 'empty-map')).toBe('cooldown');
    expect(await heal(EVENT.name, 'missing-count-base')).toBe('cooldown');
    expect(calls.sync).toBe(1);
  });

  // The hourly job is doing the same work: wait for it rather than queue behind it.
  it('skips, and keeps the cooldown, while the hourly job holds its lock', async () => {
    const fake = fakeRedis();
    fake.strings.set(jobLockKey(SETTLE_JOB), 'the-hourly-run');
    const { heal, calls } = pod(fake);
    expect(await heal(EVENT.name, 'switch-on')).toBe('locked');
    expect(calls.sync).toBe(0);
    expect(calls.logs).toEqual([
      expect.objectContaining({ reason: 'switch-on', outcome: 'locked', pod: 'pod-a' }),
    ]);
    expect(fake.strings.has(selfHealCooldownKey(EVENT.name))).toBe(true);
    expect(fake.strings.get(jobLockKey(SETTLE_JOB))).toBe('the-hourly-run');
  });

  it('does not stack a second heal on a pod whose first is still running', async () => {
    const fake = fakeRedis();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { heal, calls } = pod(fake, {
      syncEventHats: async () => {
        calls.sync++;
        await held;
        return [];
      },
    });
    const first = heal(EVENT.name, 'empty-map');
    expect(await heal(EVENT.name, 'switch-on')).toBe('busy');
    release();
    expect(await first).toBe('ran');
    expect(calls.sync).toBe(1);
  });

  it('logs a failed settle with its reason, releases the lock, and keeps the cooldown', async () => {
    const fake = fakeRedis();
    const { heal, calls } = pod(fake, {
      runReferee: (async () => {
        throw new Error('clickhouse down');
      }) as SelfHealDeps['runReferee'],
    });
    expect(await heal(EVENT.name, 'missing-count-base')).toBe('failed');
    expect(calls.logs).toEqual([
      expect.objectContaining({
        type: 'error',
        reason: 'missing-count-base',
        outcome: 'failed',
        message: 'clickhouse down',
      }),
    ]);
    expect(fake.strings.has(jobLockKey(SETTLE_JOB))).toBe(false);
    expect(fake.strings.has(selfHealCooldownKey(EVENT.name))).toBe(true);
  });

  it('reconciles but does not settle when nothing is being scored yet', async () => {
    const fake = fakeRedis();
    const { heal, calls } = pod(fake, { getScoringPhase: async () => null });
    expect(await heal(EVENT.name, 'empty-map')).toBe('ran');
    expect(calls.sync).toBe(1);
    expect(calls.referee).toEqual([]);
  });

  // Its lock must be the hourly settle's own, or the two could stage the same bases at once.
  it("takes the hourly settle job's lock, for as long as that job may hold it", () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../jobs/event-engine-work.ts'),
      'utf8'
    );
    const job = source.slice(source.indexOf('export const eventEngineLeaderboardUpdate'));
    expect(job).toMatch(new RegExp(String.raw`^[^;]*createJob\(\s*'${SETTLE_JOB}'`));
    expect(job.slice(0, job.indexOf('\n);'))).toContain('lockExpiration: 15 * 60');
    expect(SETTLE_LOCK_S).toBe(15 * 60);
  });
});

describe('the engine asks for a heal', () => {
  function engineOver(fake: Fake, selfHeal = vi.fn()) {
    const engine = createEventPointsEngine({
      redis: fake.redis as unknown as EventPointsRedis,
      insertLedger: async () => undefined,
      loadScoredEvents: async () => [EVENT],
      now: () => NOW,
      logError: vi.fn(),
      onGrant: () => undefined,
      selfHeal,
    });
    return { engine, selfHeal };
  }
  const countBase = eventSeasonKeys(EVENT.name, 'live').base('count');

  it('when it loads an empty hat map', async () => {
    const { engine, selfHeal } = engineOver(fakeRedis());
    await engine.refresh();
    await vi.waitFor(() => expect(selfHeal).toHaveBeenCalledWith(EVENT.name, 'empty-map'));
    expect(selfHeal).toHaveBeenCalledTimes(1);
  });

  it('when the hat map is there but the season has no count base', async () => {
    const fake = fakeRedis();
    fake.setHash(eventPointKeys(EVENT.name).hats, 'Image:100', encodeHat(HAT));
    const { engine, selfHeal } = engineOver(fake);
    await engine.refresh();
    await vi.waitFor(() => expect(selfHeal).toHaveBeenCalledWith(EVENT.name, 'missing-count-base'));
    expect(selfHeal).toHaveBeenCalledTimes(1);
  });

  it('not when the map and the count base are both there', async () => {
    const fake = fakeRedis();
    fake.setHash(eventPointKeys(EVENT.name).hats, 'Image:100', encodeHat(HAT));
    fake.setHash(countBase, COUNT_BASE_MARK, '1');
    const hGet = vi.spyOn(fake.redis, 'hGet');
    const { engine, selfHeal } = engineOver(fake);
    await engine.refresh();
    // The check ran (the control for the silence below), and asked for nothing.
    await vi.waitFor(() => expect(hGet).toHaveBeenCalledWith(countBase, COUNT_BASE_MARK));
    expect(selfHeal).not.toHaveBeenCalled();
  });

  it('a failing check neither throws nor fails the reload', async () => {
    const fake = fakeRedis();
    fake.setHash(eventPointKeys(EVENT.name).hats, 'Image:100', encodeHat(HAT));
    fake.redis.hGet = async () => {
      throw new Error('down');
    };
    const { engine, selfHeal } = engineOver(fake);
    await expect(engine.refresh()).resolves.toBeUndefined();
    expect(selfHeal).not.toHaveBeenCalled();
    expect(await engine.isHattedEntityOnceLoaded('Image', 100)).toBe(true);
  });

  // The pin: switched on with an empty map, the engine earns without waiting for the hourly job.
  it('switched on with an empty map, earns after its own heal rather than at the next hour', async () => {
    const fake = fakeRedis();
    const healer = pod(fake);
    const ledger: unknown[] = [];
    const engine = createEventPointsEngine({
      redis: fake.redis as unknown as EventPointsRedis,
      insertLedger: async (rows) => void ledger.push(...rows),
      loadScoredEvents: async () => [EVENT],
      now: () => NOW,
      logError: vi.fn(),
      onGrant: () => undefined,
      selfHeal: (event, reason) => void healer.heal(event, reason),
    });
    const reaction = {
      type: 'reaction' as const,
      actorId: 1,
      entityType: 'Image' as const,
      entityId: 100,
      sourceId: 'ImageReaction:100:1',
    };
    await engine.awardEventPoints([reaction]);
    // Nothing earned on the empty map: the control for the earning below.
    expect(ledger).toEqual([]);
    await vi.waitFor(() => expect(healer.calls.sync).toBe(1));
    // The next reload (no new traffic needed beyond the next award) finds the hat the heal wrote.
    await engine.refresh();
    await engine.awardEventPoints([reaction]);
    expect(ledger).toHaveLength(1);
  });
});

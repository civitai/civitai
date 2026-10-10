import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventScoring } from '~/server/events/base.event';
import type {
  EventPointLedgerRow,
  EventPointsDeps,
  EventPointsRedis,
} from '~/server/events/points/award';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { cappedGrant, createEventPointsEngine, streamIdBefore } = await import(
  '~/server/events/points/award'
);
const {
  countField,
  encodeHat,
  eventPointKeys,
  eventSeasonKeys,
  hatField,
  hatTopicId,
  liveBucket,
  previewTopicId,
} = await import('~/server/events/points/keys');

// A small Redis with real set, hash and stream semantics: the engine's correctness is in how it
// combines SADD and HINCRBY results, so a fake that records calls would test nothing.
function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
  const streams = new Map<string, { id: string; message: Record<string, string> }[]>();
  // Absolute expiry (unix seconds) per key, as EXPIRE / EXPIREAT left it.
  const ttls = new Map<string, number>();
  let seq = 0;
  let clock = () => Date.now();
  const redis = {
    async sAdd(key: string, member: string) {
      const set = sets.get(key) ?? new Set();
      sets.set(key, set);
      if (set.has(member)) return 0;
      set.add(member);
      return 1;
    },
    async sRem(key: string, member: string) {
      return sets.get(key)?.delete(member) ? 1 : 0;
    },
    async expire(key: string, seconds: number) {
      ttls.set(key, Math.floor(clock() / 1000) + seconds);
      return true;
    },
    async expireAt(key: string, at: number) {
      ttls.set(key, at);
      return true;
    },
    async hIncrBy(key: string, field: string, by: number) {
      const hash = hashes.get(key) ?? new Map();
      hashes.set(key, hash);
      const next = Number(hash.get(field) ?? 0) + by;
      hash.set(field, String(next));
      return next;
    },
    async hGet(key: string, field: string) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hGetAll(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hmGet(key: string, fields: string[]) {
      return fields.map((field) => hashes.get(key)?.get(field) ?? null);
    },
    // Real XRANGE argument order: start is the low end ('-' or an id, '(' for exclusive), end '+'.
    async xRange(key: string, start: string, end: string, opts?: { COUNT?: number }) {
      if (start === '+' || end === '-') return [];
      const all = streams.get(key) ?? [];
      const after = start.startsWith('(') ? start.slice(1) : undefined;
      const rows = after ? all.filter((e) => streamIdBefore(after, e.id)) : all;
      return opts?.COUNT ? rows.slice(0, opts.COUNT) : rows;
    },
    // XREVRANGE takes the high end first: '+' then '-'.
    async xRevRange(key: string, end: string, start: string, opts?: { COUNT?: number }) {
      if (end !== '+' || start !== '-') return [];
      const rows = [...(streams.get(key) ?? [])].reverse();
      return opts?.COUNT ? rows.slice(0, opts.COUNT) : rows;
    },
  };
  // Drops the oldest log entries, as XTRIM does.
  const trimLog = (event: string, keep: number) => {
    const log = streams.get(eventPointKeys(event).hatsLog) ?? [];
    log.splice(0, Math.max(0, log.length - keep));
  };
  // Changes the hats hash without logging it, as when the change's log entry was trimmed away.
  const setHatUnlogged = (event: string, entity: string, value: string) => {
    const hash = hashes.get(eventPointKeys(event).hats) ?? new Map();
    hashes.set(eventPointKeys(event).hats, hash);
    hash.set(entity, value);
  };
  // Appends a log entry without touching the hash: a writer whose log entry lands after another's.
  const logOnly = (event: string, entity: string, value: string) => {
    const keys = eventPointKeys(event);
    const log = streams.get(keys.hatsLog) ?? [];
    streams.set(keys.hatsLog, log);
    log.push({ id: `${1000 + ++seq}-0`, message: { k: entity, v: value } });
  };
  const setHat = (event: string, entity: string, value: string) => {
    const keys = eventPointKeys(event);
    const hash = hashes.get(keys.hats) ?? new Map();
    hashes.set(keys.hats, hash);
    if (value) hash.set(entity, value);
    else hash.delete(entity);
    const log = streams.get(keys.hatsLog) ?? [];
    streams.set(keys.hatsLog, log);
    log.push({ id: `${1000 + ++seq}-0`, message: { k: entity, v: value } });
  };
  return {
    redis: redis as unknown as EventPointsRedis,
    sets,
    hashes,
    ttls,
    setHat,
    setHatUnlogged,
    logOnly,
    trimLog,
    setClock: (fn: () => number) => (clock = fn),
  };
}

const START = new Date('2026-11-01T00:00:00.000Z');
const END = new Date('2026-12-01T00:00:00.000Z');
const scoring: EventScoring = {
  capPerActorPerOwnerPerDay: 50,
  types: {
    view: { weight: 1, once: 'day', entities: ['Image', 'Model', 'Article'] },
    reaction: { weight: 5, once: 'event', entities: ['Image', 'Article'] },
    remix: { weight: 25, once: 'event', entities: ['Image'] },
    modelLike: { weight: 5, once: 'event', entities: ['Model'] },
  },
  newAccountDays: 7,
  finalizeAfterMs: 24 * 60 * 60 * 1000,
};
const EVENT = { name: 'birthday2026', startDate: START, endDate: END, teams: ['Yellow'], scoring };
const OWNER = 10;
const HAT = { ownerId: OWNER, cosmeticId: 7, claimKey: 'claimed', team: 'Yellow' };
const HAT_FIELD = hatField(HAT);

let now: Date;
let fake: ReturnType<typeof fakeRedis>;
let ledger: EventPointLedgerRow[];
let engine: ReturnType<typeof createEventPointsEngine>;
let granted: { event: string; hat: object; time: Date }[];

function build(overrides: Partial<EventPointsDeps> = {}) {
  engine = createEventPointsEngine({
    redis: fake.redis,
    insertLedger: async (rows) => void ledger.push(...rows),
    loadScoredEvents: async () => [EVENT],
    now: () => now,
    logError: () => undefined,
    onGrant: (def, hat, time) => void granted.push({ event: def.name, hat, time }),
    // Asked for on every reload here (no count base): self-heal.test.ts covers when and what.
    selfHeal: () => undefined,
    ...overrides,
  });
}

// Total live points granted to a scope in the current season, across all buckets.
function livePoints(scope: 'hat' | 'team' | 'owner' | 'count', field: string) {
  const keys = eventSeasonKeys(EVENT.name, now < START ? 'preview' : 'live');
  const bucket = liveBucket(now);
  let total = 0;
  for (let b = bucket - 20; b <= bucket; b++)
    total += Number(fake.hashes.get(keys.live(b, scope))?.get(field) ?? 0);
  return total;
}

beforeEach(() => {
  now = new Date('2026-11-05T12:00:00.000Z');
  fake = fakeRedis();
  fake.setClock(() => now.getTime());
  ledger = [];
  granted = [];
  fake.setHat(EVENT.name, 'Image:100', encodeHat(HAT));
  build();
});

const reaction = (actorId: number, entityId = 100) => ({
  type: 'reaction' as const,
  actorId,
  entityType: 'Image' as const,
  entityId,
  sourceId: `ImageReaction:${entityId}:${actorId}`,
});

describe('cappedGrant', () => {
  it('grants the full weight under the cap, the remainder at it, nothing past it', () => {
    expect(cappedGrant(5, 5, 50)).toBe(5);
    expect(cappedGrant(25, 60, 50)).toBe(15);
    expect(cappedGrant(5, 55, 50)).toBe(0);
    expect(cappedGrant(5, 50, 50)).toBe(5);
  });
});

describe('awardEventPoints', () => {
  it('counts one person once per post per event, however many reactions they leave', async () => {
    await engine.awardEventPoints([reaction(1), reaction(1), reaction(1)]);
    expect(livePoints('hat', HAT_FIELD)).toBe(5);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: 'reaction',
      actorId: 1,
      ownerId: OWNER,
      team: 'Yellow',
    });
  });

  it('caps what one person gives one creator in a day at 50 points, cutting the crossing action', async () => {
    fake.setHat(EVENT.name, 'Image:101', encodeHat(HAT));
    for (let id = 200; id < 245; id++) fake.setHat(EVENT.name, `Image:${id}`, encodeHat(HAT));
    build();
    // 45 views (45 points), then a remix (25) of which only 5 fits, then a reaction that gets nothing.
    const views = Array.from({ length: 45 }, (_, i) => ({
      type: 'view' as const,
      actorId: 1,
      entityType: 'Image' as const,
      entityId: 200 + i,
    }));
    await engine.awardEventPoints(views);
    await engine.awardEventPoints([{ ...reaction(1, 101), type: 'remix' }]);
    await engine.awardEventPoints([reaction(1, 100)]);
    expect(livePoints('owner', String(OWNER))).toBe(50);
    expect(livePoints('team', 'Yellow')).toBe(50);
    // Every first is still a fact in the ledger; the referee decides what scores.
    expect(ledger).toHaveLength(47);
    // Counted like the referee counts (granted > 0): the remix got 5 of its 25, the reaction nothing.
    expect(livePoints('count', countField('view', HAT))).toBe(45);
    expect(livePoints('count', countField('remix', HAT))).toBe(1);
    expect(livePoints('count', countField('reaction', HAT))).toBe(0);
  });

  // The count is display only. Failing, it must not cost the points their push or their TTLs, and
  // its key must not be marked as given a TTL it never got.
  it('keeps the points, their push and their TTLs when the count increment fails', async () => {
    const hIncrBy = fake.redis.hIncrBy;
    const errors: string[] = [];
    let countDown = true;
    build({
      redis: {
        ...fake.redis,
        hIncrBy: (async (key: string, field: string, by: number) => {
          if (countDown && key.endsWith(':count')) throw new Error('count shard down');
          return hIncrBy(key, field, by);
        }) as typeof hIncrBy,
      },
      logError: (kind, fn) => void errors.push(`${kind}:${fn}`),
    });
    await engine.awardEventPoints([reaction(1)]);
    expect(errors).toEqual(['redis:eventPoints.liveCount']);
    expect(livePoints('hat', HAT_FIELD)).toBe(5);
    expect(granted).toHaveLength(1);
    const keys = eventSeasonKeys(EVENT.name, 'live');
    const bucket = liveBucket(now);
    const ttl = Math.floor(now.getTime() / 1000) + 3 * 60 * 60;
    for (const scope of ['hat', 'team', 'owner'] as const)
      expect(fake.ttls.get(keys.live(bucket, scope))).toBe(ttl);
    expect(fake.ttls.has(keys.live(bucket, 'count'))).toBe(false);
    // The next grant in the bucket that does count gives the count key its TTL.
    countDown = false;
    await engine.awardEventPoints([reaction(2)]);
    expect(livePoints('count', countField('reaction', HAT))).toBe(1);
    expect(fake.ttls.get(keys.live(bucket, 'count'))).toBe(ttl);
  });

  it('counts a granted action on its hat, at one HINCRBY more than the points', async () => {
    const hIncrBy = fake.redis.hIncrBy;
    const calls: string[] = [];
    build({
      redis: {
        ...fake.redis,
        hIncrBy: (async (key: string, field: string, by: number) => {
          calls.push(`${key.split(':').slice(-1)[0]} ${field} ${by}`);
          return hIncrBy(key, field, by);
        }) as typeof hIncrBy,
      },
    });
    await engine.awardEventPoints([reaction(1)]);
    // The cap, then one per live scope; only the count goes up by one rather than the grant.
    expect(calls.sort()).toEqual(
      [
        `${OWNER} 1 5`,
        `count ${countField('reaction', HAT)} 1`,
        `hat ${HAT_FIELD} 5`,
        `owner ${OWNER} 5`,
        'team Yellow 5',
      ].sort()
    );
  });

  it('counts a view once per person per post per UTC day', async () => {
    const view = { type: 'view' as const, actorId: 1, entityType: 'Image' as const, entityId: 100 };
    await engine.awardEventPoints([view, view]);
    now = new Date('2026-11-06T12:00:00.000Z');
    await engine.awardEventPoints([view]);
    expect(ledger.map((r) => r.time.slice(0, 10))).toEqual(['2026-11-05', '2026-11-06']);
  });

  it('gives nothing for the owner on their own post, an unhatted post, or a type the entity cannot earn', async () => {
    await engine.awardEventPoints([
      reaction(OWNER),
      reaction(1, 999),
      { type: 'modelLike', actorId: 1, entityType: 'Image', entityId: 100 },
    ]);
    expect(livePoints('hat', HAT_FIELD)).toBe(0);
    expect(ledger).toEqual([]);
  });

  it('skips new and banned accounts when the caller knows the actor', async () => {
    await engine.awardEventPoints([
      { ...reaction(1), actor: { createdAt: new Date('2026-10-30T00:00:00.000Z') } },
      { ...reaction(2), actor: { bannedAt: new Date('2026-10-01T00:00:00.000Z') } },
      { ...reaction(3), actor: { createdAt: new Date('2026-01-01T00:00:00.000Z') } },
    ]);
    expect(ledger.map((r) => r.actorId)).toEqual([3]);
  });

  // A session from the auth hub carries its dates as ISO strings, not Dates.
  it('reads the actor dates a hub session sends as strings', async () => {
    await engine.awardEventPoints([
      { ...reaction(1), actor: { createdAt: '2026-10-30T00:00:00.000Z' } },
      { ...reaction(2), actor: { bannedAt: '2026-10-01T00:00:00.000Z' } },
      { ...reaction(3), actor: { createdAt: '2026-01-01T00:00:00.000Z', bannedAt: null } },
    ]);
    expect(ledger.map((r) => r.actorId)).toEqual([3]);
  });

  it('ignores actions after the event ends, though hats stay on content', async () => {
    now = new Date(END.getTime() + 60 * 1000);
    await engine.awardEventPoints([reaction(1)]);
    expect(ledger).toEqual([]);
  });

  it('keeps preview and launch apart: a tester who reacted in the preview earns again at launch', async () => {
    now = new Date('2026-10-20T12:00:00.000Z');
    await engine.awardEventPoints([reaction(1)]);
    now = new Date('2026-11-02T12:00:00.000Z');
    await engine.awardEventPoints([reaction(1)]);
    expect(ledger).toHaveLength(2);
    expect(livePoints('hat', HAT_FIELD)).toBe(5);
  });

  it('follows hats as they move, from the change log', async () => {
    await engine.awardEventPoints([reaction(1, 300)]);
    expect(ledger).toEqual([]);
    fake.setHat(EVENT.name, 'Image:300', encodeHat(HAT));
    fake.setHat(EVENT.name, 'Image:100', '');
    now = new Date(now.getTime() + 31 * 1000);
    await engine.refresh();
    await engine.awardEventPoints([reaction(1, 300), reaction(2, 100)]);
    expect(ledger.map((r) => r.entityId)).toEqual([300]);
  });

  it('never throws, and logs when Redis fails', async () => {
    const logError = vi.fn();
    build({
      logError,
      redis: { ...fake.redis, sAdd: () => Promise.reject(new Error('redis down')) },
    });
    await engine.refresh();
    await expect(engine.awardEventPoints([reaction(1)])).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith('redis', 'eventPoints.award', expect.any(Error));
  });

  it('keeps the other actions of a batch when one fails in Redis', async () => {
    const real = fake.redis.sAdd;
    build({
      redis: {
        ...fake.redis,
        sAdd: ((key: string, member: string) =>
          member === '2'
            ? Promise.reject(new Error('redis blip'))
            : real(key as never, member)) as typeof real,
      },
    });
    await engine.awardEventPoints([reaction(1), reaction(2), reaction(3)]);
    expect(ledger.map((r) => r.actorId)).toEqual([1, 3]);
  });

  it('writes the whole fact to the ledger: who, what, which hat, and the source id', async () => {
    await engine.awardEventPoints([reaction(1)]);
    expect(ledger).toEqual([
      {
        event: EVENT.name,
        time: '2026-11-05 12:00:00.000',
        type: 'reaction',
        op: 'add',
        actorId: 1,
        entityType: 'Image',
        entityId: 100,
        ownerId: OWNER,
        cosmeticId: 7,
        claimKey: 'claimed',
        team: 'Yellow',
        sourceId: 'ImageReaction:100:1',
      },
    ]);
  });

  it('reports the grant for a live push when the total moves, and only then', async () => {
    await engine.awardEventPoints([reaction(OWNER)]);
    expect(granted).toEqual([]);
    await engine.awardEventPoints([reaction(1)]);
    expect(granted).toEqual([{ event: EVENT.name, hat: HAT, time: now }]);
    expect(livePoints('hat', HAT_FIELD)).toBe(5);
  });

  it('a push that throws neither fails the award nor costs the live buckets their TTL', async () => {
    const errors: string[] = [];
    build({
      onGrant: () => {
        throw new Error('pusher broke');
      },
      logError: (kind, fn) => void errors.push(`${kind}:${fn}`),
    });
    await engine.awardEventPoints([reaction(1)]);
    expect(errors).toEqual(['push:eventPoints.onGrant']);
    expect(livePoints('hat', HAT_FIELD)).toBe(5);
    expect(ledger).toHaveLength(1);
    const keys = eventSeasonKeys(EVENT.name, 'live');
    const bucket = liveBucket(now);
    const ttl = Math.floor(now.getTime() / 1000) + 3 * 60 * 60;
    for (const scope of ['hat', 'team', 'owner', 'count'] as const)
      expect(fake.ttls.get(keys.live(bucket, scope))).toBe(ttl);
  });

  it('does not report the grant when a live increment fails', async () => {
    const hIncrBy = fake.redis.hIncrBy;
    const liveBucketKey = /:live:[0-9]+:/;
    const failedKeys: string[] = [];
    build({
      redis: {
        ...fake.redis,
        hIncrBy: (async (key: string, field: string, by: number) => {
          if (liveBucketKey.test(key)) {
            failedKeys.push(key);
            throw new Error('down');
          }
          return hIncrBy(key, field, by);
        }) as typeof hIncrBy,
      },
    });
    await engine.awardEventPoints([reaction(1)]);
    // The award got as far as the live increments (past the cap), and they failed.
    expect(failedKeys.length).toBe(4);
    expect(ledger).toHaveLength(1);
    expect(granted).toEqual([]);
  });

  it('expires day-scoped keys an hour after their UTC day, and event keys after finalization', async () => {
    const view = { type: 'view' as const, actorId: 1, entityType: 'Image' as const, entityId: 100 };
    await engine.awardEventPoints([view, reaction(2)]);
    const keys = eventSeasonKeys(EVENT.name, 'live');
    const endOfDayPlusHour = Date.UTC(2026, 10, 6, 1) / 1000;
    expect(fake.ttls.get(keys.seen('view', 'Image', 100, '2026-11-05'))).toBe(endOfDayPlusHour);
    expect(fake.ttls.get(keys.cap('2026-11-05', OWNER))).toBe(endOfDayPlusHour);
    const finalized = (END.getTime() + scoring.finalizeAfterMs) / 1000;
    expect(fake.ttls.get(keys.seen('reaction', 'Image', 100))).toBe(finalized + 2 * 24 * 60 * 60);
  });
});

describe('the 50-point cap', () => {
  const view = (actorId: number, entityId: number) => ({
    type: 'view' as const,
    actorId,
    entityType: 'Image' as const,
    entityId,
  });
  const OTHER = { ownerId: 20, cosmeticId: 8, claimKey: 'claimed', team: 'Blue' };
  beforeEach(() => {
    for (let id = 200; id < 260; id++) fake.setHat(EVENT.name, `Image:${id}`, encodeHat(HAT));
    for (let id = 300; id < 360; id++) fake.setHat(EVENT.name, `Image:${id}`, encodeHat(OTHER));
    build();
  });
  const views = (actorId: number, from: number, n: number) =>
    Array.from({ length: n }, (_, i) => view(actorId, from + i));

  it('is per person: a second person still gives their full 50 after the first is capped', async () => {
    await engine.awardEventPoints(views(1, 200, 60));
    await engine.awardEventPoints(views(2, 200, 60));
    expect(livePoints('owner', String(OWNER))).toBe(100);
  });

  it('is per creator: capped on one creator, the same person still gives another creator 50', async () => {
    await engine.awardEventPoints(views(1, 200, 60));
    await engine.awardEventPoints(views(1, 300, 60));
    expect(livePoints('owner', String(OWNER))).toBe(50);
    expect(livePoints('owner', '20')).toBe(50);
  });

  it('is per UTC day: the next day starts a fresh 50', async () => {
    now = new Date('2026-11-05T23:50:00.000Z');
    await engine.awardEventPoints(views(1, 200, 60));
    now = new Date('2026-11-06T00:10:00.000Z');
    await engine.awardEventPoints(views(1, 200, 60));
    const keys = eventSeasonKeys(EVENT.name, 'live');
    let total = 0;
    for (let b = liveBucket(now) - 10; b <= liveBucket(now); b++)
      total += Number(fake.hashes.get(keys.live(b, 'owner'))?.get(String(OWNER)) ?? 0);
    expect(total).toBe(100);
  });
});

describe('when the ledger write fails', () => {
  it('takes the dedupe marks back, so the same action earns when it comes again', async () => {
    let fail = true;
    const logError = vi.fn();
    build({
      logError,
      insertLedger: async (rows) => {
        if (fail) throw new Error('clickhouse down');
        ledger.push(...rows);
      },
    });
    await engine.awardEventPoints([reaction(1)]);
    expect(logError).toHaveBeenCalledWith('ledger', 'eventPoints.insertLedger', expect.any(Error), {
      rows: 1,
    });
    fail = false;
    await engine.awardEventPoints([reaction(1)]);
    expect(ledger.map((r) => r.actorId)).toEqual([1]);
  });

  // 🔴 Deliberate: a failed REMOVAL insert does NOT put the dedupe mark back. A rejected insert may
  // still have landed; restoring the mark over a landed removal would block the person's re-add
  // forever (the referee then sees remove as the latest row). Not restoring costs only live points
  // shown until the next referee run. If you are about to add a restore here, read award.ts first.
  it('leaves a failed removal unmarked, so a re-add is written to the ledger and earns again', async () => {
    await engine.awardEventPoints([reaction(1)]);
    build({
      insertLedger: async () => {
        throw new Error('clickhouse timeout');
      },
    });
    await engine.removeEventPoints([reaction(1)]);
    build();
    await engine.awardEventPoints([reaction(1)]);
    expect(ledger.map((r) => `${r.op}:${r.actorId}`)).toEqual(['add:1', 'add:1']);
  });
});

describe('when Redis fails after the dedupe mark', () => {
  // The mark is already taken, so a retry is a repeat: the ledger row is the action's only record.
  it('still writes the ledger row, losing only the live points', async () => {
    const logError = vi.fn();
    build({
      logError,
      redis: {
        ...fake.redis,
        hIncrBy: async () => {
          throw new Error('redis timeout');
        },
      },
    });
    await engine.awardEventPoints([reaction(1)]);
    expect(ledger.map((r) => [r.op, r.actorId])).toEqual([['add', 1]]);
    expect(logError).toHaveBeenCalledWith('redis', 'eventPoints.liveGrant', expect.any(Error));
  });

  it('keeps the other actions in the batch earning live', async () => {
    build({
      redis: {
        ...fake.redis,
        hIncrBy: async (key: string, field: string, by: number) => {
          if (field === '1') throw new Error('redis timeout');
          return fake.redis.hIncrBy(key, field, by);
        },
      },
    });
    await engine.awardEventPoints([reaction(1), reaction(2)]);
    expect(ledger.map((r) => r.actorId)).toEqual([1, 2]);
    expect(livePoints('hat', HAT_FIELD)).toBe(5);
  });
});

describe('state refresh', () => {
  it('picks up hat changes on its own, without a caller ever waiting on it', async () => {
    await engine.awardEventPoints([reaction(1)]);
    fake.setHat(EVENT.name, 'Image:400', encodeHat(HAT));
    now = new Date(now.getTime() + 31 * 1000);
    // Stale: this call starts a refresh in the background and still uses the old map.
    expect(engine.isHattedEntity('Image', 400)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.isHattedEntity('Image', 400)).toBe(true);
  });

  it('follows the hat log every 2s, between the 30s reloads, with one read when nothing changed', async () => {
    await engine.refresh();
    const xRange = vi.spyOn(fake.redis, 'xRange');
    now = new Date(now.getTime() + 2_000);
    engine.isHattedEntity('Image', 100);
    await new Promise((r) => setTimeout(r, 0));
    expect(xRange).toHaveBeenCalledTimes(1);

    fake.setHat(EVENT.name, 'Image:400', encodeHat(HAT));
    now = new Date(now.getTime() + 1_999);
    engine.isHattedEntity('Image', 400);
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.isHattedEntity('Image', 400)).toBe(false);
    now = new Date(now.getTime() + 1);
    engine.isHattedEntity('Image', 400);
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.isHattedEntity('Image', 400)).toBe(true);
  });

  // Two writers race: A sets the hat, B removes it and logs the removal, then A logs its set. The
  // hash says off, the last log entry says on; the follower must end up with what the hash says.
  it('takes each changed key from the hash, not from the logged value', async () => {
    await engine.refresh();
    fake.setHat(EVENT.name, 'Image:100', '');
    fake.logOnly(EVENT.name, 'Image:100', encodeHat(HAT));
    now = new Date(now.getTime() + 2_000);
    engine.isHattedEntity('Image', 100);
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.isHattedEntity('Image', 100)).toBe(false);
  });

  it('reloads the whole map when the change log was trimmed past where it had read', async () => {
    await engine.refresh();
    fake.setHatUnlogged(EVENT.name, 'Image:401', encodeHat(HAT));
    fake.setHat(EVENT.name, 'Image:402', encodeHat(HAT));
    fake.setHat(EVENT.name, 'Image:403', encodeHat(HAT));
    fake.trimLog(EVENT.name, 1);
    now = new Date(now.getTime() + 31 * 1000);
    await engine.refresh();
    expect(engine.isHattedEntity('Image', 401)).toBe(true);
    expect(engine.isHattedEntity('Image', 402)).toBe(true);
  });

  it('backs off after a failed refresh instead of retrying on every call', async () => {
    const loadScoredEvents = vi.fn(() => Promise.reject(new Error('down')));
    build({ loadScoredEvents });
    for (let i = 0; i < 50; i++) engine.isHattedEntity('Image', 100);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 50; i++) engine.isHattedEntity('Image', 100);
    expect(loadScoredEvents).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 11 * 1000);
    engine.isHattedEntity('Image', 100);
    expect(loadScoredEvents).toHaveBeenCalledTimes(2);
  });
});

describe('removeEventPoints', () => {
  it('writes removals on hatted posts only, and lets the person earn again after', async () => {
    await engine.awardEventPoints([reaction(1)]);
    await engine.removeEventPoints([reaction(1), reaction(2), reaction(1, 999)]);
    expect(ledger.map((r) => `${r.op}:${r.actorId}:${r.entityId}`)).toEqual([
      'add:1:100',
      'remove:1:100',
      'remove:2:100',
    ]);
    await engine.awardEventPoints([reaction(1)]);
    expect(ledger.at(-1)).toMatchObject({ op: 'add', actorId: 1 });
  });

  it('pairs the removal with its add by source id, even when Redis lost the dedupe mark', async () => {
    await engine.awardEventPoints([reaction(1)]);
    fake.sets.clear();
    await engine.removeEventPoints([reaction(1)]);
    expect(ledger.map((r) => [r.op, r.sourceId])).toEqual([
      ['add', 'ImageReaction:100:1'],
      ['remove', 'ImageReaction:100:1'],
    ]);
  });
});

describe('isHattedEntity', () => {
  it('is false until the first load finishes, then reflects the hats', async () => {
    expect(engine.isHattedEntity('Image', 100)).toBe(false);
    await engine.refresh();
    expect(engine.isHattedEntity('Image', 100)).toBe(true);
    expect(engine.isHattedEntity('Image', 101)).toBe(false);
  });
});

describe('isKnownHatTopic', () => {
  const OTHER = { ...HAT, claimKey: 'other' };

  it('knows the topic of a hat on this server, and nothing else', async () => {
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(HAT), 'live')).toBe(true);
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(OTHER), 'live')).toBe(false);
    expect(await engine.isKnownHatTopic('another-event', hatTopicId(HAT), 'live')).toBe(false);
  });

  it('rebuilds its index when the 2s follow has to reload the whole map', async () => {
    const THIRD = { ...HAT, claimKey: 'third' };
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(HAT), 'live')).toBe(true);
    // A change the log no longer holds: the follow must reload the map rather than replay the log.
    fake.setHatUnlogged(EVENT.name, 'Image:401', encodeHat(OTHER));
    fake.setHat(EVENT.name, 'Image:402', encodeHat(THIRD));
    fake.trimLog(EVENT.name, 1);
    // Past the follow interval, inside the full refresh's: the follow, not refresh(), runs.
    now = new Date(now.getTime() + 2_500);
    await vi.waitFor(async () =>
      expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(THIRD), 'live')).toBe(true)
    );
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(OTHER), 'live')).toBe(true);
  });

  it('follows the hat map: a hat placed is known, a hat taken off is not', async () => {
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(OTHER), 'live')).toBe(false);
    fake.setHat(EVENT.name, 'Image:300', encodeHat(OTHER));
    fake.setHat(EVENT.name, 'Image:100', '');
    now = new Date(now.getTime() + 31 * 1000);
    await engine.refresh();
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(OTHER), 'live')).toBe(true);
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(HAT), 'live')).toBe(false);
  });

  it('keeps a hat known while any entry still wears it', async () => {
    fake.setHat(EVENT.name, 'Image:301', encodeHat(HAT));
    now = new Date(now.getTime() + 31 * 1000);
    await engine.refresh();
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(HAT), 'live')).toBe(true);
    fake.setHat(EVENT.name, 'Image:100', '');
    now = new Date(now.getTime() + 31 * 1000);
    await engine.refresh();
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(HAT), 'live')).toBe(true);
    fake.setHat(EVENT.name, 'Image:301', '');
    now = new Date(now.getTime() + 31 * 1000);
    await engine.refresh();
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(HAT), 'live')).toBe(false);
  });

  // The preview's ids are keyed (keys.ts): in that season the index holds those and nothing else,
  // and the follow keeps it in step in the same naming.
  it('in the preview, knows a hat by its keyed id only, and follows it in that naming', async () => {
    const keyed = (hat: typeof HAT) => previewTopicId(EVENT.name, hatField(hat));
    expect(await engine.isKnownHatTopic(EVENT.name, keyed(HAT), 'preview')).toBe(true);
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(HAT), 'preview')).toBe(false);
    expect(await engine.isKnownHatTopic(EVENT.name, keyed(OTHER), 'preview')).toBe(false);
    fake.setHat(EVENT.name, 'Image:300', encodeHat(OTHER));
    now = new Date(now.getTime() + 31 * 1000);
    await engine.refresh();
    expect(await engine.isKnownHatTopic(EVENT.name, keyed(OTHER), 'preview')).toBe(true);
    // Asked in the other season, it answers in that season's naming.
    expect(await engine.isKnownHatTopic(EVENT.name, keyed(OTHER), 'live')).toBe(false);
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(OTHER), 'live')).toBe(true);
  });

  it('knows nothing while its hat map cannot load, rather than reading anywhere else', async () => {
    build({ loadScoredEvents: () => Promise.reject(new Error('down')) });
    expect(await engine.isKnownHatTopic(EVENT.name, hatTopicId(HAT), 'live')).toBe(false);
  });
});

describe('streamIdBefore', () => {
  it('compares stream ids numerically', () => {
    expect(streamIdBefore('9-0', '10-0')).toBe(true);
    expect(streamIdBefore('10-1', '10-0')).toBe(false);
    expect(streamIdBefore('10-0', '10-1')).toBe(true);
  });
});

// Hooks stamp each action when it happened, so two quick opposite writes order by that time and a
// late-processed action lands on its own day, season and bucket, not the processing clock's.
describe('the time an action carries', () => {
  it('scores an add on its own UTC day and live bucket, not the clock that processed it', async () => {
    const time = new Date('2026-11-04T23:58:00.000Z');
    now = new Date('2026-11-05T00:04:00.000Z');
    await engine.awardEventPoints([{ ...reaction(1), time }]);

    expect(ledger.map((r) => r.time)).toEqual(['2026-11-04 23:58:00.000']);
    const keys = eventSeasonKeys(EVENT.name, 'live');
    expect(fake.hashes.get(keys.cap('2026-11-04', OWNER))?.get('1')).toBe('5');
    expect(fake.hashes.has(keys.cap('2026-11-05', OWNER))).toBe(false);
    expect(fake.hashes.get(keys.live(liveBucket(time), 'hat'))?.get(HAT_FIELD)).toBe('5');
  });

  it('counts an add made before the end though it is processed after', async () => {
    now = new Date(END.getTime() + 60 * 1000);
    await engine.awardEventPoints([{ ...reaction(1), time: new Date(END.getTime() - 1000) }]);
    expect(ledger.map((r) => [r.op, r.time])).toEqual([['add', '2026-11-30 23:59:59.000']]);
  });

  it('stamps a removal with its own time and takes it from that season', async () => {
    const preview = new Date('2026-10-20T12:00:00.000Z');
    now = preview;
    await engine.awardEventPoints([reaction(1)]);
    now = new Date('2026-11-02T12:00:00.000Z');
    await engine.removeEventPoints([{ ...reaction(1), time: preview }]);

    expect(ledger.map((r) => [r.op, r.time])).toEqual([
      ['add', '2026-10-20 12:00:00.000'],
      ['remove', '2026-10-20 12:00:00.000'],
    ]);
    const seen = eventSeasonKeys(EVENT.name, 'preview').seen('reaction', 'Image', 100);
    expect(fake.sets.get(seen)?.has('1')).toBe(false);
  });
});

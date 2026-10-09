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
const { encodeHat, eventPointKeys, eventSeasonKeys, hatField, liveBucket } = await import(
  '~/server/events/points/keys'
);

// A small Redis with real set, hash and stream semantics: the engine's correctness is in how it
// combines SADD and HINCRBY results, so a fake that records calls would test nothing.
function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
  const streams = new Map<string, { id: string; message: Record<string, string> }[]>();
  let seq = 0;
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
    async expire() {
      return true;
    },
    async expireAt() {
      return true;
    },
    async hIncrBy(key: string, field: string, by: number) {
      const hash = hashes.get(key) ?? new Map();
      hashes.set(key, hash);
      const next = Number(hash.get(field) ?? 0) + by;
      hash.set(field, String(next));
      return next;
    },
    async hGetAll(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async xRange(key: string, start: string, _end: string, opts?: { COUNT?: number }) {
      const all = streams.get(key) ?? [];
      const after = start.startsWith('(') ? start.slice(1) : undefined;
      const rows = after ? all.filter((e) => streamIdBefore(after, e.id)) : all;
      return opts?.COUNT ? rows.slice(0, opts.COUNT) : rows;
    },
    async xRevRange(key: string, _s: string, _e: string, opts?: { COUNT?: number }) {
      const rows = [...(streams.get(key) ?? [])].reverse();
      return opts?.COUNT ? rows.slice(0, opts.COUNT) : rows;
    },
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
  return { redis: redis as unknown as EventPointsRedis, sets, hashes, setHat };
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
const EVENT = { name: 'birthday2026', startDate: START, endDate: END, scoring };
const OWNER = 10;
const HAT = { ownerId: OWNER, cosmeticId: 7, claimKey: 'claimed', team: 'Yellow' };
const HAT_FIELD = hatField(HAT);

let now: Date;
let fake: ReturnType<typeof fakeRedis>;
let ledger: EventPointLedgerRow[];
let engine: ReturnType<typeof createEventPointsEngine>;

function build(overrides: Partial<EventPointsDeps> = {}) {
  engine = createEventPointsEngine({
    redis: fake.redis,
    insertLedger: async (rows) => void ledger.push(...rows),
    loadScoredEvents: async () => [EVENT],
    now: () => now,
    logError: () => undefined,
    ...overrides,
  });
}

// Total live points granted to a scope in the current season, across all buckets.
function livePoints(scope: 'hat' | 'team' | 'owner', field: string) {
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
  ledger = [];
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
  });

  it('gives a second person their own 50', async () => {
    await engine.awardEventPoints([reaction(1), reaction(2)]);
    expect(livePoints('hat', HAT_FIELD)).toBe(10);
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
    expect(logError).toHaveBeenCalledWith('event points: award failed', expect.anything());
  });
});

describe('removeEventPoints', () => {
  it('writes a removal only for someone who earned there, and lets them earn again after', async () => {
    await engine.awardEventPoints([reaction(1)]);
    await engine.removeEventPoints([reaction(1), reaction(2), reaction(1, 999)]);
    expect(ledger.map((r) => `${r.op}:${r.actorId}`)).toEqual(['add:1', 'remove:1']);
    await engine.awardEventPoints([reaction(1)]);
    expect(ledger.map((r) => `${r.op}:${r.actorId}`)).toEqual(['add:1', 'remove:1', 'add:1']);
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

describe('streamIdBefore', () => {
  it('compares stream ids numerically', () => {
    expect(streamIdBefore('9-0', '10-0')).toBe(true);
    expect(streamIdBefore('10-1', '10-0')).toBe(false);
    expect(streamIdBefore('10-0', '10-1')).toBe(true);
  });
});

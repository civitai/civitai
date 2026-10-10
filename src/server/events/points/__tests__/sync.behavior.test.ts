import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The hat sync decides whose hats can earn at all: its query runs here on an in-process Postgres
 * with the committed placement migration, and its output (hash + change log) is fed to a real
 * engine, the seam the engine and hook suites each fake.
 */

// The engine's kill switch is on here unless a test turns it off.
const killSwitch = vi.hoisted(() => ({ on: true }));
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => killSwitch.on,
  isEventPointsEnabledSync: () => killSwitch.on,
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});
const { testerFlag } = await import('~/test-utils/testerFlagFake');

const {
  HAT_SYNC_MAX_PASSES,
  desiredEventHats,
  syncEventHats,
  syncOwnerEventHats,
  syncOwnersEventHats,
} = await import('~/server/events/points/sync');
const { createEventPointsEngine } = await import('~/server/events/points/award');
const { encodeHat, eventPointKeys, hatSyncKeys } = await import('~/server/events/points/keys');
const { birthday2026 } = await import('~/server/events/birthday2026.event');

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261012130000_event_cosmetic_placement/migration.sql'
);
const db = { pg: null as unknown as PGlite };
const EVENT = { name: birthday2026.name, entityTypes: ['Image', 'Model', 'Article'] as const };
const OWNER = 1;
const OTHER = 2;
const BANNED = 3;
const EXCLUDED = 4;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'ContentDecoration');
    CREATE TABLE "Cosmetic" ("id" integer PRIMARY KEY, "type" "CosmeticType" NOT NULL, "data" jsonb);
    CREATE TABLE "UserCosmetic" (
      "userId" integer NOT NULL, "cosmeticId" integer NOT NULL, "claimKey" text NOT NULL,
      "equippedAt" timestamp(3), "data" jsonb, "equippedToId" integer, "equippedToType" "CosmeticEntity",
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Article" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "User" (
      "id" integer PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3),
      "excludeFromLeaderboards" boolean NOT NULL DEFAULT false
    );
    INSERT INTO "User" ("id", "bannedAt", "excludeFromLeaderboards") VALUES
      (${OWNER}, NULL, false), (${OTHER}, NULL, false), (${BANNED}, now(), false),
      (${EXCLUDED}, NULL, true);
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await db.pg.close();
});

const place = (
  userId: number,
  entityId: number,
  extra: {
    owner?: number;
    ended?: boolean;
    startedAt?: string;
    cosmeticId?: number;
    entityType?: 'Image' | 'Model' | 'Post';
  } = {}
) =>
  db.pg.query(
    `INSERT INTO "EventCosmeticPlacement"
       (event, "userId", "cosmeticId", "claimKey", team, "entityType", "entityId", "entityOwnerId",
        "startedAt", "endedAt")
     VALUES ($1, $2, $3, 'claimed', 'Blue', $8::"CosmeticEntity", $4, $5, $6::timestamptz,
             CASE WHEN $7 THEN now() ELSE NULL END)`,
    [
      EVENT.name,
      userId,
      extra.cosmeticId ?? 7,
      entityId,
      extra.owner ?? userId,
      extra.startedAt ?? '2026-11-02T00:00:00Z',
      !!extra.ended,
      extra.entityType ?? 'Image',
    ]
  );

beforeEach(async () => {
  await db.pg.exec(`TRUNCATE "EventCosmeticPlacement"`);
  vi.clearAllMocks();
  killSwitch.on = true;
  const raw = pgliteRaw(db.pg);
  dbMock.dbRead.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  // clearAllMocks keeps implementations; the preview tests set this one.
  dbMock.dbWrite.user.findMany.mockReset();
});

describe('desiredEventHats: which placements may earn', () => {
  it('keeps open placements on the owner’s own content, by an owner in good standing', async () => {
    await place(OWNER, 100);
    await place(OWNER, 101, { ended: true, cosmeticId: 8 });
    await place(OTHER, 102, { owner: OWNER });
    await place(BANNED, 103);
    await place(EXCLUDED, 104);
    const hats = await desiredEventHats(EVENT, undefined);
    expect([...hats.keys()]).toEqual(['Image:100']);
    expect(JSON.parse(hats.get('Image:100')!)).toEqual({
      ownerId: OWNER,
      cosmeticId: 7,
      claimKey: 'claimed',
      team: 'Blue',
    });
  });

  it('gives an entity wearing two hats to the one placed first', async () => {
    await place(OWNER, 100, { cosmeticId: 9, startedAt: '2026-11-03T00:00:00Z' });
    await place(OWNER, 100, { cosmeticId: 8, startedAt: '2026-11-02T00:00:00Z' });
    const hats = await desiredEventHats(EVENT, undefined);
    expect(JSON.parse(hats.get('Image:100')!).cosmeticId).toBe(8);
  });

  it('during the preview, keeps only owners the flag is on for', async () => {
    await place(OWNER, 100);
    await place(OTHER, 102);
    testerFlag.reset({ public: false, testers: [OTHER] });
    dbMock.dbWrite.user.findMany.mockImplementation((async ({
      where,
    }: {
      where: { id: { in: number[] } };
    }) => where.id.in.map((id) => ({ id, isModerator: false }))) as never);
    const hats = await desiredEventHats(EVENT, 'birthday-2026');
    expect([...hats.keys()]).toEqual(['Image:102']);
  });
});

describe('syncEventHats -> engine', () => {
  const hashes = new Map<string, Map<string, string>>();
  const log: { k: string; v: string }[] = [];

  beforeEach(() => {
    hashes.clear();
    log.length = 0;
    const sys = redisMock.sysRedis;
    const hash = (key: string) => {
      const h = hashes.get(key) ?? new Map<string, string>();
      hashes.set(key, h);
      return h;
    };
    sys.hGetAll.mockImplementation(async (key: string) =>
      Object.fromEntries(hashes.get(key) ?? [])
    );
    sys.hSet.mockImplementation(async (key: string, field: string, value: string) => {
      hash(key).set(field, value);
      return 1;
    });
    sys.hSetNX.mockImplementation(async (key: string, field: string, value: string) => {
      if (hash(key).has(field)) return false;
      hash(key).set(field, value);
      return true;
    });
    sys.hDel.mockImplementation(async (key: string, field: string) =>
      Number(hash(key).delete(field))
    );
    sys.xAdd.mockImplementation(
      async (_key: string, _id: string, entry: { k: string; v: string }) => {
        log.push(entry);
        return `${log.length}-0`;
      }
    );
    sys.xTrim.mockResolvedValue(0);
    sys.xRevRange.mockImplementation(async () =>
      log.length ? [{ id: `${log.length}-0`, message: log[log.length - 1] }] : []
    );
    sys.hmGet.mockImplementation(async (key: string, fields: string[]) =>
      fields.map((field) => hashes.get(key)?.get(field) ?? null)
    );
    // Entry n of the log has id `n-0`, as xAdd above returns.
    sys.xRange.mockImplementation(
      async (_key: string, start: string, _end: string, opts?: { COUNT?: number }) => {
        const after = start.startsWith('(') ? Number(start.slice(1).split('-')[0]) : 0;
        const rows = log
          .map((message, i) => ({ id: `${i + 1}-0`, message }))
          .filter((_, i) => i + 1 > after);
        return opts?.COUNT ? rows.slice(0, opts.COUNT) : rows;
      }
    );
    // The owner lock and its pending set, with SET NX and SPOP semantics.
    strings.clear();
    sets.clear();
    sys.set.mockImplementation(async (key: string, value: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    });
    sys.exists.mockImplementation(async (key: string) => Number(strings.has(key)));
    sys.del.mockImplementation(async (key: string) => Number(strings.delete(key)));
    sys.sAdd.mockImplementation(async (key: string, members: string[]) => {
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      members.forEach((m) => set.add(m));
      return members.length;
    });
    sys.pExpire.mockResolvedValue(true);
    sys.sPop.mockImplementation(async (key: string) => {
      const members = [...(sets.get(key) ?? [])];
      sets.delete(key);
      return members;
    });
    // The two compare-and-act scripts the lock uses: delete, or extend, only while it is ours. Told
    // apart by the command name as sync.ts spells it.
    sys.eval.mockImplementation(
      async (
        script: string,
        { keys: [key], arguments: [token] }: { keys: string[]; arguments: string[] }
      ) => {
        if (strings.get(key) !== token) return 0;
        if (script.includes("'DEL'")) strings.delete(key);
        return 1;
      }
    );
    testerFlag.reset({ public: true });
  });
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const lock = hatSyncKeys(OWNER);

  const LIVE = new Date('2026-11-05T12:00:00.000Z');
  const keys = eventPointKeys(birthday2026.name);

  it('writes the hats an engine then earns on, and seeds the weights without overwriting them', async () => {
    hashes.set(keys.weights, new Map([['view', '3']]));
    await place(OWNER, 100);
    await syncEventHats(LIVE);

    expect(Object.fromEntries(hashes.get(keys.weights)!)).toEqual({
      view: '3',
      reaction: '5',
      comment: '5',
      sticker: '10',
      remix: '25',
      modelLike: '5',
    });
    expect(log.map((e) => e.k)).toEqual(['Image:100']);

    const engine = createEventPointsEngine({
      redis: redisMock.sysRedis as never,
      insertLedger: async () => undefined,
      loadScoredEvents: async () => [
        {
          name: birthday2026.name,
          startDate: birthday2026.startDate,
          endDate: birthday2026.endDate,
          scoring: birthday2026.scoring!,
        },
      ],
      now: () => LIVE,
      logError: () => undefined,
    });
    await engine.refresh();
    expect(engine.isHattedEntity('Image', 100)).toBe(true);
    expect(engine.isHattedEntity('Image', 101)).toBe(false);
  });

  // Model hats earn model thumbs up and views: the entity types come from the event's scoring config.
  it('syncs hats on every entity type the event scores, not only images', async () => {
    await place(OWNER, 300, { entityType: 'Model', cosmeticId: 8 });
    await syncEventHats(LIVE);
    expect(Object.keys(Object.fromEntries(hashes.get(keys.hats)!))).toEqual(['Model:300']);
  });

  // Before launch only flagged owners' hats may earn; the sync is what applies the flag.
  it('during the preview, syncs only the hats of owners the flag is on for', async () => {
    await place(OWNER, 100);
    await place(OTHER, 102);
    testerFlag.reset({ public: false, testers: [OTHER] });
    dbMock.dbWrite.user.findMany.mockImplementation((async ({
      where,
    }: {
      where: { id: { in: number[] } };
    }) => where.id.in.map((id) => ({ id, isModerator: false }))) as never);
    const PREVIEW = new Date(birthday2026.previewFrom!.getTime() + 24 * 60 * 60 * 1000);
    await syncEventHats(PREVIEW);
    expect(Object.keys(Object.fromEntries(hashes.get(keys.hats)!))).toEqual(['Image:102']);
  });

  it('takes every hat off, and logs it, outside any scoring phase', async () => {
    await place(OWNER, 100);
    await syncEventHats(LIVE);
    // Before the preview opens there is no phase: nothing may earn.
    await syncEventHats(new Date(birthday2026.previewFrom!.getTime() - 1));
    expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({});
    expect(log.at(-1)).toEqual({ k: 'Image:100', v: '' });
  });

  it('takes a hat off, and logs it, when its placement ends', async () => {
    await place(OWNER, 100);
    await syncEventHats(LIVE);
    await db.pg.exec(`UPDATE "EventCosmeticPlacement" SET "endedAt" = now()`);
    await syncEventHats(LIVE);
    expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({});
    expect(log.map((e) => [e.k, e.v === '' ? 'off' : 'on'])).toEqual([
      ['Image:100', 'on'],
      ['Image:100', 'off'],
    ]);
  });

  const ownerHat = (ownerId = OWNER) =>
    encodeHat({ ownerId, cosmeticId: 7, claimKey: 'claimed', team: 'Blue' });
  const image = (entityId: number) => ({ entityType: 'Image', entityId });
  const endPlacement = (entityId: number) =>
    db.pg.query(
      `UPDATE "EventCosmeticPlacement" SET "endedAt" = now() WHERE "entityId" = $1 AND "endedAt" IS NULL`,
      [entityId]
    );

  describe('syncOwnerEventHats: the write-through after an equip', () => {
    it('on equip, writes the hat and then its log entry, with the encoded hat', async () => {
      await place(OWNER, 100);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({ 'Image:100': ownerHat() });
      expect(log).toEqual([{ k: 'Image:100', v: ownerHat() }]);
      const sys = redisMock.sysRedis;
      expect(sys.hSet.mock.invocationCallOrder[0]).toBeLessThan(
        sys.xAdd.mock.invocationCallOrder[0]
      );
      // The placement it reads was written a moment ago, on the primary.
      expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    });

    it('on a move, puts the hat on the new content and takes it off the old one', async () => {
      await place(OWNER, 100);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      await endPlacement(100);
      await place(OWNER, 101);
      await syncOwnerEventHats(OWNER, [image(101), image(100)], LIVE);
      expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({ 'Image:101': ownerHat() });
      expect(log.slice(1)).toEqual([
        { k: 'Image:101', v: ownerHat() },
        { k: 'Image:100', v: '' },
      ]);
    });

    it('on unequip, takes the hat off and logs it', async () => {
      await place(OWNER, 100);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      await endPlacement(100);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({});
      expect(log.at(-1)).toEqual({ k: 'Image:100', v: '' });
    });

    it('writes nothing for a hat on someone else’s content, a banned owner, or an unscored type', async () => {
      await place(OTHER, 102, { owner: OWNER });
      await syncOwnerEventHats(OTHER, [image(102)], LIVE);
      await place(BANNED, 103);
      await syncOwnerEventHats(BANNED, [image(103)], LIVE);
      await place(OWNER, 104, { entityType: 'Post', cosmeticId: 8 });
      await syncOwnerEventHats(OWNER, [{ entityType: 'Post', entityId: 104 }], LIVE);
      expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
      expect(log).toEqual([]);
      // The same calls do write for an eligible hat, so the silence above is the rule, not a crash.
      await place(OWNER, 100);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(log).toEqual([{ k: 'Image:100', v: ownerHat() }]);
    });

    it.each(['"bannedAt" = now()', '"deletedAt" = now()', '"excludeFromLeaderboards" = true'])(
      'takes an owner’s hats off when %s, and puts them back when it is undone',
      async (change) => {
        const OWNER_5 = 5;
        await db.pg.exec(`INSERT INTO "User" ("id") VALUES (${OWNER_5}) ON CONFLICT DO NOTHING`);
        try {
          await place(OWNER_5, 100);
          await syncOwnerEventHats(OWNER_5, [], LIVE);
          await db.pg.exec(`UPDATE "User" SET ${change} WHERE id = ${OWNER_5}`);
          await syncOwnerEventHats(OWNER_5, [], LIVE);
          expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({});
          await db.pg.exec(
            `UPDATE "User" SET "bannedAt" = NULL, "deletedAt" = NULL, "excludeFromLeaderboards" = false WHERE id = ${OWNER_5}`
          );
          await syncOwnerEventHats(OWNER_5, [], LIVE);
          expect(log).toEqual([
            { k: 'Image:100', v: ownerHat(OWNER_5) },
            { k: 'Image:100', v: '' },
            { k: 'Image:100', v: ownerHat(OWNER_5) },
          ]);
        } finally {
          await db.pg.exec(`DELETE FROM "User" WHERE id = ${OWNER_5}`);
        }
      }
    );

    it('writes nothing, and reads nothing, with the kill switch off', async () => {
      await place(OWNER, 100);
      killSwitch.on = false;
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      await syncEventHats(LIVE);
      expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
      expect(redisMock.sysRedis.hDel).not.toHaveBeenCalled();
      expect(log).toEqual([]);
      expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
      expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
      expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
      expect(redisMock.sysRedis.hmGet).not.toHaveBeenCalled();
      expect(redisMock.sysRedis.hGetAll).not.toHaveBeenCalled();
      // Switched back on, the same calls write: the silence above is the switch.
      killSwitch.on = true;
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(log).toEqual([{ k: 'Image:100', v: ownerHat() }]);
    });

    it('writes nothing once the event’s points window has closed', async () => {
      await place(OWNER, 100);
      const AFTER = new Date(
        birthday2026.endDate.getTime() + birthday2026.scoring!.finalizeAfterMs + 1
      );
      await syncOwnerEventHats(OWNER, [image(100)], AFTER);
      expect(log).toEqual([]);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(log).toEqual([{ k: 'Image:100', v: ownerHat() }]);
    });

    it('follows a real equip and unequip through the placement trigger', async () => {
      await db.pg.exec(`
        INSERT INTO "Cosmetic" (id, type, data) VALUES
          (50, 'ContentDecoration', '{"event": "${birthday2026.name}", "team": "Blue"}');
        INSERT INTO "Image" (id, "userId") VALUES (600, ${OWNER});
        INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey") VALUES (${OWNER}, 50, 'claimed');
      `);
      try {
        await db.pg.exec(
          `UPDATE "UserCosmetic" SET "equippedToId" = 600, "equippedToType" = 'Image' WHERE "cosmeticId" = 50`
        );
        await syncOwnerEventHats(OWNER, [image(600)], LIVE);
        const hat = encodeHat({
          ownerId: OWNER,
          cosmeticId: 50,
          claimKey: 'claimed',
          team: 'Blue',
        });
        expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({ 'Image:600': hat });
        await db.pg.exec(
          `UPDATE "UserCosmetic" SET "equippedToId" = NULL, "equippedToType" = NULL WHERE "cosmeticId" = 50`
        );
        await syncOwnerEventHats(OWNER, [image(600)], LIVE);
        expect(log).toEqual([
          { k: 'Image:600', v: hat },
          { k: 'Image:600', v: '' },
        ]);
      } finally {
        await db.pg.exec(`
          DELETE FROM "UserCosmetic" WHERE "cosmeticId" = 50;
          DELETE FROM "Image" WHERE id = 600;
          DELETE FROM "Cosmetic" WHERE id = 50;
        `);
      }
    });

    it('a revoke takes every hat of every holder off', async () => {
      await place(OWNER, 100);
      await place(OWNER, 101, { cosmeticId: 8 });
      await place(OTHER, 102);
      await syncOwnerEventHats(OWNER, [], LIVE);
      await syncOwnerEventHats(OTHER, [], LIVE);
      expect([...hashes.get(keys.hats)!.keys()].sort()).toEqual([
        'Image:100',
        'Image:101',
        'Image:102',
      ]);
      await db.pg.exec(`UPDATE "EventCosmeticPlacement" SET "endedAt" = now()`);
      await syncOwnersEventHats([
        { userId: OWNER, entityType: 'Image', entityId: 100 },
        { userId: OWNER, entityType: 'Image', entityId: 101 },
        { userId: OTHER, entityType: 'Image', entityId: 102 },
      ]);
      expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({});
      expect(log.slice(3).map((e) => e.v)).toEqual(['', '', '']);
    });

    // Equip then a quick unequip: two passes for one owner. Unserialized, the older read could land
    // last and leave the hat on after it came off.
    it('serializes one owner’s passes so the older read never lands last', async () => {
      await place(OWNER, 100);
      const raw = pgliteRaw(db.pg);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let gated = false;
      dbMock.dbWrite.$queryRaw.mockImplementation((async (...args: unknown[]) => {
        const rows = await (raw.queryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
        if (!gated) {
          gated = true;
          await gate;
        }
        return rows;
      }) as never);
      const equip = syncOwnerEventHats(OWNER, [image(100)], LIVE);
      await vi.waitFor(() => expect(gated).toBe(true));
      await endPlacement(100);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      release();
      await equip;
      expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({});
      expect(log.at(-1)).toEqual({ k: 'Image:100', v: '' });
      // A crashed holder must not block the owner for good, nor its waiters' content outlive it.
      const sys = redisMock.sysRedis;
      for (const [key, , opts] of sys.set.mock.calls.filter(([key]) => key === lock.lock)) {
        expect(key).toBe(lock.lock);
        expect(opts).toEqual({ NX: true, PX: expect.any(Number) });
        expect(opts.PX).toBeGreaterThan(0);
      }
      expect(sys.pExpire).toHaveBeenCalledWith(lock.pending, expect.any(Number));
      expect(sys.pExpire.mock.calls[0][1]).toBeGreaterThan(0);
      const renewals = sys.eval.mock.calls.filter(([script]) => script.includes("'PEXPIRE'"));
      expect(renewals.length).toBeGreaterThan(0);
      for (const [, { arguments: args }] of renewals) expect(Number(args[1])).toBeGreaterThan(0);
    });

    it('gives up after a bounded number of passes, and says so', async () => {
      await place(OWNER, 100);
      // Someone keeps arriving while it runs; the fake stops after 50 so a missing bound fails, not hangs.
      let arrivals = 0;
      redisMock.sysRedis.sPop.mockImplementation(async () => (++arrivals <= 50 ? ['*'] : []));
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      const acquired = redisMock.sysRedis.set.mock.calls.filter(([key]) => key === lock.lock);
      expect(acquired).toHaveLength(HAT_SYNC_MAX_PASSES);
      expect(arrivals).toBeLessThan(50);
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ fn: 'runOwnerHatSync', ownerId: OWNER })
      );
      // What it took from the last arrival goes back for whoever runs next.
      expect([...(sets.get(lock.pending) ?? [])]).toEqual(['*']);
    });

    it('runs its pass anyway when it never gets the lock and the holder keeps letting go', async () => {
      await place(OWNER, 100);
      redisMock.sysRedis.set.mockResolvedValue(null);
      redisMock.sysRedis.exists.mockResolvedValue(0);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(redisMock.sysRedis.set).toHaveBeenCalledTimes(2 * HAT_SYNC_MAX_PASSES);
      expect(log).toEqual([{ k: 'Image:100', v: ownerHat() }]);
    });

    it('still writes when renewing the lock fails, and says so', async () => {
      await place(OWNER, 100);
      redisMock.sysRedis.eval.mockRejectedValueOnce(new Error('redis blip'));
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(log).toEqual([{ k: 'Image:100', v: ownerHat() }]);
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ fn: 'runOwnerHatSync.renew', ownerId: OWNER })
      );
    });

    // A pass that outlives the lock must neither write after losing it nor free the next holder's.
    it('stops writing, and leaves the new holder’s lock alone, when its lock expired mid-pass', async () => {
      await place(OWNER, 100);
      const raw = pgliteRaw(db.pg);
      dbMock.dbWrite.$queryRaw.mockImplementationOnce((async (...args: unknown[]) => {
        const rows = await (raw.queryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
        strings.set(lock.lock, 'another-holder');
        return rows;
      }) as never);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(strings.get(lock.lock)).toBe('another-holder');
      // It left its content for that holder.
      expect([...(sets.get(lock.pending) ?? [])]).toEqual(['*', 'Image:100']);
      expect(log).toEqual([]);
    });

    it('takes the lock itself when the holder let go before it could leave its content', async () => {
      await place(OWNER, 100);
      // The holder was there for the SET and gone by the EXISTS.
      redisMock.sysRedis.set.mockResolvedValueOnce(null);
      redisMock.sysRedis.exists.mockResolvedValueOnce(0);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(log).toEqual([{ k: 'Image:100', v: ownerHat() }]);
    });

    it('takes an owner’s hats off before the preview opens', async () => {
      await place(OWNER, 100);
      hashes.set(keys.hats, new Map([['Image:100', ownerHat()]]));
      await syncOwnerEventHats(
        OWNER,
        [image(100)],
        new Date(birthday2026.previewFrom!.getTime() - 1)
      );
      expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({});
      expect(log).toEqual([{ k: 'Image:100', v: '' }]);
    });

    it('still writes the hat when Redis cannot take the lock', async () => {
      await place(OWNER, 100);
      redisMock.sysRedis.set.mockRejectedValue(new Error('redis down'));
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(log).toEqual([{ k: 'Image:100', v: ownerHat() }]);
    });

    it('leaves another owner’s hat on touched content to the reconcile', async () => {
      hashes.set(keys.hats, new Map([['Image:100', ownerHat(OTHER)]]));
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);
      expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({ 'Image:100': ownerHat(OTHER) });
      expect(log).toEqual([]);
    });

    it('during the preview, writes the hat only for an owner the flag lets in', async () => {
      await place(OWNER, 100);
      await place(OTHER, 102);
      testerFlag.reset({ public: false, testers: [OTHER] });
      dbMock.dbWrite.user.findMany.mockImplementation((async ({
        where,
      }: {
        where: { id: { in: number[] } };
      }) => where.id.in.map((id) => ({ id, isModerator: false }))) as never);
      const PREVIEW = new Date(birthday2026.previewFrom!.getTime() + 24 * 60 * 60 * 1000);
      await syncOwnerEventHats(OWNER, [image(100)], PREVIEW);
      await syncOwnerEventHats(OTHER, [image(102)], PREVIEW);
      expect(Object.keys(Object.fromEntries(hashes.get(keys.hats)!))).toEqual(['Image:102']);
    });

    it('reaches an engine that is already running within the follow interval', async () => {
      let clock = LIVE.getTime();
      const engine = createEventPointsEngine({
        redis: redisMock.sysRedis as never,
        insertLedger: async () => undefined,
        loadScoredEvents: async () => [
          {
            name: birthday2026.name,
            startDate: birthday2026.startDate,
            endDate: birthday2026.endDate,
            scoring: birthday2026.scoring!,
          },
        ],
        now: () => new Date(clock),
        logError: () => undefined,
      });
      await engine.refresh();
      await place(OWNER, 100);
      await syncOwnerEventHats(OWNER, [image(100)], LIVE);

      clock += 1_999;
      engine.isHattedEntity('Image', 100);
      await new Promise((r) => setTimeout(r, 0));
      expect(engine.isHattedEntity('Image', 100)).toBe(false);

      clock += 1;
      engine.isHattedEntity('Image', 100);
      await new Promise((r) => setTimeout(r, 0));
      expect(engine.isHattedEntity('Image', 100)).toBe(true);
    });
  });

  describe('the hourly reconcile', () => {
    it('fixes a hat the write-through missed, and logs what it fixed', async () => {
      await place(OWNER, 100);
      hashes.set(keys.hats, new Map([['Image:999', ownerHat()]]));
      await syncEventHats(LIVE);
      expect(Object.fromEntries(hashes.get(keys.hats)!)).toEqual({ 'Image:100': ownerHat() });
      const fixes = () =>
        loggingMock.logToAxiom.mock.calls.filter(
          ([entry]) => (entry as { fn?: string }).fn === 'reconcileEventHats'
        );
      expect(fixes().map(([entry]) => entry)).toEqual([
        {
          type: 'warning',
          name: 'event-points',
          fn: 'reconcileEventHats',
          event: birthday2026.name,
          setCount: 1,
          removedCount: 1,
          set: ['Image:100'],
          removed: ['Image:999'],
        },
      ]);
      // In step: nothing to fix, nothing logged.
      await syncEventHats(LIVE);
      expect(fixes()).toHaveLength(1);
    });

    // The scan reads the replica; an unequip can land between that read and the reconcile's write.
    it('re-derives what it found on the primary, so a stale scan cannot put a hat back on', async () => {
      await place(OWNER, 100);
      const raw = pgliteRaw(db.pg);
      dbMock.dbRead.$queryRaw.mockImplementationOnce((async (...args: unknown[]) => {
        const rows = await (raw.queryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
        await endPlacement(100);
        return rows;
      }) as never);
      await syncEventHats(LIVE);
      expect(Object.fromEntries(hashes.get(keys.hats) ?? [])).toEqual({});
      expect(log).toEqual([]);
    });
  });
});

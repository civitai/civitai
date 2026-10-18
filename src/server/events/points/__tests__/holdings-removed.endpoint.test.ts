import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as Caches from '~/server/redis/caches';
import type * as RosterSync from '~/server/events/points/roster-sync';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * `/api/mod/cosmetic/holdings-removed`, which the moderator app calls after it deletes an equipped
 * cosmetic. The hat sync runs for real, against an in-process Postgres with the placement trigger, so
 * the deletes below end placements the way the moderator's do.
 */

vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => true,
  isEventPointsEnabledSync: () => true,
  onEventPointsSwitchOn: () => () => undefined,
}));
vi.mock('~/server/events/points/self-heal', () => ({ healEventPoints: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});
vi.mock('~/server/utils/moderator-endpoint', () => ({
  defineModeratorEndpoint: (_name: string, def: unknown) => def,
  moderatorBoolean: z.boolean(),
}));
const entityCaches = vi.hoisted(() => ({
  frame: {} as Record<string, { refresh: ReturnType<typeof vi.fn> }>,
  event: {} as Record<string, { refresh: ReturnType<typeof vi.fn> }>,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  cosmeticEntityCaches: entityCaches.frame,
  eventDecorationEntityCaches: entityCaches.event,
  refreshOwnedStickerCache: vi.fn(),
  userCosmeticCache,
}));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  articlesSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));
const roster = vi.hoisted(() => ({ syncMembers: vi.fn(async () => undefined) }));
vi.mock('~/server/events/points/roster-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof RosterSync>()),
  syncEventRosterMembers: roster.syncMembers,
}));
const { testerFlag } = await import('~/test-utils/testerFlagFake');

type Removed = {
  userId: number;
  cosmeticId: number;
  equippedToId: number;
  equippedToType: string;
};
type Handler = {
  input: z.ZodType;
  handler: (input: { removed: Removed[] }) => Promise<unknown>;
};
const endpoint = (await import('~/pages/api/mod/cosmetic/holdings-removed'))
  .default as unknown as Handler;
const { syncOwnerEventHats } = await import('~/server/events/points/sync');
const { eventPointKeys } = await import('~/server/events/points/keys');
const { birthday2026 } = await import('~/server/events/birthday2026.event');

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261012130000_event_cosmetic_placement/migration.sql'
);
const db = { pg: null as unknown as PGlite };
const OWNER = 1;
const HAT = 7;
const IMAGE = 100;
const userCosmeticCache = vi.hoisted(() => ({ refresh: vi.fn() }));
const LIVE = new Date('2026-11-05T12:00:00.000Z');
const HAT_DATA = { type: 'hat', event: birthday2026.name, url: 'hat.png', team: 'Blue' };
const keys = eventPointKeys(birthday2026.name);

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
    INSERT INTO "User" ("id") VALUES (${OWNER});
    INSERT INTO "Image" ("id", "userId") VALUES (${IMAGE}, ${OWNER});
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
  await db.pg.query(
    `INSERT INTO "Cosmetic" ("id", "type", "data") VALUES ($1, 'ContentDecoration', $2)`,
    [HAT, JSON.stringify(HAT_DATA)]
  );
});

afterAll(async () => {
  await db.pg.close();
});

const hashes = new Map<string, Map<string, string>>();
const hats = () => Object.fromEntries(hashes.get(keys.hats) ?? []);

beforeEach(async () => {
  await db.pg.exec(`TRUNCATE "EventCosmeticPlacement"; TRUNCATE "UserCosmetic"`);
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LIVE);
  testerFlag.reset({ public: true });
  for (const entity of ['Model', 'Image', 'Article', 'Post', 'Model3D']) {
    entityCaches.frame[entity] = { refresh: vi.fn() };
    entityCaches.event[entity] = { refresh: vi.fn() };
  }
  const raw = pgliteRaw(db.pg);
  dbMock.dbRead.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.cosmetic.findMany.mockImplementation(
    (async ({ where }: { where: { id: { in: number[] } } }) =>
      (
        await db.pg.query<{ id: number; data: unknown }>(
          `SELECT "id", "data" FROM "Cosmetic" WHERE "id" = ANY($1)`,
          [where.id.in]
        )
      ).rows) as never
  );

  // The live hat map and the owner lock, as sync.behavior.test.ts fakes them.
  hashes.clear();
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const sys = redisMock.sysRedis;
  const hash = (key: string) => {
    const h = hashes.get(key) ?? new Map<string, string>();
    hashes.set(key, h);
    return h;
  };
  sys.hSet.mockImplementation(async (key: string, field: string, value: string) => {
    hash(key).set(field, value);
    return 1;
  });
  sys.hDel.mockImplementation(async (key: string, field: string) =>
    Number(hash(key).delete(field))
  );
  sys.hmGet.mockImplementation(async (key: string, fields: string[]) =>
    fields.map((field) => hashes.get(key)?.get(field) ?? null)
  );
  sys.xAdd.mockResolvedValue('1-0');
  sys.xTrim.mockResolvedValue(0);
  sys.set.mockImplementation(async (key: string, value: string, opts?: { NX?: boolean }) => {
    if (opts?.NX && strings.has(key)) return null;
    strings.set(key, value);
    return 'OK';
  });
  sys.exists.mockImplementation(async (key: string) => Number(strings.has(key)));
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

  await db.pg.query(
    `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "equippedToId", "equippedToType")
     VALUES ($1, $2, 'box-open-77', $3, 'Image')`,
    [OWNER, HAT, IMAGE]
  );
  // The trigger stamps the placement with the database's clock; move it inside the event.
  await db.pg.exec(`UPDATE "EventCosmeticPlacement" SET "startedAt" = '2026-11-02T00:00:00Z'`);
  await syncOwnerEventHats(OWNER, [{ entityType: 'Image', entityId: IMAGE }], LIVE);
});

afterEach(() => vi.useRealTimers());

const takeBack = () =>
  db.pg.query(`DELETE FROM "UserCosmetic" WHERE "userId" = $1 AND "claimKey" = 'box-open-77'`, [
    OWNER,
  ]);
// The body the moderator app sends (its shop-refund.pglite.test.ts asserts the same shape), through
// the endpoint's own schema.
const report = () =>
  endpoint.handler(
    endpoint.input.parse({
      removed: [{ userId: OWNER, cosmeticId: HAT, equippedToId: IMAGE, equippedToType: 'Image' }],
    }) as { removed: Removed[] }
  );

describe('holdings-removed', () => {
  it('takes a hat the moderator took back off the live map, and refreshes the image', async () => {
    expect(Object.keys(hats())).toEqual([`Image:${IMAGE}`]);
    await takeBack();

    await report();

    expect(hats()).toEqual({});
    expect(entityCaches.frame.Image.refresh).toHaveBeenCalledWith([IMAGE]);
    expect(entityCaches.event.Image.refresh).toHaveBeenCalledWith([IMAGE]);
    expect(roster.syncMembers).toHaveBeenCalledWith([OWNER], { onlyIfListed: true });
    expect(userCosmeticCache.refresh).toHaveBeenCalledWith([OWNER]);
  });

  it('refuses a body that is not the moderator app’s shape', () => {
    expect(() =>
      endpoint.input.parse({
        removed: [{ userId: OWNER, cosmeticId: HAT, equippedToId: IMAGE, equippedToType: 'Post ' }],
      })
    ).toThrow();
    expect(() => endpoint.input.parse({ removed: [] })).toThrow();
  });

  it('without the call, the taken-back hat stays on the map (control)', async () => {
    await takeBack();
    expect(Object.keys(hats())).toEqual([`Image:${IMAGE}`]);
  });

  it('leaves a hat that is still held and equipped on the map, whatever the caller says', async () => {
    const before = hats();

    await report();

    expect(hats()).toEqual(before);
    expect(Object.keys(before)).toEqual([`Image:${IMAGE}`]);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The hat sync decides whose hats can earn at all: its query runs here on an in-process Postgres
 * with the committed placement migration, and its output (hash + change log) is fed to a real
 * engine, the seam the engine and hook suites each fake.
 */

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});
const { testerFlag } = await import('~/test-utils/testerFlagFake');

const { desiredEventHats, syncEventHats } = await import('~/server/events/points/sync');
const { createEventPointsEngine } = await import('~/server/events/points/award');
const { eventPointKeys } = await import('~/server/events/points/keys');
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
  extra: { owner?: number; ended?: boolean; startedAt?: string; cosmeticId?: number } = {}
) =>
  db.pg.query(
    `INSERT INTO "EventCosmeticPlacement"
       (event, "userId", "cosmeticId", "claimKey", team, "entityType", "entityId", "entityOwnerId",
        "startedAt", "endedAt")
     VALUES ($1, $2, $3, 'claimed', 'Blue', 'Image', $4, $5, $6::timestamptz,
             CASE WHEN $7 THEN now() ELSE NULL END)`,
    [
      EVENT.name,
      userId,
      extra.cosmeticId ?? 7,
      entityId,
      extra.owner ?? userId,
      extra.startedAt ?? '2026-11-02T00:00:00Z',
      !!extra.ended,
    ]
  );

beforeEach(async () => {
  await db.pg.exec(`TRUNCATE "EventCosmeticPlacement"`);
  vi.clearAllMocks();
  const raw = pgliteRaw(db.pg);
  dbMock.dbRead.$queryRaw.mockImplementation(raw.queryRaw as never);
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
    sys.xRange.mockResolvedValue([]);
    testerFlag.reset({ public: true });
  });

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
});

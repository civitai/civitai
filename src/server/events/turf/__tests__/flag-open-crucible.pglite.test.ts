import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * The home Flag Race row's "Enter the race" button and the flags collection's page, against real
 * rows: the open flag Crucible is the Active one tagged for the event whose window holds now, and a
 * Collection is the event's flags collection only while the race is on. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const EVENT = { name: 'e' };
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
vi.mock('~/server/services/home-block-cache.service', () => ({
  homeBlockCacheBust: async () => undefined,
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: async () => false,
  ensureFliptInitialized: async () => undefined,
  getFliptClientSync: () => null,
}));

const { getOpenFlagCrucible, getFlagRaceEventForCollection } = await import(
  '~/server/events/turf/turf.service'
);
const { flagRaceConfigKey } = await import('~/server/events/scoring/award-results');

const HOME = 77;
const FLAGS = {
  on: true,
  homeCollectionId: HOME,
  size: 10,
  pot: { steps: [{ from: '2026-11-01T00:00:00Z', perPerson: 1, upTo: 1, after: 1 }], cap: 10 },
};
// Mid-day: the open daily runs from 22:00Z yesterday to 22:00Z today.
const NOW = new Date('2026-11-17T12:00:00Z');
const DAY_START = new Date('2026-11-16T22:00:00Z');
const DAY_END = new Date('2026-11-17T22:00:00Z');
const PREV_START = new Date('2026-11-15T22:00:00Z');
const NEXT_END = new Date('2026-11-18T22:00:00Z');

let db: PGlite;
let config: object | null;

async function crucible(id: number, status: string, tags: string[], startAt: Date, endAt: Date) {
  await db.query(`INSERT INTO "Crucible" VALUES ($1, $2::"CrucibleStatus", $3, $4, $5)`, [
    id,
    status,
    startAt,
    endAt,
    tags,
  ]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "Crucible" (
      id int PRIMARY KEY, status "CrucibleStatus", "startAt" timestamptz, "endAt" timestamptz,
      "eventTags" text[], "imageId" int
    );
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamptz, availability text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, url text, "nsfwLevel" int, ingestion text DEFAULT 'Scanned',
      "tosViolation" boolean DEFAULT false, "needsReview" text, "blockedFor" text
    );
    INSERT INTO "Post" VALUES (1, '2026-10-01', 'Public');
  `);
});
afterAll(async () => db.close());

beforeEach(async () => {
  config = { flags: FLAGS };
  await db.exec(`DELETE FROM "Crucible"; DELETE FROM "Image"`);
  const raw = pgliteRaw(db);
  for (const client of [dbMock.dbRead, dbMock.dbWrite])
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
  redisMock.sysRedis.get.mockImplementation((async (key: string) =>
    key === flagRaceConfigKey('e') && config ? JSON.stringify(config) : null) as never);
});

describe('the open flag Crucible', () => {
  it('is the Active one tagged for the event, not a finished, cancelled, upcoming or untagged one', async () => {
    await crucible(10, 'Completed', ['e-flag'], PREV_START, DAY_START);
    await crucible(11, 'Active', ['other', 'e-flag'], DAY_START, DAY_END);
    await crucible(12, 'Pending', ['e-flag'], DAY_END, NEXT_END);
    // The rest end sooner, so each would sort first if its filter were missing.
    await crucible(13, 'Active', ['e'], DAY_START, new Date(DAY_END.getTime() - 2));
    await crucible(14, 'Active', ['x-flag'], DAY_START, new Date(DAY_END.getTime() - 3));
    await crucible(15, 'Cancelled', ['e-flag'], DAY_START, new Date(DAY_END.getTime() - 1));
    expect(await getOpenFlagCrucible('e', NOW)).toEqual({ id: 11, endAt: DAY_END, coverUrl: null });
  });

  it('carries its cover only while the cover is visible and PG or PG-13', async () => {
    await db.exec(
      `INSERT INTO "Image" (id, "postId", url, "nsfwLevel") VALUES (50, 1, 'cover', 1)`
    );
    await crucible(11, 'Active', ['e-flag'], DAY_START, DAY_END);
    await db.exec(`UPDATE "Crucible" SET "imageId" = 50`);
    const cover = async () => (await getOpenFlagCrucible('e', NOW))?.coverUrl;
    expect(await cover()).toBe('cover');
    await db.exec(`UPDATE "Image" SET "needsReview" = 'poi'`);
    expect(await cover()).toBeNull();
    await db.exec(`UPDATE "Image" SET "needsReview" = NULL, "nsfwLevel" = 4`);
    expect(await cover()).toBeNull();
  });

  it('is gone once its window ends, before the next one is Active', async () => {
    await crucible(11, 'Active', ['e-flag'], DAY_START, DAY_END);
    expect(await getOpenFlagCrucible('e', DAY_END)).toBeNull();
  });

  it('is none while the race is off', async () => {
    await crucible(11, 'Active', ['e-flag'], DAY_START, DAY_END);
    config = { flags: { ...FLAGS, on: false } };
    expect(await getOpenFlagCrucible('e', NOW)).toBeNull();
  });
});

describe("the event's flags collection", () => {
  it('is the Collection the race shows, and only while the race is on', async () => {
    expect(await getFlagRaceEventForCollection(HOME)).toBe('e');
    expect(await getFlagRaceEventForCollection(HOME + 1)).toBeNull();
    config = { flags: { ...FLAGS, on: false } };
    expect(await getFlagRaceEventForCollection(HOME)).toBeNull();
  });
});

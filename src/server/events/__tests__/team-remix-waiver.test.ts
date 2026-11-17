import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as EventAccess from '~/server/events/event-access';
import type { EventAccess as Access } from '~/server/events/event-access';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The waiver's two reads, executed as written against an in-process Postgres carrying the placement
 * trigger: a hat is placed and taken off by equipping and unequipping it, so `endedAt` and
 * `entityOwnerId` are the trigger's, not the fixture's.
 */

const EVENT = 'party';
const PLACER = 7;
const OWNER = 8;
const STRANGER = 9;
const HOST = 900;

const def = {
  name: EVENT,
  startDate: new Date('2026-11-01T00:00:00Z'),
  endDate: new Date('2026-12-01T00:00:00Z'),
  join: { claimKey: 'claimed', design: 'basic' },
  scoring: { teamRemixWaiver: { perPlacerPerDay: 10 } },
};
const events = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => events.list }));

const access = vi.hoisted(() => ({ value: 'open' as Access }));
vi.mock('~/server/events/event-access', async (importOriginal) => ({
  ...(await importOriginal<typeof EventAccess>()),
  getEventAccess: async () => access.value,
}));

const { findTeamRemixWaiver } = await import('~/server/events/team-remix-waiver');

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261012130000_event_cosmetic_placement/migration.sql'
);
const pg = new PGlite();

// Join cosmetics are this event's `basic` design; the placed hat is a shop design, so holding it is
// not joining.
const JOIN = { Pink: 1, Blue: 2 } as const;
const OTHER_EVENT_JOIN = 3;
const BADGE_LOOKALIKE = 4;
const SHOP_HAT = 10;
const OTHER_EVENT_HAT = 11;

beforeAll(async () => {
  await pg.exec(`
    CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'ContentDecoration');
    CREATE TABLE "Cosmetic" ("id" integer PRIMARY KEY, "type" "CosmeticType" NOT NULL, "data" jsonb);
    CREATE TABLE "UserCosmetic" (
      "userId" integer NOT NULL, "cosmeticId" integer NOT NULL, "claimKey" text NOT NULL,
      "obtainedAt" timestamp(3) NOT NULL DEFAULT now(), "equippedAt" timestamp(3), "data" jsonb,
      "equippedToId" integer, "equippedToType" "CosmeticEntity",
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Article" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
  `);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(pg).queryRaw as never);
});

afterAll(async () => {
  await pg.close();
});

const cosmetic = (id: number, type: string, data: Record<string, string>) =>
  pg.query(`INSERT INTO "Cosmetic" VALUES ($1, $2, $3)`, [id, type, JSON.stringify(data)]);

async function hold(userId: number, cosmeticId: number, claimKey = 'claimed') {
  await pg.query(
    `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey") VALUES ($1, $2, $3)`,
    [userId, cosmeticId, claimKey]
  );
}

/** Equips the hat; the placement trigger opens the interval and records the entity's owner. */
async function place(userId: number, cosmeticId: number, entityId = HOST, entityType = 'Image') {
  const claimKey = `bought-${cosmeticId}`;
  await hold(userId, cosmeticId, claimKey);
  await pg.query(
    `UPDATE "UserCosmetic" SET "equippedToId" = $1, "equippedToType" = $2
     WHERE "userId" = $3 AND "cosmeticId" = $4 AND "claimKey" = $5`,
    [entityId, entityType, userId, cosmeticId, claimKey]
  );
  return claimKey;
}

const find = () => findTeamRemixWaiver({ placerId: PLACER, ownerId: OWNER, hostImageId: HOST });

beforeEach(async () => {
  vi.clearAllMocks();
  events.list = [def];
  access.value = 'open';
  await pg.exec(
    `TRUNCATE "UserCosmetic", "Cosmetic", "Image", "Model", "Article", "EventCosmeticPlacement";`
  );
  await cosmetic(JOIN.Pink, 'ContentDecoration', { event: EVENT, design: 'basic', team: 'Pink' });
  await cosmetic(JOIN.Blue, 'ContentDecoration', { event: EVENT, design: 'basic', team: 'Blue' });
  await cosmetic(OTHER_EVENT_JOIN, 'ContentDecoration', {
    event: 'another',
    design: 'basic',
    team: 'Pink',
  });
  await cosmetic(BADGE_LOOKALIKE, 'Badge', { event: EVENT, design: 'basic', team: 'Pink' });
  await cosmetic(SHOP_HAT, 'ContentDecoration', { event: EVENT, design: 'crown', team: 'Pink' });
  await cosmetic(OTHER_EVENT_HAT, 'ContentDecoration', { event: 'another', team: 'Pink' });
  await pg.query(`INSERT INTO "Image" VALUES ($1, $2), ($3, $4)`, [HOST, OWNER, HOST + 1, OWNER]);
});

/** The waiving setup, short one piece: both joined Pink, the owner's hat on their own host image. */
async function teammates({ hat = true } = {}) {
  await hold(PLACER, JOIN.Pink);
  await hold(OWNER, JOIN.Pink);
  if (hat) await place(OWNER, SHOP_HAT);
}

describe('findTeamRemixWaiver', () => {
  it('waives for two members of the same team on a hatted image', async () => {
    await teammates();
    await expect(find()).resolves.toEqual({ event: EVENT, team: 'Pink', perDay: 10 });
  });

  describe('the hat', () => {
    it('refuses a host image with no hat', async () => {
      await teammates({ hat: false });
      await expect(find()).resolves.toBeNull();
    });

    it('refuses a hat that was taken off', async () => {
      await teammates({ hat: false });
      const claimKey = await place(OWNER, SHOP_HAT);
      await pg.query(
        `UPDATE "UserCosmetic" SET "equippedToId" = NULL, "equippedToType" = NULL
         WHERE "userId" = $1 AND "claimKey" = $2`,
        [OWNER, claimKey]
      );
      await expect(find()).resolves.toBeNull();
    });

    it('refuses a hat on another image', async () => {
      await teammates({ hat: false });
      await place(OWNER, SHOP_HAT, HOST + 1);
      await expect(find()).resolves.toBeNull();
    });

    it('refuses a hat on a model that shares the image id', async () => {
      await teammates({ hat: false });
      await pg.query(`INSERT INTO "Model" VALUES ($1, $2)`, [HOST, OWNER]);
      await place(OWNER, SHOP_HAT, HOST, 'Model');
      await expect(find()).resolves.toBeNull();
    });

    it("refuses another event's hat", async () => {
      await teammates({ hat: false });
      await place(OWNER, OTHER_EVENT_HAT);
      await expect(find()).resolves.toBeNull();
    });

    it("refuses a hat someone else put on the owner's image", async () => {
      await teammates({ hat: false });
      await place(PLACER, SHOP_HAT);
      await expect(find()).resolves.toBeNull();
    });

    it("refuses the owner's hat on an image that is not theirs", async () => {
      await teammates({ hat: false });
      await pg.query(`UPDATE "Image" SET "userId" = $1 WHERE id = $2`, [STRANGER, HOST]);
      await place(OWNER, SHOP_HAT);
      await expect(find()).resolves.toBeNull();
    });
  });

  describe('the team', () => {
    it('refuses teammates on different teams', async () => {
      await hold(PLACER, JOIN.Blue);
      await hold(OWNER, JOIN.Pink);
      await place(OWNER, SHOP_HAT);
      await expect(find()).resolves.toBeNull();
    });

    it.each([
      ['the placer', OWNER],
      ['the owner', PLACER],
    ])('refuses when %s has not joined', async (_who, joinedId) => {
      // A team is computed for everyone; only a held join cosmetic is joining.
      await hold(joinedId, JOIN.Pink);
      await place(OWNER, SHOP_HAT);
      await expect(find()).resolves.toBeNull();
    });

    it.each([
      ['a join cosmetic held under another claim key', JOIN.Pink, 'gift'],
      ["another event's join cosmetic", OTHER_EVENT_JOIN, 'claimed'],
      ['a shop design of the same team', SHOP_HAT, 'claimed'],
      ['a badge with the join data', BADGE_LOOKALIKE, 'claimed'],
    ])('refuses a placer holding %s', async (_what, cosmeticId, claimKey) => {
      await hold(PLACER, cosmeticId, claimKey);
      await hold(OWNER, JOIN.Pink);
      await place(OWNER, SHOP_HAT);
      await expect(find()).resolves.toBeNull();
    });
  });

  it.each(['closed', 'ended'] as const)('refuses while the event is %s', async (state) => {
    await teammates();
    access.value = state;
    await expect(find()).resolves.toBeNull();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses for an event with no waiver configured', async () => {
    await teammates();
    events.list = [{ ...def, scoring: {} }];
    await expect(find()).resolves.toBeNull();
  });

  it('refuses a submission to your own image', async () => {
    await teammates();
    await expect(
      findTeamRemixWaiver({ placerId: OWNER, ownerId: OWNER, hostImageId: HOST })
    ).resolves.toBeNull();
  });
});

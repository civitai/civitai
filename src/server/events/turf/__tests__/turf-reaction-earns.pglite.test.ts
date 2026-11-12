import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as TurfWatch from '~/server/events/turf/turf-watch';
import type * as PointsEnabled from '~/server/events/points/enabled';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { eventPointKeys } from '~/server/events/points/keys';
import { turfKeys } from '~/server/events/turf/turf-map';

/**
 * After a placement, reactionEarns answers whether the placer reacting there would pay their team,
 * which is what the reaction nudge shows on. The reactor never earns (points/award.ts awardTurf), so a nudge on an
 * image where they are the only credited teammate, or another team leads, would ask for a reaction
 * that pays them nothing or pays the other side. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const START = new Date('2026-11-01T00:00:00Z');
const NOW = new Date('2026-11-07T12:00:00Z');
const EVENT = {
  name: 'e',
  startDate: START,
  endDate: new Date('2099-12-01T00:00:00Z'),
  teams: ['Blue', 'Pink'],
  scoring: {
    finalizeAfterMs: 0,
    types: { reaction: { weight: 5, once: 'event', entities: ['Image', 'Article'] } },
  },
  turf: {
    mode: 'live' as 'live' | 'shadow',
    testerFlag: 'e-turf',
    supply: [{ from: START, perHour: 5, cap: 50 }],
    creditedPlayers: [{ from: START, players: 25 }],
    renderLimit: 12,
    mapMaxEntries: 10,
  },
  getUserTeam: vi.fn(async () => 'Blue'),
  getTeamCosmetic: async () => 11,
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
vi.mock('~/server/events/turf/turf-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfWatch>()),
  pushTurfCounts: async () => 0,
}));
vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace: async () => undefined,
}));
// Everyone is a shadow tester unless a case says otherwise.
const testers = vi.hoisted(() => ({ only: null as number[] | null }));
vi.mock('~/server/events/event-access', () => ({
  flagAudienceAmong: async (_flag: string, ids: number[]) => new Set(testers.only ?? ids),
}));
const pointsOn = vi.hoisted(() => ({ value: true }));
vi.mock('~/server/events/points/enabled', async (importOriginal) => ({
  ...(await importOriginal<typeof PointsEnabled>()),
  isEventPointsEnabled: async () => pointsOn.value,
}));

const { placeTurfSticker, getReactionEarns, REACTION_EARNS_MS } = await import(
  '~/server/events/turf/turf.service'
);

const OWNER = 7;
const PLACER = 5;
const TEAMMATE = 6;
const PINK = 8;
const NEW_ACCOUNT_TEAMMATE = 9;
let nextImage = 1000;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, settings jsonb, "bannedAt" timestamptz, "deletedAt" timestamptz,
      "createdAt" timestamptz DEFAULT '2020-01-01', meta jsonb,
      "excludeFromLeaderboards" boolean DEFAULT false, flags int NOT NULL DEFAULT 0
    );
    CREATE TABLE "CreatorMilestone" (key text PRIMARY KEY, threshold numeric);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamptz, availability text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, "postId" int, ingestion text DEFAULT 'Scanned',
      "tosViolation" boolean DEFAULT false, "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "Collection" (id int PRIMARY KEY, mode text);
    CREATE TABLE "CollectionItem" (id serial PRIMARY KEY, "collectionId" int, "imageId" int);
    -- contestEntry also reads running flag Crucibles.
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "Crucible" (id int PRIMARY KEY, status "CrucibleStatus", "eventTags" text[]);
    CREATE TABLE "CrucibleEntry" (id serial PRIMARY KEY, "crucibleId" int, "imageId" int);
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int);
    CREATE TABLE "EventTurfStock" (
      event text, "userId" int, stock int, "refilledAt" timestamptz, PRIMARY KEY (event, "userId")
    );
    CREATE TABLE "EventTurfSticker" (
      id bigserial PRIMARY KEY, event text, "imageId" int, "userId" int, team text,
      "cosmeticId" int, data jsonb, "createdAt" timestamptz DEFAULT now(), "removedAt" timestamptz
    );

    INSERT INTO "User" (id, settings, "createdAt") VALUES
      (${OWNER}, '{"eventTurfOptIn": {"e": "true"}}', '2020-01-01'),
      (${PLACER}, '{"eventTurfOptIn": {"e": "true"}}', '2020-01-01'),
      (${TEAMMATE}, '{"eventTurfOptIn": {"e": "true"}}', '2020-01-01'),
      (${PINK}, '{"eventTurfOptIn": {"e": "true"}}', '2020-01-01'),
      (${NEW_ACCOUNT_TEAMMATE}, '{"eventTurfOptIn": {"e": "true"}}', '2026-11-05');
    INSERT INTO "CreatorMilestone" VALUES ('turf-score-tier', 1000000);
    INSERT INTO "Post" VALUES (1, '2026-10-01', 'Public');
    INSERT INTO "Cosmetic" VALUES
      (11, 'ContentDecoration', '{"event": "e", "team": "Blue"}'),
      (12, 'ContentDecoration', '{"event": "e", "team": "Pink"}');
    INSERT INTO "UserCosmetic" VALUES (${PLACER}, 11);
  `);
});
afterAll(async () => db.close());

let hats: Record<string, string> = {};
let lua: LuaRedis;
beforeEach(() => {
  EVENT.turf.mode = 'live';
  pointsOn.value = true;
  testers.only = null;
  hats = {};
  const raw = pgliteRaw(db);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  // The placement's own sticker lands in the table, so the read after it sees it.
  dbMock.dbWrite.eventTurfSticker.create.mockImplementation((async ({
    data,
  }: {
    data: { imageId: number; userId: number; team: string; cosmeticId: number; createdAt: Date };
  }) => {
    await db.query(
      `INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data, "createdAt")
       VALUES ('e', $1, $2, $3, $4, '{}', $5)`,
      [data.imageId, data.userId, data.team, data.cosmeticId, data.createdAt]
    );
    return {};
  }) as never);
  redisMock.sysRedis.get.mockResolvedValue(null as never);
  // The placement's sync writes the turf map through its Lua script; the answer reads it back.
  lua = createLuaRedis(0);
  let ticket = 0;
  redisMock.sysRedis.eval.mockImplementation(lua.eval as never);
  redisMock.sysRedis.incr.mockImplementation((async () => ++ticket) as never);
  redisMock.sysRedis.hGetAll.mockResolvedValue({} as never);
  redisMock.sysRedis.hGet.mockImplementation((async (key: string, field: string) => {
    if (key === eventPointKeys('e').hats) return hats[field] ?? null;
    if (key === turfKeys('e').map) return lua.hash(key)?.[field] ?? null;
    throw new Error(`unexpected hGet ${key}`);
  }) as never);
});

/** A fresh image with these earlier stickers on it, oldest first. */
async function image(earlier: [userId: number, team: string][] = []) {
  const id = nextImage++;
  await db.query(`INSERT INTO "Image" (id, "userId", "postId") VALUES ($1, $2, 1)`, [id, OWNER]);
  for (const [i, [userId, team]] of earlier.entries())
    await db.query(
      `INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data, "createdAt")
       VALUES ('e', $1, $2, $3, 11, '{}', $4)`,
      [id, userId, team, new Date(START.getTime() + (i + 1) * 60_000)]
    );
  return id;
}

const place = (imageId: number) =>
  placeTurfSticker(
    {
      event: 'e',
      userId: PLACER,
      imageId,
      cosmeticId: 11,
      data: { x: 0.5, y: 0.5, scale: 1, rotation: 0, flip: false },
    },
    NOW
  );
const ask = (imageId: number, deadlineMs = 30_000) =>
  // These cases test the answer, not the deadline: only the hung-read case runs on the real one.
  getReactionEarns({ event: 'e', userId: PLACER, imageId }, NOW, { deadlineMs });
/** Places, then asks, as the client does: the ask waits for the placement's own sync. */
const placeAndAsk = async (imageId: number) => {
  await place(imageId);
  return ask(imageId);
};

describe('reactionEarns answers whether a reaction there would pay your team', () => {
  it('yes: your team leads and a teammate besides you is credited', async () => {
    loggingMock.logToAxiom.mockClear();
    const earns = await placeAndAsk(await image([[TEAMMATE, 'Blue']]));
    // A swallowed error reads as itself rather than as a bare `false`.
    expect(loggingMock.logToAxiom.mock.calls).toEqual([]);
    expect(lua.errors).toEqual([]);
    expect(earns).toBe(true);
  });

  it('no: you are the only credited player, and the award never pays the reactor', async () => {
    expect(await placeAndAsk(await image())).toBe(false);
  });

  it('no: the other team still leads, so a reaction would pay them', async () => {
    const id = await image([
      [PINK, 'Pink'],
      [OWNER, 'Pink'],
      [TEAMMATE, 'Blue'],
    ]);
    expect(await placeAndAsk(id)).toBe(false);
  });

  it('no: the only teammate besides you is a new account, which is never credited', async () => {
    expect(await placeAndAsk(await image([[NEW_ACCOUNT_TEAMMATE, 'Blue']]))).toBe(false);
  });

  it("a worn hat decides instead: your team's hat on someone else pays, yours or Pink's does not", async () => {
    const hat = (ownerId: number, team: string) =>
      JSON.stringify({ ownerId, cosmeticId: 11, claimKey: 'k', team });
    const teammateHat = await image();
    hats[`Image:${teammateHat}`] = hat(TEAMMATE, 'Blue');
    expect(await placeAndAsk(teammateHat)).toBe(true);
    const ownHat = await image([[TEAMMATE, 'Blue']]);
    hats[`Image:${ownHat}`] = hat(PLACER, 'Blue');
    expect(await placeAndAsk(ownHat)).toBe(false);
    const pinkHat = await image([[TEAMMATE, 'Blue']]);
    hats[`Image:${pinkHat}`] = hat(PINK, 'Pink');
    expect(await placeAndAsk(pinkHat)).toBe(false);
  });

  it('no: shadow turf moves no live points, and nothing earns with event points switched off', async () => {
    EVENT.turf.mode = 'shadow';
    expect(await placeAndAsk(await image([[TEAMMATE, 'Blue']]))).toBe(false);
    EVENT.turf.mode = 'live';
    pointsOn.value = false;
    expect(await placeAndAsk(await image([[TEAMMATE, 'Blue']]))).toBe(false);
  });

  it('shadow turf answers only its testers, even where a hat would pay', async () => {
    const id = await image();
    await place(id);
    hats[`Image:${id}`] = JSON.stringify({
      ownerId: TEAMMATE,
      cosmeticId: 11,
      claimKey: 'k',
      team: 'Blue',
    });
    EVENT.turf.mode = 'shadow';
    expect(await ask(id)).toBe(true);
    testers.only = [];
    expect(await ask(id)).toBe(false);
  });

  // Until a sync writes the map, a reaction scores on the old one: the answer must read the map.
  it('no: the stickers say your team leads, but the map does not (its sync failed)', async () => {
    redisMock.sysRedis.eval.mockRejectedValue(new Error('sysRedis down') as never);
    expect(await placeAndAsk(await image([[TEAMMATE, 'Blue']]))).toBe(false);
  });

  // The placement never waits on the answer: it is the nudge's own ask, made later.
  it('placing returns without reading the answer, even with every read hung', async () => {
    redisMock.sysRedis.hGet.mockImplementation((() => new Promise(() => undefined)) as never);
    const waited = new Promise((resolve) => setTimeout(() => resolve('placement waited'), 1_000));
    expect(await Promise.race([place(await image([[TEAMMATE, 'Blue']])), waited])).toBeUndefined();
  });

  // The sys client has no socket timeout, so a read on a half-open connection can hang for minutes.
  it('a hung read answers no at the deadline', async () => {
    const id = await image([[TEAMMATE, 'Blue']]);
    await place(id);
    redisMock.sysRedis.hGet.mockImplementationOnce((() => new Promise(() => undefined)) as never);
    const waited = new Promise((resolve) =>
      setTimeout(() => resolve('ask still waiting'), REACTION_EARNS_MS + 8_000)
    );
    expect(await Promise.race([ask(id, REACTION_EARNS_MS), waited])).toBe(false);
  });

  it('a failed read answers no', async () => {
    const id = await image([[TEAMMATE, 'Blue']]);
    await place(id);
    redisMock.sysRedis.hGet.mockRejectedValueOnce(new Error('sysRedis down') as never);
    expect(await ask(id)).toBe(false);
  });
});

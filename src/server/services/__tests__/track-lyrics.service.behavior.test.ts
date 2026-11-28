import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as UserPreferences from '~/server/services/user-preferences.service';

/**
 * `getSongLyrics` against an in-process Postgres: the song detail view's lyrics follow the song's
 * own visibility, and wait for the song's review (which includes the lyrics text verdict).
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const actual = await importOriginal<typeof UserPreferences>();
  return {
    ...actual,
    BlockedByUsers: { ...actual.BlockedByUsers, getCached: vi.fn(async () => []) },
  };
});

import { getSongLyrics } from '~/server/services/track-lyrics.service';

const OWNER = 10;
const VIEWER = 20;

const SCHEMA = `
  CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
  CREATE TABLE "Image" ( type "MediaType" NOT NULL DEFAULT 'audio',
    id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
    "needsReview" text, "blockedFor" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
    "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}', "scanJobs" jsonb,
    "acceptableMinor" boolean NOT NULL DEFAULT false, minor boolean,
    "modelRestricted" boolean NOT NULL DEFAULT false
  );
  CREATE TABLE "TrackLyrics" ("imageId" int PRIMARY KEY, text text NOT NULL, lines jsonb NOT NULL);
  CREATE TABLE "EntityModeration" (
    "entityType" text NOT NULL, "entityId" int NOT NULL, status text NOT NULL, blocked boolean
  );
  CREATE TABLE "Post" (
    id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
    availability "Availability" DEFAULT 'Public', "collectionId" int
  );
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text, "bannerId" int,
    "userId" int, availability "Availability" DEFAULT 'Public'
  );
  CREATE TABLE "CollectionContributor" (
    "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
  );
  CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
  CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
  CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
  CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);
`;

const TIMED = [
  { t: 0, text: '[Verse 1]' },
  { t: 1200, text: 'Coins in the slot' },
  { t: null, text: 'the city hums in blue' },
];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (1, ${OWNER}, now() - interval '1 day');
    INSERT INTO "Image" (id, "userId", "postId", type, ingestion, "blockedFor", "needsReview") VALUES
      (201, ${OWNER}, 1, 'audio', 'Scanned', NULL, NULL),
      (202, ${OWNER}, 1, 'audio', 'Scanned', NULL, 'csam'),
      (212, ${OWNER}, 1, 'audio', 'Scanned', NULL, 'poi');
    INSERT INTO "Image" (id, "userId", "postId", type, ingestion, "blockedFor") VALUES
      (203, ${OWNER}, 1, 'audio', 'Blocked', NULL),
      (204, ${OWNER}, 1, 'audio', 'Pending', NULL),
      (205, ${OWNER}, 1, 'image', 'Scanned', NULL),
      (206, ${OWNER}, 1, 'audio', 'Scanned', NULL),
      (207, ${OWNER}, 1, 'audio', 'Scanned', 'AiNotVerified'),
      (208, ${OWNER}, 1, 'audio', 'Scanned', NULL);
    INSERT INTO "Image" (id, "userId", "postId", type, ingestion, "nsfwLevel") VALUES
      (209, ${OWNER}, 1, 'audio', 'Scanned', ${NsfwLevel.Blocked});
    INSERT INTO "TrackLyrics" ("imageId", text, lines) VALUES
      (201, 'x', '${JSON.stringify(TIMED)}'),
      (202, 'x', '${JSON.stringify(TIMED)}'),
      (203, 'x', '${JSON.stringify(TIMED)}'),
      (204, 'x', '${JSON.stringify(TIMED)}'),
      (205, 'x', '${JSON.stringify(TIMED)}'),
      (207, 'x', '${JSON.stringify(TIMED)}'),
      (208, 'x', '[{"t": "soon", "text": 1}]'),
      (209, 'x', '${JSON.stringify(TIMED)}'),
      (212, 'x', '${JSON.stringify(TIMED)}'),
      (213, 'x', '${JSON.stringify(TIMED)}'),
      (214, 'x', '${JSON.stringify(TIMED)}'),
      (215, 'x', '${JSON.stringify(TIMED)}');
    -- 213: lyrics scan still pending; 214: rating locked while Pending, lyrics unscanned;
    -- 215: lyrics blocked.
    INSERT INTO "Image" (id, "userId", "postId", type, ingestion, "nsfwLevelLocked") VALUES
      (213, ${OWNER}, 1, 'audio', 'Scanned', false),
      (214, ${OWNER}, 1, 'audio', 'Pending', true),
      (215, ${OWNER}, 1, 'audio', 'Scanned', false);
    INSERT INTO "EntityModeration" ("entityType", "entityId", status, blocked)
      SELECT 'TrackLyrics', "imageId", 'Succeeded', false FROM "TrackLyrics"
      WHERE "imageId" NOT IN (213, 214, 215);
    INSERT INTO "EntityModeration" ("entityType", "entityId", status, blocked) VALUES
      ('TrackLyrics', 213, 'Pending', NULL),
      ('TrackLyrics', 215, 'Succeeded', true);
  `);
  const raw = pgliteRaw(db);
  const queryRaw = ((s: TemplateStringsArray, ...v: unknown[]) => raw.queryRaw(s, ...v)) as never;
  dbMock.dbRead.$queryRaw.mockImplementation(queryRaw);
  dbMock.dbWrite.$queryRaw.mockImplementation(queryRaw);
});

afterAll(() => db.close());

/** A browser session (no API key) on a domain that serves mature content, unless `sfw`. */
const session = (user: { id: number; isModerator: boolean } | undefined, sfw = false) =>
  ({
    user,
    features: { music: true, canViewNsfw: !sfw },
    req: { headers: {} },
    apiKeyId: undefined,
    apiKeyType: undefined,
    subject: undefined,
    tokenScope: undefined,
  } as unknown as Parameters<typeof getSongLyrics>[0]['ctx']);
const viewer = session({ id: VIEWER, isModerator: false });
const read = (id: number, ctx: Parameters<typeof getSongLyrics>[0]['ctx'] = viewer) =>
  getSongLyrics({ id, ctx });

describe('getSongLyrics', () => {
  it("returns a visible, reviewed song's stored lines, timed and untimed", async () => {
    expect(await read(201)).toEqual(TIMED);
  });

  it("holds a mature song's lyrics to the domain's browsing level, except for its owner", async () => {
    await db.exec(`UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = 201`);
    try {
      expect(await read(201, session({ id: VIEWER, isModerator: false }, true))).toBeNull();
      expect(await read(201, session({ id: OWNER, isModerator: false }, true))).toEqual(TIMED);
      expect(await read(201)).toEqual(TIMED);
      await db.exec(`UPDATE "Image" SET "nsfwLevel" = 1 WHERE id = 201`);
      expect(await read(201, session({ id: VIEWER, isModerator: false }, true))).toEqual(TIMED);
    } finally {
      await db.exec(`UPDATE "Image" SET "nsfwLevel" = DEFAULT WHERE id = 201`);
    }
  });

  it('returns nothing until the lyrics have their own clean verdict, even past a rating lock', async () => {
    expect(await read(213)).toBeNull();
    expect(await read(214)).toBeNull();
    expect(await read(215)).toBeNull();
    expect(await read(213, session({ id: OWNER, isModerator: false }))).toBeNull();
  });

  it('returns them to a signed-out viewer too', async () => {
    expect(await read(201, session(undefined))).toEqual(TIMED);
  });

  it('returns nothing for a song held for csam review, that is blocked, or not yet reviewed', async () => {
    expect(await read(202)).toBeNull();
    expect(await read(203)).toBeNull();
    expect(await read(204)).toBeNull();
    expect(await read(207)).toBeNull();
  });

  it('keeps an unreviewed or held song lyric-less for its owner and for moderators as well', async () => {
    const owner = session({ id: OWNER, isModerator: false });
    const moderator = session({ id: VIEWER, isModerator: true });
    expect(await read(204, owner)).toBeNull();
    expect(await read(202, owner)).toBeNull();
    expect(await read(202, moderator)).toBeNull();
    expect(await read(201, owner)).toEqual(TIMED);
  });

  it("returns a song's lines under another review to its owner only", async () => {
    const owner = session({ id: OWNER, isModerator: false });
    const moderator = session({ id: VIEWER, isModerator: true });
    expect(await read(212, owner)).toEqual(TIMED);
    expect(await read(212)).toBeNull();
    expect(await read(212, moderator)).toBeNull();
  });

  it('keeps a blocked song lyric-less for the owner and moderators, whom visibility lets through', async () => {
    const owner = session({ id: OWNER, isModerator: false });
    const moderator = session({ id: VIEWER, isModerator: true });
    // A Blocked level and a block reason: the song shows to these viewers, its lyrics do not.
    for (const ctx of [owner, moderator]) {
      expect(await read(209, ctx)).toBeNull();
      expect(await read(207, ctx)).toBeNull();
    }
  });

  it('returns nothing for a song without lyrics, with lines of the wrong shape, or an unknown id', async () => {
    expect(await read(206)).toBeNull();
    expect(await read(208)).toBeNull();
    expect(await read(999)).toBeNull();
  });

  it('refuses an image or video', async () => {
    await expect(read(205)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses everyone while the music flag is off', async () => {
    await expect(
      read(201, { ...viewer, features: { music: false } } as typeof viewer)
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

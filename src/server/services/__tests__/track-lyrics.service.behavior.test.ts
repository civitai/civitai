import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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
  CREATE TABLE "TextScanHold" ("entityType" text, "entityId" int, label text, status text);
  CREATE TABLE "Image" ( type "MediaType" NOT NULL DEFAULT 'audio',
    id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
    "needsReview" text, "blockedFor" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
    "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}', "scanJobs" jsonb,
    "acceptableMinor" boolean NOT NULL DEFAULT false
  );
  CREATE TABLE "TrackLyrics" ("imageId" int PRIMARY KEY, text text NOT NULL, lines jsonb NOT NULL);
  CREATE TABLE "Post" (
    id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
    availability "Availability" DEFAULT 'Public', "collectionId" int
  );
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text, "bannerId" int
  );
  CREATE TABLE "CollectionContributor" (
    "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
  );
  CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
  CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
  CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
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
    INSERT INTO "Image" (id, "userId", "postId", type, ingestion, "blockedFor") VALUES
      (201, ${OWNER}, 1, 'audio', 'Scanned', NULL),
      (202, ${OWNER}, 1, 'audio', 'Scanned', NULL),
      (203, ${OWNER}, 1, 'audio', 'Blocked', NULL),
      (204, ${OWNER}, 1, 'audio', 'Pending', NULL),
      (205, ${OWNER}, 1, 'image', 'Scanned', NULL),
      (206, ${OWNER}, 1, 'audio', 'Scanned', NULL),
      (207, ${OWNER}, 1, 'audio', 'Scanned', 'AiNotVerified'),
      (208, ${OWNER}, 1, 'audio', 'Scanned', NULL);
    INSERT INTO "TrackLyrics" ("imageId", text, lines) VALUES
      (201, 'x', '${JSON.stringify(TIMED)}'),
      (202, 'x', '${JSON.stringify(TIMED)}'),
      (203, 'x', '${JSON.stringify(TIMED)}'),
      (204, 'x', '${JSON.stringify(TIMED)}'),
      (205, 'x', '${JSON.stringify(TIMED)}'),
      (207, 'x', '${JSON.stringify(TIMED)}'),
      (208, 'x', '[{"t": "soon", "text": 1}]');
    INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES
      ('TrackLyrics', 202, 'csam', 'Pending');
  `);
  const raw = pgliteRaw(db);
  const queryRaw = ((s: TemplateStringsArray, ...v: unknown[]) => raw.queryRaw(s, ...v)) as never;
  dbMock.dbRead.$queryRaw.mockImplementation(queryRaw);
  dbMock.dbWrite.$queryRaw.mockImplementation(queryRaw);
});

afterAll(() => db.close());

const viewer = { user: { id: VIEWER, isModerator: false }, features: { music: true } };
const read = (id: number, ctx: Parameters<typeof getSongLyrics>[0]['ctx'] = viewer) =>
  getSongLyrics({ id, ctx });

describe('getSongLyrics', () => {
  it("returns a visible, reviewed song's stored lines, timed and untimed", async () => {
    expect(await read(201)).toEqual(TIMED);
  });

  it('returns them to a signed-out viewer too', async () => {
    expect(await read(201, { user: undefined, features: { music: true } })).toEqual(TIMED);
  });

  it('returns nothing for a song whose lyrics are held, that is blocked, or not yet reviewed', async () => {
    expect(await read(202)).toBeNull();
    expect(await read(203)).toBeNull();
    expect(await read(204)).toBeNull();
    expect(await read(207)).toBeNull();
  });

  it('keeps an unreviewed or held song lyric-less for its owner and for moderators as well', async () => {
    const owner = { user: { id: OWNER, isModerator: false }, features: { music: true } };
    const moderator = { user: { id: VIEWER, isModerator: true }, features: { music: true } };
    expect(await read(204, owner)).toBeNull();
    expect(await read(202, owner)).toBeNull();
    expect(await read(202, moderator)).toBeNull();
    expect(await read(201, owner)).toEqual(TIMED);
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
    await expect(read(201, { ...viewer, features: { music: false } })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

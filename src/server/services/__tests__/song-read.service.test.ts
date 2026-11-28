import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { NsfwLevel } from '~/server/common/enums';
import type * as KyselyDb from '~/server/db/kyselyDb';

// The one song read behind timed comments, song reports and song plays, against real tables.
const pg = { db: null as unknown as PGlite };
vi.mock('~/server/db/kyselyDb', async (importOriginal) => ({
  ...(await importOriginal<typeof KyselyDb>()),
  kyselyRead: pgliteKysely(() => pg.db),
}));
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { readSong } = await import('~/server/services/song-read.service');
const { imageVisibilityConditions } = await import('~/server/services/image-visibility.service');
// What song plays pass: songs anyone may open.
const PUBLIC = { conditions: imageVisibilityConditions({}) };

const OWNER = 10;
const PUBLIC_SONG = 1;
const UNPUBLISHED_SONG = 2;
const BLOCKED_SONG = 3;
const PUBLIC_IMAGE = 4;
const NO_LENGTH = 5;
const ZERO_LENGTH = 6;
const TEXT_LENGTH = 7;

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      minor boolean DEFAULT false, type text NOT NULL DEFAULT 'audio',
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
      "needsReview" text, "blockedFor" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}', "scanJobs" jsonb,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "modelRestricted" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text,
      "bannerId" int, availability "Availability" DEFAULT 'Public', "userId" int
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);

    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
      (1, ${OWNER}, now() - interval '1 day'),
      (2, ${OWNER}, NULL);
    INSERT INTO "Image" (id, "userId", "postId", type, "nsfwLevel", metadata) VALUES
      (${PUBLIC_SONG}, ${OWNER}, 1, 'audio', 1, '{"duration": 180}'),
      (${UNPUBLISHED_SONG}, ${OWNER}, 2, 'audio', 1, '{"duration": 90}'),
      (${BLOCKED_SONG}, ${OWNER}, 1, 'audio', ${NsfwLevel.Blocked}, '{"duration": 60}'),
      (${PUBLIC_IMAGE}, ${OWNER}, 1, 'image', 1, '{"duration": 180}'),
      (${NO_LENGTH}, ${OWNER}, 1, 'audio', 1, '{}'),
      (${ZERO_LENGTH}, ${OWNER}, 1, 'audio', 1, '{"duration": 0}'),
      (${TEXT_LENGTH}, ${OWNER}, 1, 'audio', 1, '{"duration": "180"}');
  `);
});
afterAll(async () => {
  await pg.db.close();
});

describe.each([
  ['public', PUBLIC],
  ['unchecked', 'unchecked'],
] as const)('readSong (%s)', (_, visibility) => {
  it('reads a public song and its stored length', async () => {
    expect(await readSong(PUBLIC_SONG, { visibility })).toEqual({ durationSec: 180 });
  });

  it('is null for an image that is not a song, a missing image, and an id past int4', async () => {
    expect(await readSong(PUBLIC_IMAGE, { visibility })).toBeNull();
    expect(await readSong(99, { visibility })).toBeNull();
    expect(await readSong(2 ** 31, { visibility })).toBeNull();
  });

  it('has no length for a song without a usable stored one', async () => {
    for (const id of [NO_LENGTH, ZERO_LENGTH, TEXT_LENGTH])
      expect(await readSong(id, { visibility })).toEqual({ durationSec: null });
  });
});

describe('readSong visibility', () => {
  it('public: is null for a song the public cannot open (unpublished, or removed)', async () => {
    expect(await readSong(UNPUBLISHED_SONG, { visibility: PUBLIC })).toBeNull();
    expect(await readSong(BLOCKED_SONG, { visibility: PUBLIC })).toBeNull();
  });

  it('unchecked: reads those songs, whoever may open them', async () => {
    expect(await readSong(UNPUBLISHED_SONG, { visibility: 'unchecked' })).toEqual({
      durationSec: 90,
    });
    expect(await readSong(BLOCKED_SONG, { visibility: 'unchecked' })).toEqual({ durationSec: 60 });
  });
});

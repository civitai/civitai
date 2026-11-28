import { serverCopyTablesSql } from '@civitai/db-queries/test/image-uses';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * The 404 page's gallery shows only contest entries the shared single-image rule would show a
 * signed-out visitor, from uploaders who are neither banned nor deleted, and uses a prompt as alt
 * text only when its uploader shows it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { get404Images } from '../image.service';

const CLEAN = 1;
const ACCEPTABLE_MINOR = 2;
const HELD = 3;
const HIDDEN_META = 4;
const BLOCKED_FOR = 5;
const TOS_VIOLATION = 6;
const POSTLESS = 7;
const BY_BANNED = 8;
const BY_DELETED = 9;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 5, "postId" int, url text NOT NULL,
      type text NOT NULL DEFAULT 'image', "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, metadata jsonb, "blockedFor" text,
      minor boolean NOT NULL DEFAULT false, "modelRestricted" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb,
      meta jsonb, "hideMeta" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 5, "publishedAt" timestamp,
      "collectionId" int, availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "bannerId" int, status text, "publishedAt" timestamp, ingestion text, availability "Availability" DEFAULT 'Public', "userId" int
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability");
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int);
    INSERT INTO "Post" (id, "publishedAt") VALUES (1, now() - interval '1 day');
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp, "deletedAt" timestamp);
    CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int, name text);
    CREATE TABLE "CollectionItem" ("collectionId" int, "imageId" int, status text);
    INSERT INTO "User" (id, username, "bannedAt", "deletedAt") VALUES
      (5, 'entrant', NULL, NULL), (6, 'banned', now(), NULL), (7, 'deleted', NULL, now());
    INSERT INTO "Collection" VALUES (1, -1, '404 Contest');
    INSERT INTO "Image" (id, "postId", url, meta, "acceptableMinor", "needsReview", "hideMeta") VALUES
      (${CLEAN}, 1, 'img-clean', '{"prompt": "shown prompt"}', false, NULL, false),
      (${ACCEPTABLE_MINOR}, 1, 'img-acceptable-minor', NULL, true, NULL, false),
      (${HELD}, 1, 'img-held', NULL, false, 'minor', false),
      (${HIDDEN_META}, 1, 'img-hidden-meta', '{"prompt": "hidden prompt"}', false, NULL, true);
    INSERT INTO "Image" (id, "postId", url, "blockedFor", "tosViolation") VALUES
      (${BLOCKED_FOR}, 1, 'img-blocked', 'tos', false),
      (${TOS_VIOLATION}, 1, 'img-tos', NULL, true),
      (${POSTLESS}, NULL, 'img-postless', NULL, false);
    INSERT INTO "Image" (id, "userId", "postId", url) VALUES
      (${BY_BANNED}, 6, 1, 'img-by-banned'), (${BY_DELETED}, 7, 1, 'img-by-deleted');
    INSERT INTO "CollectionItem" VALUES
      (1, ${CLEAN}, 'ACCEPTED'), (1, ${ACCEPTABLE_MINOR}, 'ACCEPTED'), (1, ${HELD}, 'ACCEPTED'),
      (1, ${HIDDEN_META}, 'ACCEPTED'), (1, ${BLOCKED_FOR}, 'ACCEPTED'), (1, ${TOS_VIOLATION}, 'ACCEPTED'),
      (1, ${POSTLESS}, 'ACCEPTED'), (1, ${BY_BANNED}, 'ACCEPTED'), (1, ${BY_DELETED}, 'ACCEPTED');
    ${serverCopyTablesSql};
    ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS url text;
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

describe('get404Images', () => {
  it('serves an accepted, reviewed entry with its prompt as alt text (control)', async () => {
    expect(await get404Images()).toContainEqual(['entrant', 'img-clean', 'shown prompt']);
  });

  it.each([
    ['marked acceptable-minor', 'img-acceptable-minor'],
    ['held for review', 'img-held'],
    ['carrying a block reason', 'img-blocked'],
    ['marked as a ToS violation', 'img-tos'],
    ['on no post', 'img-postless'],
    ['by a banned uploader', 'img-by-banned'],
    ['by a deleted uploader', 'img-by-deleted'],
  ])('leaves out an entry %s', async (_, url) => {
    expect((await get404Images()).map(([, u]) => u)).not.toContain(url);
  });

  it('serves an entry whose prompt is hidden, without the prompt', async () => {
    const entry = (await get404Images()).find(([, u]) => u === 'img-hidden-meta');
    expect(entry).toBeDefined();
    expect(entry?.[2] ?? '').toBe('');
  });
});

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import type * as PlacementService from '~/server/services/placement.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * An uploaded cover (an image in no post) read through the feed's real SQL: the image gate and the
 * joins an upload leaves empty run in an in-process Postgres built from the shipped storyline
 * migrations.
 */

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getAllHiddenForUser: vi.fn().mockResolvedValue({ hiddenImages: [], hiddenTags: [] }),
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
  HiddenUsers: { getCached: vi.fn().mockResolvedValue([]) },
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRanges: vi.fn().mockResolvedValue(new Map()),
}));

const { getStorylinesInfinite } = await import('~/server/services/storyline.service');
const { getBlockedPairIds } = await import('~/server/services/user-preferences.service');

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const r = dbMock.dbRead;

const OWNER = 1;
const STRANGER = 2;
const MODERATOR = 3;
const READER = 4;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, username text, "bannedAt" timestamp(3),
      "deletedAt" timestamp(3), "isModerator" boolean DEFAULT false);
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false,
      availability text NOT NULL DEFAULT 'Public');
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, url text NOT NULL, type text NOT NULL DEFAULT 'image',
      "nsfwLevel" integer NOT NULL DEFAULT 0, hash text, width integer, height integer,
      "userId" integer NOT NULL, minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "postId" integer, ingestion text NOT NULL DEFAULT 'Pending',
      "tosViolation" boolean NOT NULL DEFAULT false, "needsReview" text,
      "acceptableMinor" boolean NOT NULL DEFAULT false);
    CREATE TABLE "TagsOnImageDetails" ("imageId" integer, "tagId" integer, disabled boolean DEFAULT false);
    CREATE TABLE "PlacementSpace" (surface text, "entityType" text, "entityId" integer, mode text,
      price integer);
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261023140000_storyline_engagement',
    '20261024120000_storyline_chapter_removed',
    '20261024130000_storyline_cover_hero',
    '20261024140000_storyline_title_moderation',
    '20261024150000_storyline_moderator_takedown',
    '20261024160000_storyline_minor_by_scan',
    '20261106120000_storyline_rejoin',
    '20261122120000_storyline_pending_chapter',
  ])
    await db.pg.exec(migration(name));

  await db.pg.exec(`
    INSERT INTO "User" (id, username, "isModerator") VALUES
      (1, 'owner', false), (2, 'stranger', false), (3, 'mod', true), (4, 'reader', false);
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES (100, 1, 1, now() - interval '1 day');
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
      (1, 1, 'Covered by an upload', 1, now());
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth) VALUES (10, 1, 100, 1, 0);
    INSERT INTO "Image" (id, url, "nsfwLevel", "userId", "postId", ingestion) VALUES
      (50, 'owner-upload', 1, ${OWNER}, NULL, 'Scanned'),
      (51, 'owner-upload-scanning', 0, ${OWNER}, NULL, 'Pending'),
      (52, 'stranger-image', 1, ${STRANGER}, NULL, 'Scanned'),
      (53, 'owner-upload-too-hot', ${NsfwLevel.X}, ${OWNER}, NULL, 'Scanned'),
      (54, 'mod-upload', 1, ${MODERATOR}, NULL, 'Scanned'),
      (55, 'owner-upload-minor', 1, ${OWNER}, NULL, 'Scanned'),
      (56, 'owner-upload-rescanning', 1, ${OWNER}, NULL, 'Rescan'),
      (57, 'owner-upload-taken-down', 1, ${OWNER}, NULL, 'Scanned');
    UPDATE "Image" SET "tosViolation" = true WHERE id = 57;
    UPDATE "Image" SET minor = true WHERE id = 55;
  `);

  const raw = pgliteRaw(db.pg);
  // The feed's statement and the chosen-image read run in Postgres; chapter 1's first image (the
  // fallback cover) is not this file's subject and finds nothing.
  r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    return text.includes('FROM "Storyline" st') ||
      text.includes('AS pick("storylineId", "imageId")')
      ? raw.queryRaw(strings, ...values)
      : Promise.resolve([]);
  }) as never);
});

afterAll(async () => {
  await db.pg.close();
});

const coverFor = async (imageId: number, viewer = { id: READER }) => {
  await db.pg.exec(`UPDATE "Storyline" SET "coverImageId" = ${imageId} WHERE id = 1`);
  const { items } = await getStorylinesInfinite({
    filter: 'all',
    sort: 'newest',
    limit: 20,
    viewer,
    browsingLevel: NsfwLevel.PG,
  });
  return items.find((item) => item.id === 1)?.coverImage?.id ?? null;
};

describe('an uploaded card cover, read by the feed', () => {
  it("shows its owner's scanned, rated upload", async () => {
    await expect(coverFor(50)).resolves.toBe(50);
  });

  it("shows a moderator's upload", async () => {
    await expect(coverFor(54)).resolves.toBe(54);
  });

  it('shows nothing for an upload still being scanned, to anyone', async () => {
    await expect(coverFor(51)).resolves.toBeNull();
    await expect(coverFor(51, { id: OWNER })).resolves.toBeNull();
  });

  it('shows nothing for a rated upload while it is being scanned again', async () => {
    await expect(coverFor(56)).resolves.toBeNull();
  });

  it("never shows someone else's image in no post", async () => {
    await expect(coverFor(52)).resolves.toBeNull();
  });

  it("never shows an upload rated above the storyline's ceiling", async () => {
    await expect(coverFor(53)).resolves.toBeNull();
  });

  it('never shows an upload of a minor', async () => {
    await expect(coverFor(55)).resolves.toBeNull();
  });

  it('shows nothing for an upload taken down after it was picked', async () => {
    await expect(coverFor(57)).resolves.toBeNull();
  });

  it('shows nothing once the uploader is banned', async () => {
    await db.pg.exec(`UPDATE "User" SET "bannedAt" = now() WHERE id = ${MODERATOR}`);
    try {
      await expect(coverFor(54)).resolves.toBeNull();
    } finally {
      await db.pg.exec(`UPDATE "User" SET "bannedAt" = NULL WHERE id = ${MODERATOR}`);
    }
  });

  it('shows nothing to a reader who blocked the uploader', async () => {
    vi.mocked(getBlockedPairIds).mockResolvedValueOnce([MODERATOR]);
    await expect(coverFor(54)).resolves.toBeNull();
    await expect(coverFor(54)).resolves.toBe(54);
  });
});

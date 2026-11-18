import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { COMIC_ELIGIBLE_SQL } from '../../../../apps/event-engine/src/vector-sync/comics/source';
import { comicSearchEligibleWhere } from '~/server/search-index/comics.search-index';

const SCHEMA = `
  CREATE TYPE "ComicProjectStatus" AS ENUM ('Active', 'Deleted');
  CREATE TYPE "ComicChapterStatus" AS ENUM ('Draft', 'Published', 'Scheduled');
  CREATE TYPE "ComicPanelStatus" AS ENUM ('Pending', 'Enqueued', 'Generating', 'AwaitingSelection', 'RequireUnlock', 'Ready', 'Failed');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
  -- 3 deleted, 4 a CsamReport's subject, 5 under an evidence hold.
  INSERT INTO "User" VALUES (1, NULL, NULL), (2, now(), NULL), (3, NULL, now()), (4, NULL, NULL),
    (5, NULL, NULL), (-1, NULL, NULL);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  INSERT INTO "CsamReport" ("userId") VALUES (4);
  CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
  INSERT INTO "EvidenceHold" VALUES (5, NULL);
  CREATE VIEW "EvidenceHeldUser" AS
    SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
  CREATE TABLE "ComicProject" (
    id int PRIMARY KEY, "userId" int NOT NULL, status "ComicProjectStatus" NOT NULL,
    "tosViolation" boolean NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1, "coverImageId" int
  );
  CREATE TABLE "ComicChapter" (
    "projectId" int NOT NULL, position int NOT NULL, status "ComicChapterStatus" NOT NULL,
    availability "Availability" NOT NULL DEFAULT 'Public',
    PRIMARY KEY ("projectId", position)
  );
  CREATE TABLE "Image" (
    id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL, "needsReview" text,
    "tosViolation" boolean NOT NULL, "userId" int NOT NULL DEFAULT 1, "blockedFor" text,
    minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
    "nsfwLevel" int NOT NULL DEFAULT 1
  );
  CREATE TABLE "ComicPanel" (
    id serial PRIMARY KEY, "projectId" int NOT NULL, "chapterPosition" int NOT NULL,
    "imageId" int, "imageUrl" text, status "ComicPanelStatus" NOT NULL
  );
`;

/** An image row: (ingestion, needsReview, tosViolation[, userId, blockedFor, minor, poi, nsfwLevel]). */
type Panel = { status?: string; imageUrl?: string; image?: false | string };
type Over = {
  project?: string;
  chapter?: string;
  panels?: Panel[];
  /** The cover image's columns, as `image`; none when unset. */
  cover?: string;
};

const IMAGE_COLUMNS = `id, ingestion, "needsReview", "tosViolation", "userId", "blockedFor", minor, poi, "nsfwLevel"`;
const imageRow = (id: number, cols: string) => {
  const n = cols.split(',').length;
  return `INSERT INTO "Image" (${IMAGE_COLUMNS.split(', ')
    .slice(0, n + 1)
    .join(', ')}) VALUES (${id}, ${cols})`;
};

/**
 * One comic with one chapter. Each panel gets its own image (id = comic * 10 + n) unless `image`
 * is false; the cover is image comic * 10 + 9.
 */
const comic = (id: number, name: string, include: boolean, over: Over = {}): ParityRow => {
  const project = over.project ?? `1, 'Active', false`;
  const chapter = over.chapter ?? `'Published'`;
  const panels = over.panels ?? [{}];
  const coverId = id * 10 + 9;
  const sql = [
    ...(over.cover ? [imageRow(coverId, over.cover)] : []),
    `INSERT INTO "ComicProject" (id, "userId", status, "tosViolation") VALUES (${id}, ${project})`,
    ...(over.cover
      ? [`UPDATE "ComicProject" SET "coverImageId" = ${coverId} WHERE id = ${id}`]
      : []),
    `INSERT INTO "ComicChapter" ("projectId", position, status) VALUES (${id}, 1, ${chapter})`,
    ...panels.flatMap((p, n) => {
      const imageId = id * 10 + n;
      return [
        ...(p.image === false ? [] : [imageRow(imageId, p.image ?? `'Scanned', NULL, false`)]),
        `INSERT INTO "ComicPanel" ("projectId", "chapterPosition", "imageId", "imageUrl", status)
          VALUES (${id}, 1, ${p.image === false ? 'NULL' : imageId}, ${p.imageUrl ?? `'u'`},
          ${p.status ?? `'Ready'`})`,
      ];
    }),
  ];
  return { id, name, include, insert: sql.join(';\n') };
};

/** Runs after the insert: a column the helper does not set. */
const withSql = (row: ParityRow, ...sql: string[]): ParityRow => ({
  ...row,
  insert: [row.insert, ...sql].join(';\n'),
});

// The event-engine's copy, which decides which comics get a point.
const COPY = `SELECT cp.id FROM "ComicProject" cp WHERE ${COMIC_ELIGIBLE_SQL}`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    comic(1, 'eligible', true),
    comic(2, 'status', false, { project: `1, 'Deleted', false` }),
    comic(3, 'tosViolation', false, { project: `1, 'Active', true` }),
    comic(4, 'systemUser', false, { project: `-1, 'Active', false` }),
    comic(5, 'bannedOwner', false, { project: `2, 'Active', false` }),
    comic(6, 'publishedChapter', false, { chapter: `'Draft'` }),
    comic(7, 'readyPanel', false, { panels: [{ status: `'Pending'` }] }),
    comic(8, 'panelImageUrl', false, { panels: [{ imageUrl: 'NULL' }] }),
    comic(9, 'panelScanned', false, { panels: [{ image: `'Pending', NULL, false` }] }),
    comic(10, 'panelNotInReview', false, { panels: [{ image: `'Scanned', 'minor', false` }] }),
    comic(11, 'panelImageTos', false, { panels: [{ image: `'Scanned', NULL, true` }] }),
    comic(12, 'everyReadyPanelClean', false, { panels: [{}, { image: false }] }),
    comic(13, 'chapterScheduled', false, { chapter: `'Scheduled'` }),
    // Only Ready panels count: an unfinished panel with no image leaves the comic eligible.
    comic(14, 'pendingPanelWithoutImage', true, {
      panels: [{}, { status: `'Pending'`, image: false, imageUrl: 'NULL' }],
    }),
    comic(15, 'deletedOwner', false, { project: `3, 'Active', false` }),
    comic(16, 'ownerReported', false, { project: `4, 'Active', false` }),
    comic(17, 'ownerEvidenceHold', false, { project: `5, 'Active', false` }),
    withSql(
      comic(18, 'chapterPublic', false),
      `UPDATE "ComicChapter" SET availability = 'Private' WHERE "projectId" = 18`
    ),
    withSql(
      comic(19, 'projectUnrated', false),
      `UPDATE "ComicProject" SET "nsfwLevel" = 0 WHERE id = 19`
    ),
    withSql(
      comic(20, 'projectBlocked', false),
      `UPDATE "ComicProject" SET "nsfwLevel" = 32 WHERE id = 20`
    ),
    comic(21, 'panelBlockedFor', false, {
      panels: [{ image: `'Scanned', NULL, false, 1, 'AiNotVerified'` }],
    }),
    comic(22, 'panelMinor', false, {
      panels: [{ image: `'Scanned', NULL, false, 1, NULL, true` }],
    }),
    comic(23, 'panelPoi', false, {
      panels: [{ image: `'Scanned', NULL, false, 1, NULL, false, true` }],
    }),
    comic(24, 'panelUnrated', false, {
      panels: [{ image: `'Scanned', NULL, false, 1, NULL, false, false, 0` }],
    }),
    comic(25, 'panelBlocked', false, {
      panels: [{ image: `'Scanned', NULL, false, 1, NULL, false, false, 32` }],
    }),
    // A held panel image anywhere in the comic, even in an unpublished chapter.
    withSql(
      comic(26, 'panelImageHeld', false),
      `INSERT INTO "ComicChapter" ("projectId", position, status) VALUES (26, 2, 'Draft')`,
      `INSERT INTO "Image" (id, ingestion, "tosViolation", "userId") VALUES (2601, 'Scanned', false, 4)`,
      `INSERT INTO "ComicPanel" ("projectId", "chapterPosition", "imageId", "imageUrl", status) VALUES (26, 2, 2601, 'u', 'Pending')`
    ),
    comic(27, 'eligible:cleanCover', true, { cover: `'Scanned', NULL, false` }),
    comic(28, 'coverScanned', false, { cover: `'Pending', NULL, false` }),
    comic(29, 'coverNotInReview', false, { cover: `'Scanned', 'minor', false` }),
    comic(30, 'coverTos', false, { cover: `'Scanned', NULL, true` }),
    comic(31, 'coverBlockedFor', false, { cover: `'Scanned', NULL, false, 1, 'AiNotVerified'` }),
    comic(32, 'coverMinor', false, { cover: `'Scanned', NULL, false, 1, NULL, true` }),
    comic(33, 'coverPoi', false, { cover: `'Scanned', NULL, false, 1, NULL, false, true` }),
    comic(34, 'coverRated', false, { cover: `'Scanned', NULL, false, 1, NULL, false, false, 0` }),
    comic(35, 'coverHeld', false, { cover: `'Scanned', NULL, false, 4` }),
    withSql(
      comic(36, 'coverListed', false, { cover: `'Scanned', NULL, false` }),
      `INSERT INTO "CsamReport" (images) VALUES ('[369]')`
    ),
    // Chapter 1 clean; a Ready panel in a second Public chapter is held.
    withSql(
      comic(37, 'heldPanelInSecondChapter', false),
      `INSERT INTO "ComicChapter" ("projectId", position, status) VALUES (37, 2, 'Published')`,
      `INSERT INTO "Image" (id, ingestion, "tosViolation", "userId") VALUES (3701, 'Scanned', false, 5)`,
      `INSERT INTO "ComicPanel" ("projectId", "chapterPosition", "imageId", "imageUrl", status) VALUES (37, 2, 3701, 'u', 'Ready')`
    ),
    // Chapter 1 clean; a Ready panel in a second Published, Public chapter is of a minor.
    withSql(
      comic(38, 'flaggedPanelInSecondChapter', false),
      `INSERT INTO "ComicChapter" ("projectId", position, status) VALUES (38, 2, 'Published')`,
      `INSERT INTO "Image" (id, ingestion, "tosViolation", minor) VALUES (3801, 'Scanned', false, true)`,
      `INSERT INTO "ComicPanel" ("projectId", "chapterPosition", "imageId", "imageUrl", status) VALUES (38, 2, 3801, 'u', 'Ready')`
    ),
    // The same panel in a Draft chapter, which is not served, leaves the comic eligible.
    withSql(
      comic(39, 'eligible:flaggedPanelInDraftChapter', true),
      `INSERT INTO "ComicChapter" ("projectId", position, status) VALUES (39, 2, 'Draft')`,
      `INSERT INTO "Image" (id, ingestion, "tosViolation", minor) VALUES (3901, 'Scanned', false, true)`,
      `INSERT INTO "ComicPanel" ("projectId", "chapterPosition", "imageId", "imageUrl", status) VALUES (39, 2, 3901, 'u', 'Ready')`
    ),
  ],
  clauses: [
    'status',
    'tosViolation',
    'systemUser',
    'bannedOwner',
    'publishedChapter',
    'readyPanel',
    'panelImageUrl',
    'panelScanned',
    'panelNotInReview',
    'panelImageTos',
    'everyReadyPanelClean',
    'deletedOwner',
    'ownerReported',
    'ownerEvidenceHold',
    'chapterPublic',
    'projectUnrated',
    'projectBlocked',
    'panelBlockedFor',
    'panelMinor',
    'panelPoi',
    'panelUnrated',
    'panelBlocked',
    'panelImageHeld',
    'coverScanned',
    'coverNotInReview',
    'coverTos',
    'coverBlockedFor',
    'coverMinor',
    'coverPoi',
    'coverRated',
    'coverHeld',
    'coverListed',
    'heldPanelInSecondChapter',
    'flaggedPanelInSecondChapter',
  ],
  site: async (prisma) =>
    (
      await prisma.$queryRaw<{ id: number }[]>`
        SELECT cp.id FROM "ComicProject" cp
        WHERE ${Prisma.join(comicSearchEligibleWhere, ' AND ')}`
    ).map((r) => r.id),
  copy: COPY,
};

describe('comic semantic search eligibility', () => {
  it('the event-engine keeps exactly the comics the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });

  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(` AND u."bannedAt" IS NULL`, ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['bannedOwner'] });
  });
});

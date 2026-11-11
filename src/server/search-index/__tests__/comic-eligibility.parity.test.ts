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
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
  INSERT INTO "User" VALUES (1, NULL), (2, now()), (-1, NULL);
  CREATE TABLE "ComicProject" (
    id int PRIMARY KEY, "userId" int NOT NULL, status "ComicProjectStatus" NOT NULL,
    "tosViolation" boolean NOT NULL
  );
  CREATE TABLE "ComicChapter" (
    "projectId" int NOT NULL, position int NOT NULL, status "ComicChapterStatus" NOT NULL,
    PRIMARY KEY ("projectId", position)
  );
  CREATE TABLE "Image" (
    id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL, "needsReview" text,
    "tosViolation" boolean NOT NULL
  );
  CREATE TABLE "ComicPanel" (
    id serial PRIMARY KEY, "projectId" int NOT NULL, "chapterPosition" int NOT NULL,
    "imageId" int, "imageUrl" text, status "ComicPanelStatus" NOT NULL
  );
`;

type Panel = { status?: string; imageUrl?: string; image?: false | string };
type Over = {
  project?: string;
  chapter?: string;
  panels?: Panel[];
};

/**
 * One comic with one chapter. Each panel gets its own image (id = comic * 10 + n) unless `image`
 * is false; `image` is that image's (ingestion, needsReview, tosViolation) row.
 */
const comic = (id: number, name: string, include: boolean, over: Over = {}): ParityRow => {
  const project = over.project ?? `1, 'Active', false`;
  const chapter = over.chapter ?? `'Published'`;
  const panels = over.panels ?? [{}];
  const sql = [
    `INSERT INTO "ComicProject" VALUES (${id}, ${project})`,
    `INSERT INTO "ComicChapter" VALUES (${id}, 1, ${chapter})`,
    ...panels.flatMap((p, n) => {
      const imageId = id * 10 + n;
      return [
        ...(p.image === false
          ? []
          : [`INSERT INTO "Image" VALUES (${imageId}, ${p.image ?? `'Scanned', NULL, false`})`]),
        `INSERT INTO "ComicPanel" ("projectId", "chapterPosition", "imageId", "imageUrl", status)
          VALUES (${id}, 1, ${p.image === false ? 'NULL' : imageId}, ${p.imageUrl ?? `'u'`},
          ${p.status ?? `'Ready'`})`,
      ];
    }),
  ];
  return { id, name, include, insert: sql.join(';\n') };
};

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

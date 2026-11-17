import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';

// The showcase block's own `where`, run by Prisma against real Postgres (PGlite): only images in a
// published, non-Private post with no review hold or TOS violation are served.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/image.service', () => ({ getImageMetricsObject: async () => ({}) }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));

const { getModelShowcaseImages } = await import('../showcase.service');

const VERSION = 100;
const PUBLISHED = 1000;
const DRAFT = 1001;
const SCHEDULED = 1002;
const PRIVATE = 1003;
const UNSEARCHABLE = 1004;
const PG = 1;

const CLEAN = 1;
const EXCLUDED = 2;

const SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM
    ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "Post" (
    id int PRIMARY KEY, "publishedAt" timestamp(3),
    availability "Availability" NOT NULL DEFAULT 'Public'
  );
  CREATE TABLE "Image" (
    id int PRIMARY KEY, "postId" int, url text NOT NULL DEFAULT '', width int, height int,
    meta jsonb, "nsfwLevel" int NOT NULL DEFAULT ${PG},
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
    "tosViolation" boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
    minor boolean NOT NULL DEFAULT false, "acceptableMinor" boolean NOT NULL DEFAULT false,
    "blockedFor" text
  );
  CREATE TABLE "ImageResourceNew" (
    "imageId" int NOT NULL, "modelVersionId" int NOT NULL, strength int,
    detected boolean NOT NULL DEFAULT false, PRIMARY KEY ("imageId", "modelVersionId")
  );
`;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  await harness.pg.exec(`
    INSERT INTO "Post" (id, "publishedAt", availability) VALUES
      (${PUBLISHED}, now() - interval '1 day', 'Public'),
      (${DRAFT}, NULL, 'Public'),
      (${SCHEDULED}, now() + interval '1 day', 'Public'),
      (${PRIVATE}, now() - interval '1 day', 'Private'),
      (${UNSEARCHABLE}, now() - interval '1 day', 'Unsearchable');
  `);
  dbMock.dbRead.imageResourceNew.findMany.mockImplementation(((
    ...args: Parameters<typeof harness.prisma.imageResourceNew.findMany>
  ) => harness.prisma.imageResourceNew.findMany(...args)) as never);
});
afterAll(() => harness.stop());

beforeEach(async () => {
  await harness.pg.exec(`DELETE FROM "ImageResourceNew"; DELETE FROM "Image";`);
});

async function image(id: number, postId: number, needsReview: string | null, tos = false) {
  await harness.pg.query(
    `INSERT INTO "Image" (id, "postId", "needsReview", "tosViolation") VALUES ($1, $2, $3, $4)`,
    [id, postId, needsReview, tos]
  );
  await harness.pg.query(
    `INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId") VALUES ($1, $2)`,
    [id, VERSION]
  );
}

const servedIds = async () => (await getModelShowcaseImages(VERSION)).map((i) => i.id).sort();

// One excluded image per case, beside a clean one, so the block's display cap never hides a miss.
describe('getModelShowcaseImages: which images the block may serve', () => {
  it.each([
    ['held for csam review', PUBLISHED, 'csam', false],
    ['held for minor review', PUBLISHED, 'minor', false],
    ['under another review', PUBLISHED, 'poi', false],
    ['a TOS violation', PUBLISHED, null, true],
    ['in a draft post', DRAFT, null, false],
    ['in a scheduled post', SCHEDULED, null, false],
    ['in a Private post', PRIVATE, null, false],
  ] as const)('leaves out an image %s', async (_label, postId, needsReview, tos) => {
    await image(CLEAN, PUBLISHED, null);
    await image(EXCLUDED, postId, needsReview, tos);
    expect(await servedIds()).toEqual([CLEAN]);
  });

  it.each([
    ['flagged poi', `poi = true`],
    ['flagged minor', `minor = true`],
    ['marked acceptable minor', `"acceptableMinor" = true`],
    ['hard-blocked', `"blockedFor" = 'moderated'`],
  ])('leaves out an image %s, with no review state left', async (_label, set) => {
    await image(CLEAN, PUBLISHED, null);
    await image(EXCLUDED, PUBLISHED, null);
    await harness.pg.exec(`UPDATE "Image" SET ${set} WHERE id = ${EXCLUDED}`);
    expect(await servedIds()).toEqual([CLEAN]);
  });

  it('still serves an image in a published Unsearchable post', async () => {
    await image(CLEAN, PUBLISHED, null);
    await image(EXCLUDED, UNSEARCHABLE, null);
    expect(await servedIds()).toEqual([CLEAN, EXCLUDED]);
  });
});

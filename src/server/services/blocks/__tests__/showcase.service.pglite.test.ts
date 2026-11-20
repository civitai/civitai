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
const R = 4;

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
    "blockedFor" text, "hideMeta" boolean NOT NULL DEFAULT false, "userId" int,
    "modelRestricted" boolean NOT NULL DEFAULT false
  );
  CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished',
    'UnpublishedViolation', 'GatherInterest', 'Deleted');
  CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
  CREATE TABLE "Model" (
    id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 9, poi boolean NOT NULL DEFAULT false, status "ModelStatus" NOT NULL DEFAULT 'Published',
    availability "Availability" NOT NULL DEFAULT 'Public', mode "ModelModifier",
    minor boolean NOT NULL DEFAULT false, "sfwOnly" boolean NOT NULL DEFAULT false,
    "gallerySettings" jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "ModelVersion" (
    id int PRIMARY KEY, "modelId" int NOT NULL, status "ModelStatus" NOT NULL DEFAULT 'Published',
    "publishedAt" timestamp(3),
    availability "Availability" NOT NULL DEFAULT 'Public'
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
  dbMock.dbRead.modelVersion.findUnique.mockImplementation(((
    ...args: Parameters<typeof harness.prisma.modelVersion.findUnique>
  ) => harness.prisma.modelVersion.findUnique(...args)) as never);
  dbMock.dbRead.imageResourceNew.findMany.mockImplementation(((
    ...args: Parameters<typeof harness.prisma.imageResourceNew.findMany>
  ) => harness.prisma.imageResourceNew.findMany(...args)) as never);
});
afterAll(() => harness.stop());

beforeEach(async () => {
  await harness.pg.exec(`
    DELETE FROM "ImageResourceNew"; DELETE FROM "Image";
    DELETE FROM "ModelVersion"; DELETE FROM "Model";
    INSERT INTO "Model" (id) VALUES (1);
    INSERT INTO "ModelVersion" (id, "modelId") VALUES (${VERSION}, 1);
  `);
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

const servedIds = async () =>
  (await getModelShowcaseImages(VERSION)).map((i) => i.id).sort((a, b) => a - b);

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

  it('serves a SFW image to a SFW viewer even past 50 mature ones', async () => {
    // The oldest id: newest-first, the 50 mature ones fill the fetch before it.
    const SFW = 1;
    for (let id = 100; id < 150; id++) await image(id, PUBLISHED, null);
    await harness.pg.exec(`UPDATE "Image" SET "nsfwLevel" = ${R}`);
    await image(SFW, PUBLISHED, null);
    expect(await servedIds()).toEqual([SFW]);
  });

  it('serves a clean image even past 50 newer held ones', async () => {
    // The SQL leaves held rows out before the 50-row fetch, not only the per-row gate after it.
    for (let id = 100; id < 150; id++) await image(id, PUBLISHED, 'csam');
    await image(CLEAN, PUBLISHED, null);
    expect(await servedIds()).toEqual([CLEAN]);
  });

  it('takes the newest images first, so the served set is stable', async () => {
    // Equal reactions keep the fetch order, so the six served are the six highest ids.
    for (let id = 1; id <= 8; id++) await image(id, PUBLISHED, null);
    const images = await getModelShowcaseImages(VERSION);
    expect(images.map((i) => i.id)).toEqual([8, 7, 6, 5, 4, 3]);
  });

  it('still serves an image in a published Unsearchable post', async () => {
    await image(CLEAN, PUBLISHED, null);
    await image(EXCLUDED, UNSEARCHABLE, null);
    expect(await servedIds()).toEqual([CLEAN, EXCLUDED]);
  });
});

describe('getModelShowcaseImages: the version and its model', () => {
  // A signed-in viewer on the red domain asking for R, X and XXX.
  const MATURE_VIEWER = { userId: 7, browsingLevel: 28, domain: 'red' as const };
  const servedMature = async () =>
    (await getModelShowcaseImages(VERSION, MATURE_VIEWER)).map((i) => i.id);

  beforeEach(async () => {
    await image(EXCLUDED, PUBLISHED, null);
    await harness.pg.exec(`UPDATE "Image" SET "nsfwLevel" = ${R}`);
  });

  it('serves an R image of a published model to a viewer who asks for it', async () => {
    expect(await servedMature()).toEqual([EXCLUDED]);
  });

  it('serves a mature image restricted by its base model only to its uploader', async () => {
    await harness.pg.exec(`UPDATE "Image" SET "modelRestricted" = true`);
    expect(await servedMature()).toEqual([]);
    await harness.pg.exec(`UPDATE "Image" SET "userId" = ${MATURE_VIEWER.userId}`);
    expect(await servedMature()).toEqual([EXCLUDED]);
  });

  it.each([
    ['a minor model', `UPDATE "Model" SET minor = true`],
    ['a SFW-only model', `UPDATE "Model" SET "sfwOnly" = true`],
    ['a taken-down model', `UPDATE "Model" SET mode = 'TakenDown'`],
    ['an unpublished model', `UPDATE "Model" SET status = 'Unpublished'`],
    ['a Private model', `UPDATE "Model" SET availability = 'Private'`],
    ['an unpublished version', `UPDATE "ModelVersion" SET status = 'Unpublished'`],
    ['a Private version', `UPDATE "ModelVersion" SET availability = 'Private'`],
    ['a POI model', `UPDATE "Model" SET poi = true`],
    [
      'a version scheduled to publish later',
      `UPDATE "ModelVersion" SET "publishedAt" = now() + interval '1 day'`,
    ],
  ])('serves nothing mature for %s', async (_label, sql) => {
    await harness.pg.exec(sql);
    expect(await servedMature()).toEqual([]);
  });

  // An owner-stored gallery level above the hold cap must not widen it: the cap wins.
  it.each([
    ['a minor model', `minor = true`],
    ['a SFW-only model', `"sfwOnly" = true`],
  ])('serves nothing mature for %s whose stored gallery level allows it', async (_label, set) => {
    await harness.pg.exec(`UPDATE "Model" SET ${set}, "gallerySettings" = '{"level": 31}'`);
    expect(await servedMature()).toEqual([]);
  });

  it('serves nothing for a version that does not exist', async () => {
    await harness.pg.exec(`DELETE FROM "ModelVersion"`);
    expect(await servedMature()).toEqual([]);
  });
});

describe('getModelShowcaseImages: generation data', () => {
  it('sends none of the generation data of an image whose owner hid it, and keeps it on the rest', async () => {
    const HIDDEN = 2;
    // Every field the showcase sends, so each null below can only come from hideMeta.
    const meta = {
      prompt: 'a red fox',
      negativePrompt: 'blurry',
      cfgScale: 7,
      steps: 30,
      seed: 42,
      sampler: 'Euler a',
      clipSkip: 2,
    };
    await image(CLEAN, PUBLISHED, null);
    await image(HIDDEN, PUBLISHED, null);
    await harness.pg.query(`UPDATE "Image" SET meta = $1`, [JSON.stringify(meta)]);
    await harness.pg.exec(`UPDATE "Image" SET "hideMeta" = true WHERE id = ${HIDDEN}`);
    const byId = new Map((await getModelShowcaseImages(VERSION)).map((i) => [i.id, i]));
    expect(byId.get(HIDDEN)).toMatchObject({
      prompt: null,
      negativePrompt: null,
      cfgScale: null,
      steps: null,
      seed: null,
      sampler: null,
      clipSkip: null,
    });
    expect(byId.get(CLEAN)).toMatchObject(meta);
  });
});

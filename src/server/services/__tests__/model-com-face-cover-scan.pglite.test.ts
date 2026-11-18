import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Hooks from '~/server/events/points/hooks';

/**
 * `updateModelNsfwLevels` against real rows: a mature model reaches civitai.com only through a .com
 * cover that passed the image scan. Ids are invented.
 */

vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof Hooks>()),
  onStorySparkPostsHidden: vi.fn(),
  onStorySparkPostsRestored: vi.fn(),
}));
// Hand-listed, as in nsfwLevels.scan-floor.test.ts: the real modules build clients at load.
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');

const PG = 1;
const SFW_LEVELS = 1 | 2;
const MODEL_ID = 7;
const OWNER = 101;
const COVER_ID = 40;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int, nsfw boolean, "nsfwLevel" int,
      "sfwName" text, "sfwCoverImageId" int
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, "nsfwLevel" int, status text);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "modelVersionId" int, "userId" int, "publishedAt" timestamp
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, "nsfwLevel" int, "needsReview" text,
      "acceptableMinor" boolean, "tosViolation" boolean, ingestion text
    );
  `);
  dbMock.dbWrite.$queryRaw.mockImplementation(
    (async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows) as never
  );
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`
    DELETE FROM "Model"; DELETE FROM "ModelVersion"; DELETE FROM "Post"; DELETE FROM "Image";
    INSERT INTO "Model" VALUES (${MODEL_ID}, ${OWNER}, true, 28, 'Retro Style', ${COVER_ID});
    INSERT INTO "ModelVersion" VALUES (1, ${MODEL_ID}, 28, 'Published');
    INSERT INTO "Post" VALUES (1, 1, ${OWNER}, now());
  `);
});

/** The model's .com levels after the recompute, for a .com cover with these flags. */
async function comLevelsWithCover(flags: { acceptableMinor?: boolean; tosViolation?: boolean }) {
  await db.query(`INSERT INTO "Image" VALUES ($1, 1, $2, NULL, $3, $4, 'Scanned')`, [
    COVER_ID,
    PG,
    flags.acceptableMinor ?? false,
    flags.tosViolation ?? false,
  ]);
  await updateModelNsfwLevels([MODEL_ID]);
  const { rows } = await db.query<{ nsfwLevel: number }>(
    `SELECT "nsfwLevel" FROM "Model" WHERE id = $1`,
    [MODEL_ID]
  );
  return rows[0].nsfwLevel & SFW_LEVELS;
}

describe('a mature model on civitai.com through its .com cover', () => {
  it('is listed on .com with a clean PG cover', async () => {
    expect(await comLevelsWithCover({})).toBe(PG);
  });

  it('stays off .com when its cover is flagged for a minor', async () => {
    expect(await comLevelsWithCover({ acceptableMinor: true })).toBe(0);
  });

  it('stays off .com when its cover is a ToS violation', async () => {
    expect(await comLevelsWithCover({ tosViolation: true })).toBe(0);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type { Prisma } from '@prisma/client';
import type * as SystemCache from '~/server/services/system-cache';

/**
 * step=bust through the real tagIdsForImagesCache: its lookup, with the cache cluster faked and the
 * tag rows on an in-memory Postgres. A selected image (child label from Rekognition, WD14 also
 * tagged) is rewritten with the child tag id and verified, so the run does not stop.
 */

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBlockedBrowsingTags: vi.fn(),
  getBrowsingSettingAddons: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/search-index/queue-models-reindex', () => ({ queueModelsReindex: vi.fn() }));

const { getBlockedBrowsingTags, getBrowsingSettingAddons } = await import(
  '~/server/services/system-cache'
);
const { DEFAULT_BROWSING_SETTINGS_ADDONS } = await import(
  '~/shared/constants/browsing-settings-addons'
);
const { tagIdsForImagesCache } = await import('~/server/redis/caches');
const { runChildLabelReindex } = await import('~/server/services/child-label-reindex.service');

const CHILD = childBrowsingTagIds[0];
const WD14_TAG = 9001;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14');
    CREATE TABLE "TagsOnImageDetails" (
      "imageId" int NOT NULL, "tagId" int NOT NULL, source "TagSource" NOT NULL,
      disabled boolean NOT NULL DEFAULT false
    );
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", source) VALUES
      (501, ${CHILD}, 'Rekognition'), (501, ${WD14_TAG}, 'WD14'),
      (502, ${CHILD}, 'Rekognition'), (502, ${WD14_TAG}, 'WD14');
  `);
});
afterAll(() => db.close());

// The route's SQL arrives as Prisma.Sql; the cache's own row read is a tagged template with the id
// array as its one value. Both run on PGlite, so `fromWrite` reaching dbWrite reads the same rows.
const runQuery = (async (sqlOrStrings: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
  if ('text' in sqlOrStrings)
    return (await db.query(sqlOrStrings.text, sqlOrStrings.values as unknown[])).rows;
  return (
    await db.query(
      `SELECT "imageId", source, "tagId" FROM "TagsOnImageDetails"
       WHERE "imageId" = ANY($1::int[]) AND disabled = false`,
      [values[0]]
    )
  ).rows;
}) as never;
const tagRows = (async (args: { where: { id: { in: number[] } } }) =>
  args.where.id.in.map((id) => ({
    id,
    name: `tag-${id}`,
    nsfwLevel: 1,
    type: 'Label',
    unlisted: false,
  }))) as never;

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  vi.mocked(getBlockedBrowsingTags).mockResolvedValue([]);
  vi.mocked(getBrowsingSettingAddons).mockResolvedValue(DEFAULT_BROWSING_SETTINGS_ADDONS);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(runQuery);
    client.tag.findMany.mockImplementation(tagRows);
  }
});

describe('child-label reindex bust through the real tag-id cache', () => {
  it('rewrites a selected image with its child tag and verifies every entry', async () => {
    const result = await runChildLabelReindex({ step: 'bust', dryRun: false, chunkSize: 500 });
    expect(result).toMatchObject({ images: 2, refreshed: 2, verified: 2 });
    expect(result).not.toHaveProperty('aborted');
    const entries = await tagIdsForImagesCache.fetch([501, 502], { bypassLocal: true });
    expect(entries[501]?.tags).toEqual(expect.arrayContaining([CHILD, WD14_TAG]));
  });
});

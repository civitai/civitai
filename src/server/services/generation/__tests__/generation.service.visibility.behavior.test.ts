import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `generation.getGenerationData` and `/api/generation/data` for an image, with the real
 * visibility query on an in-process Postgres and the real media-link rule: a hidden image is not
 * found, and a viewer who may not see the media gets the settings without its source links.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn(), mGet: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  getLinkedVaeIds: vi.fn(),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: vi.fn(async () => false) }));

import type { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { getGenerationData } from '~/server/services/generation/generation.service';
import type { MediaViewer } from '~/server/utils/image-media-visibility';
import type { SessionUser } from '~/types/session';

const OWNER = 10;
const STRANGER = 20;
const SOURCE = 'https://orchestration-new.civitai.com/source.png';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
      "needsReview" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}', "scanJobs" jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      Array.isArray(first)
        ? raw.queryRaw(first as TemplateStringsArray, ...values)
        : (await db.query((first as Prisma.Sql).text, (first as Prisma.Sql).values)).rows
  );
});

beforeEach(async () => {
  await db.exec(`TRUNCATE "Image", "Post", "CollectionContributor";`);
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    id: 1,
    type: 'image',
    url: 'image-own-url',
    meta: {
      prompt: 'a prompt',
      steps: 30,
      sourceImage: { url: SOURCE, width: 512, height: 512 },
      comfy: JSON.stringify({ prompt: { '1': { inputs: { image: `${SOURCE}?comfy` } } } }),
    },
    hideMeta: false,
    userId: OWNER,
    height: 1024,
    width: 1024,
    createdAt: new Date('2026-01-01'),
  } as never);
});

async function seed(post: string, nsfwLevel = 1) {
  await db.exec(`
    INSERT INTO "Post" (id, "userId", "publishedAt", availability) VALUES (1, ${OWNER}, ${post});
    INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel") VALUES (1, ${OWNER}, 1, ${nsfwLevel});
  `);
}
const PUBLISHED = `now() - interval '1 day', 'Public'`;
const PRIVATE = `now() - interval '1 day', 'Private'`;

function fetchAs(userId: number | undefined, canViewNsfw: boolean) {
  const user = userId ? ({ id: userId, isModerator: false } as SessionUser) : undefined;
  const mediaViewer = { user, features: { canViewNsfw }, req: { headers: {} } } as MediaViewer;
  return getGenerationData({
    query: { type: 'image', id: 1, generation: false },
    user,
    mediaViewer,
  });
}

describe('generation.getGenerationData for an image', () => {
  it('is not found for a stranger when the image is in a Private post', async () => {
    await seed(PRIVATE);
    await expect(fetchAs(STRANGER, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fetchAs(undefined, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is served to the owner of that Private post', async () => {
    await seed(PRIVATE);
    const data = await fetchAs(OWNER, false);
    expect(data.params.prompt).toBe('a prompt');
  });

  it('withholds source and own media from a signed-out viewer of an R image', async () => {
    await seed(PUBLISHED, 4);
    const data = await fetchAs(undefined, false);
    const json = JSON.stringify(data);
    expect(json).not.toContain(SOURCE);
    expect(json).not.toContain('image-own-url');
    expect(data.params.prompt).toBe('a prompt');
    expect(data.params.steps).toBe(30);
  });

  it('keeps them for a signed-in viewer on the mature domain', async () => {
    await seed(PUBLISHED, 4);
    const data = await fetchAs(STRANGER, true);
    const json = JSON.stringify(data);
    expect(json).toContain(`${SOURCE}?comfy`);
    expect(data.remixOf?.url).toBe('image-own-url');
  });
});

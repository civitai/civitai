import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';

/**
 * A model version's level is the bit_or of its owner's first 20 published images, by post id then
 * image index. Reordering or unpublishing can change which images are in that set without changing
 * any image's own level, so the edit itself has to queue the post for `update-nsfw-levels`.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userPostCountCache: { refresh: vi.fn() },
  userImageVideoCountCaches: { refresh: vi.fn() },
}));

const { jobQueueJobs } = await import('~/server/jobs/job-queue');
const { reorderPostImages, unpublishPostAsModerator } = await import(
  '~/server/services/post.service'
);
const { enqueueJobs } = await import('~/server/services/job-queue.service');
const { modelsSearchIndex } = await import('~/server/search-index/models.search-index');
const queueModelSearchUpdate = vi.spyOn(modelsSearchIndex, 'queueUpdate').mockResolvedValue();
const { EntityType, JobQueueType } = await import('~/shared/utils/prisma/enums');

const nsfwJob = jobQueueJobs.find((j) => j.name === 'update-nsfw-levels')!;
const runNsfwJob = () => nsfwJob.run({} as Parameters<typeof nsfwJob.run>[0]).result;

const query = (text: string, values: unknown[] = []) => holder.db.query(text, values);
const raw = () => pgliteRaw(holder.db);
const ids = (where: { id?: { in: number[] } }) => where.id?.in ?? [];

function wireDb() {
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$executeRaw.mockImplementation(((
      ...a: Parameters<ReturnType<typeof pgliteRaw>['executeRaw']>
    ) => raw().executeRaw(...a)) as never);
    client.$queryRaw.mockImplementation((async (
      ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
    ) => {
      const [first] = a;
      const text = Array.isArray(first) ? first.join('') : (first as { text: string }).text;
      // Post.nsfwLevel's own recompute reads the scan-floor tables and is not covered here; the
      // version and model levels under test do not depend on it.
      if (text.includes('WITH next AS')) return [];
      return raw().queryRaw(...a);
    }) as never);
    client.$executeRawUnsafe.mockImplementation(
      (async (text: string) => (await query(text)).affectedRows ?? 0) as never
    );
    client.post.findMany.mockImplementation(
      (async ({ where }: { where: { id?: { in: number[] } } }) =>
        (await query(`SELECT "modelVersionId" FROM "Post" WHERE id = ANY($1)`, [ids(where)]))
          .rows) as never
    );
    client.modelVersion.findMany.mockImplementation(
      (async ({ where }: { where: { id?: { in: number[] } } }) =>
        (await query(`SELECT "modelId" FROM "ModelVersion" WHERE id = ANY($1)`, [ids(where)]))
          .rows) as never
    );
    client.image.update.mockImplementation((({
      where,
      data,
    }: {
      where: { id: number; postId: number };
      data: { index: number };
    }) =>
      query(`UPDATE "Image" SET index = $1 WHERE id = $2 AND "postId" = $3`, [
        data.index,
        where.id,
        where.postId,
      ])) as never);
    client.jobQueue.findMany.mockImplementation(
      (async () =>
        (
          await query(
            `SELECT "entityId", "entityType", type FROM "JobQueue" WHERE type = 'UpdateNsfwLevel' AND "entityType" <> 'Collection'`
          )
        ).rows) as never
    );
    client.jobQueue.deleteMany.mockImplementation((async ({
      where,
    }: {
      where: { type: string; entityType: string; entityId: { in: number[] } };
    }) =>
      query(
        `DELETE FROM "JobQueue" WHERE type = $1 AND "entityType" = $2 AND "entityId" = ANY($3)`,
        [where.type, where.entityType, where.entityId.in]
      )) as never);
  }
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'ModelVersion', 'Model', 'Collection');
    CREATE TYPE "JobQueueType" AS ENUM ('UpdateNsfwLevel', 'CleanIfEmpty', 'CleanUp');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, nsfw boolean NOT NULL,
      "nsfwLevel" int NOT NULL, "sfwName" text, "sfwCoverImageId" int
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL, "nsfwLevel" int NOT NULL
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int, "model3dId" int,
      "publishedAt" timestamp(3), metadata jsonb, "nsfwLevel" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int NOT NULL, index int NOT NULL, "nsfwLevel" int NOT NULL,
      "needsReview" text, "acceptableMinor" boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false, ingestion text NOT NULL DEFAULT 'Scanned'
    );
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(), PRIMARY KEY ("entityId", "entityType", type)
    );
    CREATE FUNCTION update_post_nsfw_levels(int[]) RETURNS void LANGUAGE sql AS 'SELECT';
  `);
});
afterAll(() => holder.db.close());
// The job's batcher logs a failed SQL step and carries on, which would read as "level unchanged".
afterEach(() =>
  expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
    expect.objectContaining({ name: 'update-nsfw-levels-batcher' })
  )
);

const OWNER = 10;
const MODEL = 1;
const VERSION = 100;
const { R, PG } = NsfwLevel;

beforeEach(async () => {
  vi.clearAllMocks();
  wireDb();
  await holder.db.exec(`TRUNCATE "Model", "ModelVersion", "Post", "Image", "JobQueue"`);
  await query(
    `INSERT INTO "Model" (id, "userId", status, nsfw, "nsfwLevel") VALUES ($1, $2, 'Published', false, $3)`,
    [MODEL, OWNER, R]
  );
  await query(
    `INSERT INTO "ModelVersion" (id, "modelId", status, "nsfwLevel") VALUES ($1, $2, 'Published', $3)`,
    [VERSION, MODEL, R]
  );
});

async function addPost(id: number, levels: number[]) {
  await query(
    `INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES ($1, $2, $3, now())`,
    [id, OWNER, VERSION]
  );
  for (const [index, level] of levels.entries())
    await query(`INSERT INTO "Image" (id, "postId", index, "nsfwLevel") VALUES ($1, $2, $3, $4)`, [
      id * 100 + index,
      id,
      index,
      level,
    ]);
}

async function levels() {
  const version = await query(`SELECT "nsfwLevel" FROM "ModelVersion" WHERE id = $1`, [VERSION]);
  const model = await query(`SELECT "nsfwLevel" FROM "Model" WHERE id = $1`, [MODEL]);
  return {
    version: (version.rows[0] as { nsfwLevel: number }).nsfwLevel,
    model: (model.rows[0] as { nsfwLevel: number }).nsfwLevel,
  };
}

describe('model version level after a post edit', () => {
  const POST = 1000;
  // 20 R images fill the counted set; the PG image at index 20 is outside it.
  const twentyRThenPg = [...Array(20).fill(R), PG];

  it('the job lifts the level once the post is queued (control: the harness can go green)', async () => {
    await addPost(POST, twentyRThenPg);
    await query(`UPDATE "Image" SET index = 21 WHERE id = $1`, [POST * 100]);
    await query(`UPDATE "Image" SET index = 0 WHERE id = $1`, [POST * 100 + 20]);
    await enqueueJobs([
      { entityId: POST, entityType: EntityType.Post, type: JobQueueType.UpdateNsfwLevel },
    ]);

    await runNsfwJob();

    expect(await levels()).toEqual({ version: R | PG, model: R | PG });
  });

  it('reordering a PG image into the first 20 lifts the version and model', async () => {
    await addPost(POST, twentyRThenPg);
    const imageIds = twentyRThenPg.map((_, index) => POST * 100 + index);
    const pgFirst = [imageIds[20], ...imageIds.slice(0, 20)];

    await reorderPostImages({ id: POST, imageIds: pgFirst });
    await runNsfwJob();

    expect(await levels()).toEqual({ version: R | PG, model: R | PG });
    expect(queueModelSearchUpdate).toHaveBeenCalledWith([{ id: MODEL, action: 'Update' }]);
  });

  describe('unpublishing', () => {
    beforeEach(async () => {
      await addPost(POST, [PG]);
      await addPost(POST + 1, [R]);
      await query(`UPDATE "ModelVersion" SET "nsfwLevel" = $1`, [R | PG]);
      await query(`UPDATE "Model" SET "nsfwLevel" = $1`, [R | PG]);
    });

    it('a recompute with the PG post still published keeps PG (control)', async () => {
      await enqueueJobs([
        { entityId: POST, entityType: EntityType.Post, type: JobQueueType.UpdateNsfwLevel },
      ]);
      await runNsfwJob();

      expect(await levels()).toEqual({ version: R | PG, model: R | PG });
    });

    it('the post holding the only PG image drops PG from the version and model', async () => {
      await unpublishPostAsModerator({ id: POST, userId: 1, reason: 'test' });
      await runNsfwJob();

      expect(await levels()).toEqual({ version: R, model: R });
    });
  });
});

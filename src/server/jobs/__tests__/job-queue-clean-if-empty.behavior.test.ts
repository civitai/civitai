import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { jobQueueJobs } from '~/server/jobs/job-queue';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);

const job = jobQueueJobs.find((j) => j.name === 'job-queue-clean-if-empty')!;
const runJob = () => job.run({} as Parameters<typeof job.run>[0]).result;

const OWNER = 7;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published', 'Unpublished');
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "ModelVersion" (
      "id" integer PRIMARY KEY, "modelId" integer NOT NULL, "status" "ModelStatus" NOT NULL
    );
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer NOT NULL, "modelVersionId" integer);
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "postId" integer REFERENCES "Post"(id));
    CREATE TABLE "StorylineChapter" (
      "id" integer PRIMARY KEY,
      "postId" integer UNIQUE REFERENCES "Post"(id) ON DELETE SET NULL
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.exec(
    `TRUNCATE "StorylineChapter", "Image", "Post", "ModelVersion", "Model" CASCADE`
  );
});

function queuePosts(...postIds: number[]) {
  dbMock.dbRead.jobQueue.findMany.mockResolvedValue(
    postIds.map((entityId) => ({
      entityId,
      entityType: EntityType.Post,
      type: JobQueueType.CleanIfEmpty,
      createdAt: new Date('2026-01-01'),
    }))
  );
}

async function remainingPostIds() {
  const { rows } = await holder.db.query<{ id: number }>(`SELECT id FROM "Post" ORDER BY id`);
  return rows.map((r) => r.id);
}

describe('job-queue-clean-if-empty', () => {
  it('deletes an empty post but keeps one that still has images', async () => {
    await holder.db.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (1, ${OWNER}), (2, ${OWNER});
      INSERT INTO "Image" (id, "postId") VALUES (10, 2);
    `);
    queuePosts(1, 2);

    await runJob();

    expect(await remainingPostIds()).toEqual([2]);
  });

  it('keeps an empty post that backs a storyline chapter', async () => {
    await holder.db.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (1, ${OWNER}), (2, ${OWNER});
      INSERT INTO "StorylineChapter" (id, "postId") VALUES (50, 1);
    `);
    queuePosts(1, 2);

    await runJob();

    expect(await remainingPostIds()).toEqual([1]);
  });

  it('keeps the empty anchor post of the owner’s published version', async () => {
    await holder.db.exec(`
      INSERT INTO "Model" (id, "userId") VALUES (3, ${OWNER});
      INSERT INTO "ModelVersion" (id, "modelId", status) VALUES (30, 3, 'Published');
      INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (1, ${OWNER}, 30), (2, 99, 30);
    `);
    queuePosts(1, 2);

    await runJob();

    // Another user's empty post on the same version is not an anchor.
    expect(await remainingPostIds()).toEqual([1]);
  });
});

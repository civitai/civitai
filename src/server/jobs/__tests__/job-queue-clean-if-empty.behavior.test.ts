import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
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
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);

const job = jobQueueJobs.find((j) => j.name === 'job-queue-clean-if-empty')!;
const runJob = () => job.run({} as Parameters<typeof job.run>[0]).result;

const OWNER = 7;
const HELD = 8; // named on a pending report
const MARKED = 9; // held by a hold marker
const BAN_NOTE = 10; // banned with a note naming CSAM, no hold: not held

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published', 'Unpublished');
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "ModelVersion" (
      "id" integer PRIMARY KEY, "modelId" integer NOT NULL, "status" "ModelStatus" NOT NULL
    );
    CREATE TABLE "Post" (
      "id" integer PRIMARY KEY, "userId" integer NOT NULL, "modelVersionId" integer,
      "nsfwLevel" integer NOT NULL DEFAULT 0
    );
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY, "postId" integer REFERENCES "Post"(id), "userId" integer,
      "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
    CREATE TABLE "Thread" (
      id int PRIMARY KEY, "postId" int UNIQUE REFERENCES "Post"(id) ON DELETE CASCADE,
      "parentThreadId" int, "rootThreadId" int, "commentId" int, metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "CommentV2" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE
    );
    INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
    INSERT INTO "EvidenceHold" VALUES (${MARKED});
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb, "bannedAt" timestamp(3));
    CREATE TABLE "ModActivity" (
      "entityType" text, "entityId" int, activity text, "createdAt" timestamp(3)
    );
    INSERT INTO "User" VALUES
      (${BAN_NOTE}, '{"banDetails": {"detailsInternal": "csam"}}', now() - interval '1 day');
    CREATE TABLE "StorylineChapter" (
      "id" integer PRIMARY KEY,
      "postId" integer UNIQUE REFERENCES "Post"(id) ON DELETE SET NULL
    );
    CREATE TABLE "PostText" (
      "id" integer PRIMARY KEY,
      "postId" integer NOT NULL REFERENCES "Post"(id) ON DELETE CASCADE
    );
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete', 'ImageStorageDelete', 'UpdateNsfwLevel');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
  await holder.db.exec(imageUseTablesSql);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.exec(
    `TRUNCATE "StorylineChapter", "PostText", "Image", "Thread", "Post", "ModelVersion", "Model",
      "Report", "PostReport", "JobQueue" CASCADE`
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

  it('keeps a post with text items and no images, such as a chapter draft', async () => {
    await holder.db.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (1, ${OWNER}), (2, ${OWNER});
      INSERT INTO "PostText" (id, "postId") VALUES (60, 1);
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

  it('deletes the empty post of an owner banned with a CSAM note and no hold', async () => {
    await holder.db.exec(`INSERT INTO "Post" (id, "userId") VALUES (1, ${BAN_NOTE})`);
    queuePosts(1);

    await runJob();

    expect(await remainingPostIds()).toEqual([]);
  });

  it('leaves an empty post in a child-safety case unqueued, so refilling it saves it', async () => {
    await holder.db.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (1, ${OWNER});
      INSERT INTO "Report" (id, reason, status) VALUES (70, 'CSAM', 'Pending');
      INSERT INTO "PostReport" ("postId", "reportId") VALUES (1, 70);
    `);
    queuePosts(1);

    await runJob();

    expect(await remainingPostIds()).toEqual([1]);
    const { rows } = await holder.db.query(`SELECT 1 FROM "JobQueue" WHERE type = 'PendingDelete'`);
    expect(rows).toEqual([]);
  });

  it.each([HELD, MARKED])("leaves a held owner's empty post (owner %i)", async (owner) => {
    await holder.db.exec(`INSERT INTO "Post" (id, "userId") VALUES (1, ${owner})`);
    queuePosts(1);

    await runJob();

    expect(await remainingPostIds()).toEqual([1]);
  });

  it.each([HELD, MARKED, OWNER])(
    "takes a comment on the deleted post's thread (author %i)",
    async (author) => {
      await holder.db.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (1, ${OWNER});
      INSERT INTO "Thread" (id, "postId") VALUES (100, 1);
      INSERT INTO "CommentV2" VALUES (1, ${author}, 100);
    `);
      queuePosts(1);

      await runJob();

      expect(await remainingPostIds()).toEqual([]);
      const { rows } = await holder.db.query<{ id: number }>(`SELECT id FROM "CommentV2"`);
      expect(rows).toEqual([]);
    }
  );
});

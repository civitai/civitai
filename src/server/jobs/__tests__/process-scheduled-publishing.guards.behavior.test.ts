import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import {
  scheduledPostsDueSql,
  scheduledPostsGoLiveSql,
  scheduledVersionsDueSql,
  scheduledVersionsGoLiveSql,
} from '~/server/jobs/process-scheduled-publishing';

const ORDINARY = 2;
const OWNER = 7;
const NOW = new Date('2026-10-28T00:00:00Z');
const DUE = '2026-10-27T00:00:00Z';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int, status text NOT NULL, "publishedAt" timestamp(3), meta jsonb,
      "lastVersionAt" timestamp(3)
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL,
      "publishedAt" timestamp(3), availability text
    );
    CREATE TABLE "ModelFile" (
      id serial PRIMARY KEY, "modelVersionId" int NOT NULL,
      "pickleScanResult" text NOT NULL DEFAULT 'Success',
      "virusScanResult" text NOT NULL DEFAULT 'Success'
    );
    CREATE TABLE "PaidAccess" (
      "entityType" text, "entityId" int, "timeframeDays" int, "endsAt" timestamp(3)
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int, "modelVersionId" int, "publishedAt" timestamp(3),
      metadata jsonb NOT NULL DEFAULT '{}'
    );
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Model", "ModelVersion", "ModelFile", "Post";
    INSERT INTO "Model" (id, "userId", status, "publishedAt", meta) VALUES
      (${ORDINARY}, ${OWNER}, 'Scheduled', '${DUE}', '{}');
    INSERT INTO "ModelVersion" VALUES (20, ${ORDINARY}, 'Scheduled', '${DUE}', 'Private');
    INSERT INTO "ModelFile" ("modelVersionId") VALUES (20);
    INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (200, ${OWNER}, 20);
  `);
});

const run = (sql: { text: string; values: unknown[] }) => db.query(sql.text, sql.values);

describe('process-scheduled-publishing on a version with a file that failed its scan', () => {
  const ids = async (sql: { text: string; values: unknown[] }) =>
    (await run(sql)).rows.map((r) => (r as { id: number }).id);

  beforeEach(async () => {
    // The ordinary model's version gets a second file that failed its virus scan, model 4's only
    // file failed its pickle scan; model 3's errored file is not a failure.
    await db.exec(`
      INSERT INTO "ModelFile" ("modelVersionId", "virusScanResult") VALUES (20, 'Danger');
      INSERT INTO "Model" (id, "userId", status, "publishedAt", meta)
        VALUES (3, ${OWNER}, 'Scheduled', '${DUE}', '{}');
      INSERT INTO "ModelVersion" VALUES (30, 3, 'Scheduled', '${DUE}', 'Private');
      INSERT INTO "ModelFile" ("modelVersionId", "pickleScanResult") VALUES (30, 'Error');
      INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (300, ${OWNER}, 30);
      INSERT INTO "Model" (id, "userId", status, "publishedAt", meta)
        VALUES (4, ${OWNER}, 'Scheduled', '${DUE}', '{}');
      INSERT INTO "ModelVersion" VALUES (40, 4, 'Scheduled', '${DUE}', 'Private');
      INSERT INTO "ModelFile" ("modelVersionId", "pickleScanResult") VALUES (40, 'Danger');
      INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (400, ${OWNER}, 40);
    `);
  });

  it('neither selects nor publishes it, nor its post', async () => {
    expect(await ids(scheduledVersionsDueSql(NOW))).toEqual([30]);
    expect(await ids(scheduledPostsDueSql(NOW))).toEqual([300]);
    const { rows } = await run(
      scheduledPostsGoLiveSql(
        [
          { postId: 200, versionId: 20 },
          { postId: 300, versionId: 30 },
          { postId: 400, versionId: 40 },
        ],
        NOW
      )
    );
    expect(rows).toEqual([{ id: 300, userId: OWNER }]);
    expect(await ids(scheduledVersionsGoLiveSql([20, 30, 40], NOW))).toEqual([30]);
  });
});

describe('process-scheduled-publishing on a post its delete keeps', () => {
  beforeAll(async () => {
    await db.exec(
      `CREATE TABLE "JobQueue" (type text, "entityType" text, "entityId" int, data jsonb)`
    );
    await db.exec(
      readFileSync(
        `${__dirname}/../../../../packages/civitai-db-schema/prisma/migrations/20271126120000_post_pending_delete_publish_guard/migration.sql`,
        'utf8'
      )
    );
  });
  afterAll(() => db.exec(`DROP TRIGGER trg_post_pending_delete_keep_unpublished ON "Post"`));

  it('neither returns nor publishes a post the publish guard keeps, and publishes the other', async () => {
    await db.exec(`
      INSERT INTO "Post" (id, "userId", "modelVersionId", metadata) VALUES
        (201, ${OWNER}, 20, '{"unpublishedReason": "pending-delete"}');
      INSERT INTO "JobQueue" VALUES ('PendingDelete', 'Post', 201, '{}');
    `);
    const { rows } = await run(
      scheduledPostsGoLiveSql(
        [
          { postId: 200, versionId: 20 },
          { postId: 201, versionId: 20 },
        ],
        NOW
      )
    );
    expect(rows).toEqual([{ id: 200, userId: OWNER }]);
    const posts = await db.query<{ id: number; live: boolean; reason: string | null }>(
      `SELECT id, "publishedAt" IS NOT NULL AS live, metadata ->> 'unpublishedReason' AS reason
       FROM "Post" WHERE id IN (200, 201) ORDER BY id`
    );
    expect(posts.rows).toEqual([
      { id: 200, live: true, reason: null },
      { id: 201, live: false, reason: 'pending-delete' },
    ]);
  });
});

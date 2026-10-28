import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import {
  lastVersionAtSql,
  scheduledModelsDueSql,
  scheduledModelsGoLiveSql,
  scheduledPostsDueSql,
  scheduledPostsGoLiveSql,
  scheduledVersionsDueSql,
  scheduledVersionsGoLiveSql,
} from '~/server/jobs/process-scheduled-publishing';

/**
 * A model a content wipe kept carries a removal record; scheduled for later before the wipe, it must
 * not go live on its own, nor be picked up by the job's selects. Its statements run against Postgres.
 */

const KEPT = 1;
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
    CREATE TABLE "ModelFile" (id serial PRIMARY KEY, "modelVersionId" int NOT NULL);
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
      (${KEPT}, ${OWNER}, 'Scheduled', '${DUE}', '{"removedWithOwner": true, "statusBeforeRemoval": "Draft"}'),
      (${ORDINARY}, ${OWNER}, 'Scheduled', '${DUE}', '{}');
    INSERT INTO "ModelVersion" VALUES
      (10, ${KEPT}, 'Scheduled', '${DUE}', 'Private'),
      (20, ${ORDINARY}, 'Scheduled', '${DUE}', 'Private');
    INSERT INTO "ModelFile" ("modelVersionId") VALUES (10), (20);
    INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (100, ${OWNER}, 10), (200, ${OWNER}, 20);
  `);
});

const run = (sql: { text: string; values: unknown[] }) => db.query(sql.text, sql.values);
const statuses = async (table: string) =>
  Object.fromEntries(
    (await db.query<{ id: number; status: string }>(`SELECT id, status FROM "${table}"`)).rows.map(
      (r) => [r.id, r.status]
    )
  );

describe('process-scheduled-publishing on a model a content wipe kept', () => {
  it('leaves the kept model scheduled and publishes the ordinary one', async () => {
    // The job publishes the versions first; a model goes live only with a published version.
    await db.exec(`UPDATE "ModelVersion" SET status = 'Published'`);
    await run(scheduledModelsGoLiveSql([KEPT, ORDINARY], NOW));
    expect(await statuses('Model')).toEqual({ [KEPT]: 'Scheduled', [ORDINARY]: 'Published' });
  });

  it("leaves the kept model's scheduled version and publishes the ordinary one", async () => {
    const { rows } = await run(scheduledVersionsGoLiveSql([10, 20], NOW));
    expect(rows).toEqual([{ id: 20 }]);
    expect(await statuses('ModelVersion')).toEqual({ 10: 'Scheduled', 20: 'Published' });
  });

  it('selects only the ordinary model, version and post as due', async () => {
    const ids = async (sql: { text: string; values: unknown[] }) =>
      (await run(sql)).rows.map((r) => (r as { id: number }).id);
    expect(await ids(scheduledModelsDueSql(NOW))).toEqual([ORDINARY]);
    expect(await ids(scheduledVersionsDueSql(NOW))).toEqual([20]);
    expect(await ids(scheduledPostsDueSql(NOW))).toEqual([200]);
  });

  it('stamps lastVersionAt on the ordinary model only', async () => {
    await run(lastVersionAtSql([KEPT, ORDINARY]));
    const { rows } = await db.query<{ id: number; stamped: boolean }>(
      `SELECT id, "lastVersionAt" IS NOT NULL AS stamped FROM "Model" ORDER BY id`
    );
    expect(rows).toEqual([
      { id: KEPT, stamped: false },
      { id: ORDINARY, stamped: true },
    ]);
  });

  it("leaves the kept model's post unpublished and publishes the ordinary one", async () => {
    const locked = [
      { postId: 100, versionId: 10 },
      { postId: 200, versionId: 20 },
    ];
    const { rows } = await run(scheduledPostsGoLiveSql(locked, NOW));
    expect(rows).toEqual([{ id: 200, userId: OWNER }]);
    const posts = await db.query<{ id: number; live: boolean }>(
      `SELECT id, "publishedAt" IS NOT NULL AS live FROM "Post" ORDER BY id`
    );
    expect(posts.rows).toEqual([
      { id: 100, live: false },
      { id: 200, live: true },
    ]);
  });
});

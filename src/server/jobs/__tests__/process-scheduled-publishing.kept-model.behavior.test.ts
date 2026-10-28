import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import {
  scheduledModelsGoLiveSql,
  scheduledVersionsGoLiveSql,
} from '~/server/jobs/process-scheduled-publishing';

/**
 * A model a content wipe kept carries a removal record; scheduled for later before the wipe, it must
 * not go live on its own. The job's go-live statements run against Postgres.
 */

const KEPT = 1;
const ORDINARY = 2;
const NOW = new Date('2026-10-28T00:00:00Z');
const DUE = '2026-10-27T00:00:00Z';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, status text NOT NULL, "publishedAt" timestamp(3), meta jsonb);
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL,
      "publishedAt" timestamp(3), availability text
    );
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Model", "ModelVersion";
    INSERT INTO "Model" VALUES
      (${KEPT}, 'Scheduled', '${DUE}', '{"removedWithOwner": true, "statusBeforeRemoval": "Draft"}'),
      (${ORDINARY}, 'Scheduled', '${DUE}', '{}');
    INSERT INTO "ModelVersion" VALUES
      (10, ${KEPT}, 'Scheduled', '${DUE}', 'Private'),
      (20, ${ORDINARY}, 'Scheduled', '${DUE}', 'Private');
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
});

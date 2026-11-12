import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import {
  scheduledModelsDueSql,
  scheduledPostsDueSql,
  scheduledVersionsDueSql,
} from '~/server/jobs/process-scheduled-publishing';

/**
 * The scheduled job's backstop for the pre-publish gate: a scheduled version on a gated base model
 * is due only once the gate passed that version. Its selects run against Postgres.
 */

const OWNER = 7;
const NOW = new Date('2026-11-09T00:00:00Z');
const DUE = '2026-11-08T00:00:00Z';
// A later owner run moves `state` on, so only the cleared ids decide.
const passed = (passedVersionIds: number[]) =>
  JSON.stringify({ prePublishGate: { state: 'pending', passedVersionIds } });

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int, status text NOT NULL, "publishedAt" timestamp(3), meta jsonb
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL,
      "publishedAt" timestamp(3), "baseModel" text NOT NULL
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
      id int PRIMARY KEY, "userId" int, "modelVersionId" int, "publishedAt" timestamp(3)
    );
  `);
});
afterAll(() => db.close());

// 1: gated, never passed. 2: gated, passed. 3: gated, a pass for another version only.
// 4: an ungated base model with no gate record (control). 5: gated, a run marked passed that
// cleared no ids. 6: two scheduled versions, only 60 cleared. 7: cleared, but not due yet.
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Model", "ModelVersion", "ModelFile", "Post";
    INSERT INTO "Model" (id, "userId", status, "publishedAt", meta) VALUES
      (1, ${OWNER}, 'Scheduled', '${DUE}', '{}'),
      (2, ${OWNER}, 'Scheduled', '${DUE}', '${passed([20])}'),
      (3, ${OWNER}, 'Scheduled', '${DUE}', '${passed([99])}'),
      (4, ${OWNER}, 'Scheduled', '${DUE}', NULL),
      (5, ${OWNER}, 'Scheduled', '${DUE}', '{"prePublishGate": {"state": "passed", "versionIds": [50]}}'),
      (6, ${OWNER}, 'Scheduled', '${DUE}', '${passed([60])}'),
      (7, ${OWNER}, 'Scheduled', '2999-01-01T00:00:00Z', '${passed([70])}');
    INSERT INTO "ModelVersion" VALUES
      (10, 1, 'Scheduled', '${DUE}', 'Fibo 2.0'),
      (20, 2, 'Scheduled', '${DUE}', 'Fibo 2.0'),
      (30, 3, 'Scheduled', '${DUE}', 'Fibo 2.0'),
      (40, 4, 'Scheduled', '${DUE}', 'SDXL 1.0'),
      (50, 5, 'Scheduled', '${DUE}', 'Fibo 2.0'),
      (60, 6, 'Scheduled', '${DUE}', 'Fibo 2.0'),
      (61, 6, 'Scheduled', '${DUE}', 'Fibo 2.0'),
      (70, 7, 'Scheduled', '2999-01-01T00:00:00Z', 'Fibo 2.0');
    INSERT INTO "ModelFile" ("modelVersionId") VALUES (10), (20), (30), (40), (50), (60), (61), (70);
    INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES
      (100, ${OWNER}, 10), (200, ${OWNER}, 20), (300, ${OWNER}, 30), (400, ${OWNER}, 40), (500, ${OWNER}, 50);
  `);
});

const ids = async (sql: { text: string; values: unknown[] }) =>
  ((await db.query<{ id: number }>(sql.text, sql.values)).rows.map((r) => r.id) as number[]).sort(
    (a, b) => a - b
  );

describe('scheduled publishing of gated base models', () => {
  it('releases only the versions the gate passed, plus ungated ones', async () => {
    expect(await ids(scheduledVersionsDueSql(NOW))).toEqual([20, 40, 60]);
  });

  it('releases only the models whose scheduled versions all passed, plus ungated ones', async () => {
    expect(await ids(scheduledModelsDueSql(NOW))).toEqual([2, 4]);
  });

  it('keeps the showcase posts of an unpassed version unpublished', async () => {
    expect(await ids(scheduledPostsDueSql(NOW))).toEqual([200, 400]);
  });
});

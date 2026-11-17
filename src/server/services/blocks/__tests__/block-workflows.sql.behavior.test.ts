import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { updateBlockWorkflowStatus } from '../block-workflows.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * `updateBlockWorkflowStatus` executed as written against an in-process Postgres
 * carrying the REAL `block_workflows` migration.
 *
 * The mocked suite (`block-workflows.service.test.ts`) can only assert bind values;
 * whether a repeat write reports 0 lives in the SQL. `blocks.pollWorkflow` calls
 * this on EVERY poll of a finished workflow and counts
 * `civitai_app_block_succeeded_without_media_total` only when it returns 1, so a
 * repeat that reported 1 would count the same workflow once per poll.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20260715130000_block_workflows/migration.sql'
);
const db = { pg: null as unknown as PGlite };

async function row(workflowId: string) {
  const res = await db.pg.query<{ status: string; updated_at: string }>(
    `SELECT "status", "updated_at"::text AS "updated_at" FROM "block_workflows" WHERE "workflow_id" = $1`,
    [workflowId]
  );
  return res.rows[0];
}

beforeAll(async () => {
  db.pg = new PGlite();
  // Only the two FK targets the migration references.
  await db.pg.exec(`
    CREATE TABLE "app_blocks" ("id" text PRIMARY KEY);
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    INSERT INTO "app_blocks" ("id") VALUES ('apb_1');
    INSERT INTO "User" ("id") VALUES (42);
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
  const raw = pgliteRaw(db.pg);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});

beforeEach(async () => {
  // Re-wire per test: other suites' `mockReset()` in a shared worker must not leave
  // this file talking to a bare mock.
  dbMock.dbWrite.$executeRaw.mockImplementation(pgliteRaw(db.pg).executeRaw as never);
  await db.pg.exec(`
    DELETE FROM "block_workflows";
    INSERT INTO "block_workflows"
      ("workflow_id", "app_block_id", "block_instance_id", "user_id", "status", "updated_at")
    VALUES ('wf_pending', 'apb_1', 'bki_1', 42, 'pending', '2026-01-01T00:00:00Z');
  `);
});

describe('updateBlockWorkflowStatus — transition-only UPDATE (real SQL)', () => {
  it('reports 1 on the real transition, then 0 on every repeat of the same status', async () => {
    expect(await updateBlockWorkflowStatus({ workflowId: 'wf_pending', status: 'succeeded' })).toBe(
      1
    );
    expect((await row('wf_pending')).status).toBe('succeeded');

    expect(await updateBlockWorkflowStatus({ workflowId: 'wf_pending', status: 'succeeded' })).toBe(
      0
    );
    expect(await updateBlockWorkflowStatus({ workflowId: 'wf_pending', status: 'succeeded' })).toBe(
      0
    );
  });

  it('a repeat does not move updated_at — it records the transition, not the last poll', async () => {
    await updateBlockWorkflowStatus({ workflowId: 'wf_pending', status: 'failed' });
    const afterTransition = (await row('wf_pending')).updated_at;
    // Positive control: the transition itself DID move it off the seeded value.
    expect(afterTransition.startsWith('2026-01-01')).toBe(false);

    await updateBlockWorkflowStatus({ workflowId: 'wf_pending', status: 'failed' });
    expect((await row('wf_pending')).updated_at).toBe(afterTransition);
  });

  it('a DIFFERENT status is still a transition (1)', async () => {
    expect(
      await updateBlockWorkflowStatus({ workflowId: 'wf_pending', status: 'processing' })
    ).toBe(1);
    expect(await updateBlockWorkflowStatus({ workflowId: 'wf_pending', status: 'canceled' })).toBe(
      1
    );
    expect((await row('wf_pending')).status).toBe('canceled');
  });

  it('reports 0 for a workflow with no row', async () => {
    expect(await updateBlockWorkflowStatus({ workflowId: 'wf_absent', status: 'succeeded' })).toBe(
      0
    );
  });
});

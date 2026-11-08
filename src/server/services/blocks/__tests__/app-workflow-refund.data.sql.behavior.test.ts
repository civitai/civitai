import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The SQL of `app-workflow-refund.data.ts`, run as written against an in-process Postgres built from
 * the SHIPPED migrations for the three App spend tables (real columns, real constraints). The
 * tables they reference (`User`, `OauthClient`, `app_blocks`, `app_listings`) are stubbed to the
 * columns these statements read.
 *
 * The orchestrator read is the one thing here that is not SQL: its client is mocked.
 */

const getWorkflow = vi.fn();
vi.mock('~/server/services/orchestrator/workflows', () => ({
  getWorkflow: (...a: unknown[]) => getWorkflow(...a),
}));

const {
  getAppNames,
  getAppWorkflowRecords,
  getOrchestratorWorkflowCharges,
  listAppWorkflowIdsForUser,
  resolveListingAppBlockId,
} = await import('~/server/services/blocks/app-workflow-refund.data');

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };

const VIEWER = 501;
const OTHER = 502;
const OWNER = 503;
const APP = 'apb_sql_alpha';
const OTHER_APP = 'apb_sql_beta';
const BARE_APP = 'apb_sql_bare';

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "OauthClient" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "app_blocks" ("id" TEXT PRIMARY KEY, "block_id" TEXT NOT NULL);
    CREATE TABLE "app_listings" (
      "id" TEXT PRIMARY KEY, "slug" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL,
      "app_block_id" TEXT, "revision_of_id" TEXT
    );
  `);
  for (const name of [
    '20260618130000_block_spend_attribution',
    '20260715120000_block_spend_content_author',
    '20260715130000_block_workflows',
    '20260818210000_block_spend_attribution_tracked_default',
    '20260917150000_block_spend_generation_type',
    '20260918180000_block_author_fee_accrual',
  ])
    await db.pg.exec(migration(name));

  await db.pg.exec(`
    INSERT INTO "User" VALUES (${VIEWER}), (${OTHER}), (${OWNER});
    INSERT INTO "OauthClient" VALUES ('oc_sql');
    INSERT INTO "app_blocks" VALUES ('${APP}', 'sql-alpha'), ('${OTHER_APP}', 'sql-beta'),
      ('${BARE_APP}', 'sql-bare');
    INSERT INTO "app_listings" VALUES
      ('apl_sql_alpha', 'sample-sql-alpha', 'Sample Alpha', '${APP}', NULL),
      ('apl_sql_alpha_rev', 'sample-sql-alpha-rev', 'Draft Alpha', NULL, 'apl_sql_alpha'),
      ('apl_sql_offsite', 'sample-offsite', 'Offsite', NULL, NULL);
  `);

  const raw = pgliteRaw(db.pg);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});

afterAll(async () => {
  await db.pg?.close();
});

async function seed() {
  await db.pg.exec(`
    DELETE FROM "block_workflows";
    DELETE FROM "block_spend_attribution";
    DELETE FROM "block_author_fee_accrual";
  `);
  const workflow = (id: string, user: number, app: string, at: string, status = 'succeeded') =>
    db.pg.query(
      `INSERT INTO "block_workflows" ("workflow_id", "app_block_id", "block_instance_id", "user_id", "status", "submitted_at")
       VALUES ($1, $2, 'bi_1', $3, $4, $5)`,
      [id, app, user, status, at]
    );
  const spend = (id: string, wf: string, user: number, app: string, at: string, status: string) =>
    db.pg.query(
      `INSERT INTO "block_spend_attribution" ("id", "user_id", "buzz_amount", "buzz_type", "gross_value_cents",
         "workflow_id", "app_id", "app_block_id", "block_instance_id", "rate_card_version",
         "spend_share_pct", "app_owner_share_cents", "app_owner_user_id", "status", "attributed_at")
       VALUES ($1, $2, 100, 'yellow', 10, $3, 'oc_sql', $4, 'bi_1', 'v1', 0, 0, ${OWNER}, $5, $6)`,
      [id, user, wf, app, status, at]
    );
  const fee = (id: string, wf: string, viewer: number, app: string, at: string) =>
    db.pg.query(
      `INSERT INTO "block_author_fee_accrual" ("id", "workflow_id", "app_id", "app_block_id",
         "app_owner_user_id", "viewer_user_id", "buzz_type", "fee_buzz", "base_generation_buzz",
         "flat_leg_buzz", "pct_leg_buzz", "governing_leg", "status", "accrued_at")
       VALUES ($1, $2, 'oc_sql', $3, ${OWNER}, $4, 'yellow', 7, 140, 1, 7, 'pct', 'accrued', $5)`,
      [id, wf, app, viewer, at]
    );

  await workflow('wf-a', VIEWER, APP, '2026-11-05T10:00:00Z');
  await spend(
    'bsa_00000000000000000000000001',
    'wf-a',
    VIEWER,
    APP,
    '2026-11-05T10:00:01Z',
    'tracked'
  );
  await fee('bafa_0000000000000000000000001', 'wf-a', VIEWER, APP, '2026-11-05T10:00:02Z');
  // Only a spend row: the queue write was lost.
  await spend(
    'bsa_00000000000000000000000002',
    'wf-b',
    VIEWER,
    OTHER_APP,
    '2026-11-06T09:00:00Z',
    'tracked'
  );
  // Only a fee row.
  await fee('bafa_0000000000000000000000003', 'wf-c', VIEWER, APP, '2026-11-04T08:00:00Z');
  // Another user's rows inside the window, one per table, and the viewer's own rows outside it, one
  // per table. None may be listed for the viewer.
  await workflow('wf-other', OTHER, APP, '2026-11-05T11:00:00Z');
  await spend(
    'bsa_00000000000000000000000006',
    'wf-other-spend',
    OTHER,
    APP,
    '2026-11-05T13:00:00Z',
    'tracked'
  );
  await fee('bafa_0000000000000000000000007', 'wf-other-fee', OTHER, APP, '2026-11-05T14:00:00Z');
  await workflow('wf-old', VIEWER, APP, '2026-09-01T00:00:00Z');
  await spend(
    'bsa_00000000000000000000000008',
    'wf-old-spend',
    VIEWER,
    APP,
    '2026-09-02T00:00:00Z',
    'tracked'
  );
  await fee('bafa_0000000000000000000000009', 'wf-old-fee', VIEWER, APP, '2026-09-03T00:00:00Z');
  // Two spend rows on one workflow (two app blocks), one already paid out: listed once.
  await spend(
    'bsa_00000000000000000000000004',
    'wf-paid',
    VIEWER,
    APP,
    '2026-11-05T12:00:00Z',
    'paid_out'
  );
  await spend(
    'bsa_00000000000000000000000005',
    'wf-paid',
    VIEWER,
    OTHER_APP,
    '2026-11-05T12:00:00Z',
    'tracked'
  );
}

beforeEach(async () => {
  await seed();
  getWorkflow.mockReset();
  setEnv({ ORCHESTRATOR_ACCESS_TOKEN: 'test-system-token' });
});

describe('getAppWorkflowRecords', () => {
  it('reads all three tables, aliased to the record shapes', async () => {
    const records = await getAppWorkflowRecords(['wf-a', 'wf-missing']);
    expect(records.workflows).toEqual([
      {
        workflowId: 'wf-a',
        userId: VIEWER,
        appBlockId: APP,
        status: 'succeeded',
        submittedAt: new Date('2026-11-05T10:00:00Z'),
      },
    ]);
    expect(records.spends).toEqual([
      {
        workflowId: 'wf-a',
        userId: VIEWER,
        appBlockId: APP,
        buzzAmount: 100,
        status: 'tracked',
        attributedAt: new Date('2026-11-05T10:00:01Z'),
      },
    ]);
    expect(records.fees).toEqual([
      {
        workflowId: 'wf-a',
        viewerUserId: VIEWER,
        appBlockId: APP,
        appOwnerUserId: OWNER,
        status: 'accrued',
        feeBuzz: 7,
        buzzType: 'yellow',
        accruedAt: new Date('2026-11-05T10:00:02Z'),
      },
    ]);
  });

  it('an id in none of them comes back empty', async () => {
    expect(await getAppWorkflowRecords(['wf-missing'])).toEqual({
      workflows: [],
      spends: [],
      fees: [],
    });
  });
});

describe('listAppWorkflowIdsForUser', () => {
  const range = { from: new Date('2026-10-15T00:00:00Z'), to: new Date('2026-11-07T00:00:00Z') };

  // Exactly these four: another user's in-window rows (`wf-other*`, one per table) and the viewer's
  // out-of-window rows (`wf-old*`, one per table) are absent. Dropping any branch's `user_id` /
  // `viewer_user_id` predicate, or its window, lists one of them and turns this red.
  it('unions the three tables for the spender, newest first, once each', async () => {
    expect(await listAppWorkflowIdsForUser({ userId: VIEWER, ...range, limit: 20 })).toEqual([
      'wf-b',
      'wf-paid',
      'wf-a',
      'wf-c',
    ]);
  });

  it('control: the other user’s rows are listed for that user, from every table', async () => {
    expect(await listAppWorkflowIdsForUser({ userId: OTHER, ...range, limit: 20 })).toEqual([
      'wf-other-fee',
      'wf-other-spend',
      'wf-other',
    ]);
  });

  it('control: the viewer’s old rows are listed by a window that covers them, from every table', async () => {
    expect(
      await listAppWorkflowIdsForUser({
        userId: VIEWER,
        from: new Date('2026-08-31T00:00:00Z'),
        to: new Date('2026-09-04T00:00:00Z'),
        limit: 20,
      })
    ).toEqual(['wf-old-fee', 'wf-old-spend', 'wf-old']);
  });

  it('filters by app', async () => {
    expect(
      await listAppWorkflowIdsForUser({
        userId: VIEWER,
        appBlockId: OTHER_APP,
        ...range,
        limit: 20,
      })
    ).toEqual(['wf-b', 'wf-paid']);
  });

  it('honours the window (from inclusive, to exclusive) and the limit', async () => {
    expect(
      await listAppWorkflowIdsForUser({
        userId: VIEWER,
        from: new Date('2026-11-05T10:00:00Z'),
        to: new Date('2026-11-06T09:00:00Z'),
        limit: 20,
      })
    ).toEqual(['wf-paid', 'wf-a']);
    expect(await listAppWorkflowIdsForUser({ userId: VIEWER, ...range, limit: 2 })).toEqual([
      'wf-b',
      'wf-paid',
    ]);
  });
});

describe('listings and names', () => {
  it('resolves a listing by id or slug, never a shadow revision or an off-site listing', async () => {
    expect(await resolveListingAppBlockId('apl_sql_alpha')).toBe(APP);
    expect(await resolveListingAppBlockId('sample-sql-alpha')).toBe(APP);
    expect(await resolveListingAppBlockId('sample-sql-alpha-rev')).toBeNull();
    expect(await resolveListingAppBlockId('sample-offsite')).toBeNull();
    expect(await resolveListingAppBlockId('nope')).toBeNull();
  });

  it('names an app by its listing, else by its block id', async () => {
    const names = await getAppNames([APP, BARE_APP]);
    expect(Object.fromEntries(names)).toEqual({ [APP]: 'Sample Alpha', [BARE_APP]: 'sql-bare' });
  });
});

describe('getOrchestratorWorkflowCharges', () => {
  it('reads the workflow with the system token and keeps its transactions', async () => {
    getWorkflow.mockResolvedValue({
      status: 'succeeded',
      transactions: {
        list: [
          { type: 'debit', amount: 211, id: 'tx-1', accountType: 'yellow' },
          { type: 'credit', amount: 13, id: null, accountType: 'blue' },
        ],
      },
    });
    expect(await getOrchestratorWorkflowCharges('wf-a')).toEqual({
      found: true,
      status: 'succeeded',
      transactions: [
        { type: 'debit', amount: 211, id: 'tx-1', accountType: 'yellow' },
        { type: 'credit', amount: 13, id: null, accountType: 'blue' },
      ],
    });
    expect(getWorkflow).toHaveBeenCalledWith({
      token: 'test-system-token',
      path: { workflowId: 'wf-a' },
    });
  });

  it('only a 404 (NOT_FOUND) is "no such workflow"', async () => {
    getWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'x' }));
    expect(await getOrchestratorWorkflowCharges('wf-a')).toEqual({ found: false });
  });

  // Every other refusal says nothing about whether the workflow exists — a 401/403 is the system
  // token being refused — so it must surface (the caller reports `lookup-failed`), never `found: false`.
  it.each<'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE'>([
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'SERVICE_UNAVAILABLE',
  ])('%s propagates — it says nothing about whether the workflow exists', async (code) => {
    getWorkflow.mockRejectedValue(new TRPCError({ code, message: 'x' }));
    await expect(getOrchestratorWorkflowCharges('wf-a')).rejects.toThrow('x');
  });

  it('refuses to run without a system token', async () => {
    setEnv({ ORCHESTRATOR_ACCESS_TOKEN: '' });
    await expect(getOrchestratorWorkflowCharges('wf-a')).rejects.toThrow(
      'ORCHESTRATOR_ACCESS_TOKEN'
    );
    expect(getWorkflow).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as FliptClientModule from '~/server/flipt/client';

/** App block ids the operator hold flag resolves ON for (entityId = the app block id). */
const { heldApps, mockIsFlipt } = vi.hoisted(() => ({
  heldApps: new Set<string>(),
  mockIsFlipt: vi.fn<(flag: string, entityId?: string, context?: unknown) => Promise<boolean>>(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: (flag: string, entityId?: string, context?: unknown) =>
    mockIsFlipt(flag, entityId, context),
}));

vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => ({
    migrateDocuments: () => {
      throw new Error('these cases never reach a page');
    },
  }),
}));

const {
  closeStorageMigrationRunsForRequest,
  reserveStorageMigrationRuns,
  resumeStorageMigrationRuns,
  runStorageMigrationsForRequest,
  startStorageMigrationsOnApprove,
} = await import('~/server/services/apps/storage-migration-run.service');

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The migration-run SQL against a REAL Postgres (PGlite), with the REAL manual-apply
 * `migration.sql`: every raw statement of `storage-migration-run.service.ts` that the other suites
 * only see through a mocked `$queryRaw` — the approve gate's lock, join and reservation, the
 * claim/save pair, the cap cleanup and the close. The canonical db mock's raw methods are routed to
 * the database (`pgliteRaw`, the parameterised statement Prisma would send), and `$transaction`
 * runs its callback inside a real BEGIN/COMMIT, so `SET LOCAL` and `pg_advisory_xact_lock` run as
 * in production. Only the two Prisma model reads `loadTarget` makes stay mocked.
 *
 * Expected values are literals read back from the table.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261221120000_app_storage_migration_runs/migration.sql'
);

const APP = 'apb_SQL1';
const SLUG = 'card-app';
const RUN_MANIFEST = {
  storage: {
    collections: {
      cards: { visibility: 'private', schema: { type: 'object', required: ['status'] } },
      notes: { visibility: 'private' },
    },
  },
};

let db: PGlite;

/** The rows of the runs table, as the assertions read them. */
async function rows() {
  return (
    await db.query<Record<string, unknown>>(
      `SELECT publish_request_id, collection, status, attempts, claim_token
       FROM app_storage_migration_runs ORDER BY publish_request_id, collection`
    )
  ).rows;
}

async function insertRequest(id: string, manifest: unknown, status = 'approved') {
  await db.query(
    `INSERT INTO app_block_publish_requests (id, slug, status, manifest, reviewed_at)
     VALUES ($1, $2, $3, $4::jsonb, now())`,
    [id, SLUG, status, JSON.stringify(manifest)]
  );
}

/** One run row, with the fields a case sets. */
async function insertRun(r: {
  request: string;
  collection: string;
  status: string;
  attempts?: number;
  token?: string | null;
  heartbeatMinutesAgo?: number | null;
  app?: string;
}) {
  await db.query(
    `INSERT INTO app_storage_migration_runs
       (publish_request_id, collection, app_block_id, ops, status, attempts, claim_token, heartbeat_at)
     VALUES ($1, $2, $3, '[]'::jsonb, $4, $5, $6,
       CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(mins => $7::int) END)`,
    [
      r.request,
      r.collection,
      r.app ?? APP,
      r.status,
      r.attempts ?? 0,
      r.token ?? null,
      r.heartbeatMinutesAgo ?? null,
    ]
  );
}

beforeAll(async () => {
  db = new PGlite();
  // The two tables the runs table's foreign keys name, with the columns these statements read.
  await db.exec(`
    CREATE TABLE app_blocks (id TEXT PRIMARY KEY);
    CREATE TABLE app_block_publish_requests (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, status TEXT NOT NULL,
      manifest JSONB NOT NULL, reviewed_at TIMESTAMPTZ
    );
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  // The file is idempotent: a second application is a no-op, not an error.
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.query(`INSERT INTO app_blocks (id) VALUES ($1)`, [APP]);
});
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  heldApps.clear();
  // Only the hold flag, for exactly the held app block ids, with no context: a wrong flag key or a
  // wrong entity id reads as not held.
  mockIsFlipt.mockImplementation(
    async (flag, entityId, context) =>
      flag === 'app-blocks-storage-migration-hold' &&
      context === undefined &&
      entityId !== undefined &&
      heldApps.has(entityId)
  );
  await db.exec(`DELETE FROM app_storage_migration_runs; DELETE FROM app_block_publish_requests;`);
  const pg = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(pg.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(pg.executeRaw as never);
  dbMock.dbWrite.$executeRawUnsafe.mockImplementation((async (sql: string) => {
    await db.query(sql);
    return 0;
  }) as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => {
    await db.exec('BEGIN');
    try {
      const out = await fn(dbMock.dbWrite);
      await db.exec('COMMIT');
      return out;
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  }) as never);
});

describe('reserveStorageMigrationRuns on a real database', () => {
  const PLAN_CARDS = new Map([['cards', [{ op: 'remove' as const, path: '/legacy' }]]]);
  const PLAN_NOTES = new Map([['notes', [{ op: 'remove' as const, path: '/old' }]]]);
  const withNotesChanged = {
    ...RUN_MANIFEST,
    storage: {
      collections: {
        ...RUN_MANIFEST.storage.collections,
        notes: { visibility: 'private', schema: { type: 'object' } },
      },
    },
  };

  beforeEach(async () => {
    await insertRequest('pubreq_A', RUN_MANIFEST);
    await insertRequest('pubreq_B', withNotesChanged, 'pending');
    await insertRun({ request: 'pubreq_A', collection: 'cards', status: 'running' });
  });

  it('🔴 an open run on the same collection refuses, and reserves nothing', async () => {
    await expect(
      reserveStorageMigrationRuns({
        appBlockId: APP,
        publishRequestId: 'pubreq_B',
        manifest: RUN_MANIFEST,
        plans: PLAN_CARDS,
      })
    ).rejects.toThrow(
      'Cannot approve: this version changes the storage of collection cards, and an earlier storage migration of that collection is still running (publish request pubreq_A, collection cards); approving now would leave it half-done. Approve again once it has finished.'
    );
    expect(await rows()).toEqual([
      {
        publish_request_id: 'pubreq_A',
        collection: 'cards',
        status: 'running',
        attempts: 0,
        claim_token: null,
      },
    ]);
  });

  it('🔴 an open run on a different collection does not refuse; the new plan gets its own row; a re-run adds none', async () => {
    const reserve = () =>
      reserveStorageMigrationRuns({
        appBlockId: APP,
        publishRequestId: 'pubreq_B',
        manifest: withNotesChanged,
        plans: PLAN_NOTES,
      });
    await reserve();
    // The same request reserved again (a retried approve): ON CONFLICT, no second row.
    await reserve();
    expect(await rows()).toEqual([
      {
        publish_request_id: 'pubreq_A',
        collection: 'cards',
        status: 'running',
        attempts: 0,
        claim_token: null,
      },
      {
        publish_request_id: 'pubreq_B',
        collection: 'notes',
        status: 'pending',
        attempts: 0,
        claim_token: null,
      },
    ]);
    const ops = await db.query<{ ops: unknown }>(
      `SELECT ops FROM app_storage_migration_runs WHERE publish_request_id = 'pubreq_B'`
    );
    expect(ops.rows).toEqual([{ ops: [{ op: 'remove', path: '/old' }] }]);
  });
});

describe('claim and save on a real database', () => {
  beforeEach(async () => {
    await insertRequest('pubreq_R', RUN_MANIFEST);
  });

  it('🔴 a stale-heartbeat reclaim counts an attempt and takes a new claim token', async () => {
    await insertRun({
      request: 'pubreq_R',
      collection: 'cards',
      status: 'running',
      attempts: 1,
      token: 'lost-runner',
      heartbeatMinutesAgo: 30,
    });
    // The request reads as pending, so the reclaimed run waits: one claim, one save, no page.
    dbMock.dbWrite.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: SLUG,
      manifest: RUN_MANIFEST,
      status: 'pending',
    });
    await runStorageMigrationsForRequest('pubreq_R', ['cards'], APP);
    const [row] = await rows();
    expect([row.status, row.attempts]).toEqual(['pending', 2]);
    expect(row.claim_token).not.toBe('lost-runner');
    expect(typeof row.claim_token).toBe('string');
  });

  it('a run with a fresh heartbeat is not claimed', async () => {
    await insertRun({
      request: 'pubreq_R',
      collection: 'cards',
      status: 'running',
      token: 'live-runner',
      heartbeatMinutesAgo: 1,
    });
    await runStorageMigrationsForRequest('pubreq_R', ['cards'], APP);
    const [row] = await rows();
    expect([row.status, row.attempts, row.claim_token]).toEqual(['running', 0, 'live-runner']);
    expect(dbMock.dbWrite.appBlockPublishRequest.findUnique).not.toHaveBeenCalled();
  });

  it("🔴 a save under a lost claim is refused: the other runner's row is not overwritten", async () => {
    await insertRun({ request: 'pubreq_R', collection: 'cards', status: 'pending' });
    // Between this runner's claim and its save, another runner re-claims the row.
    dbMock.dbWrite.appBlockPublishRequest.findUnique.mockImplementation((async () => {
      await db.query(
        `UPDATE app_storage_migration_runs SET claim_token = 'other-runner', status = 'running'
         WHERE publish_request_id = 'pubreq_R'`
      );
      return { slug: SLUG, manifest: RUN_MANIFEST, status: 'pending' };
    }) as never);
    await runStorageMigrationsForRequest('pubreq_R', ['cards'], APP);
    const [row] = await rows();
    expect([row.status, row.claim_token]).toEqual(['running', 'other-runner']);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        message: 'storage migration run pubreq_R/cards was re-claimed by another runner',
      }),
      'app-blocks'
    );
  });
});

describe('the cap cleanup on a real database', () => {
  it('🔴 fails a pending run at the cap and a stale running one, and leaves a fresh running one alone', async () => {
    for (const id of ['pubreq_P', 'pubreq_S', 'pubreq_F']) await insertRequest(id, RUN_MANIFEST);
    await insertRun({ request: 'pubreq_P', collection: 'cards', status: 'pending', attempts: 5 });
    await insertRun({
      request: 'pubreq_S',
      collection: 'cards',
      status: 'running',
      attempts: 5,
      heartbeatMinutesAgo: 30,
    });
    await insertRun({
      request: 'pubreq_F',
      collection: 'cards',
      status: 'running',
      attempts: 5,
      heartbeatMinutesAgo: 1,
    });
    expect(await resumeStorageMigrationRuns()).toEqual({
      advanced: 0,
      held: 0,
      tableMissing: false,
    });
    expect((await rows()).map((r) => [r.publish_request_id, r.status])).toEqual([
      ['pubreq_F', 'running'],
      ['pubreq_P', 'failed'],
      ['pubreq_S', 'failed'],
    ]);
    const failed = await db.query<{ last_error: string; finished: boolean }>(
      `SELECT last_error, finished_at IS NOT NULL AS finished FROM app_storage_migration_runs
       WHERE publish_request_id = 'pubreq_P'`
    );
    expect(failed.rows).toEqual([
      {
        last_error:
          'gave up: the run reached the attempt cap without finishing (its last error, if any, was: none)',
        finished: true,
      },
    ]);
  });
});

describe('closeStorageMigrationRunsForRequest on a real database', () => {
  it("🔴 supersedes the request's pending and running rows, and nothing else", async () => {
    for (const id of ['pubreq_X', 'pubreq_Y']) await insertRequest(id, RUN_MANIFEST);
    await insertRun({ request: 'pubreq_X', collection: 'cards', status: 'pending' });
    await insertRun({ request: 'pubreq_X', collection: 'notes', status: 'completed' });
    await insertRun({ request: 'pubreq_Y', collection: 'cards', status: 'pending' });
    await closeStorageMigrationRunsForRequest('pubreq_X');
    expect((await rows()).map((r) => [r.publish_request_id, r.collection, r.status])).toEqual([
      ['pubreq_X', 'cards', 'superseded'],
      ['pubreq_X', 'notes', 'completed'],
      ['pubreq_Y', 'cards', 'pending'],
    ]);
  });
});

describe('the operator hold (app-blocks-storage-migration-hold) on a real database', () => {
  const PLAN_CARDS = new Map([['cards', [{ op: 'remove' as const, path: '/legacy' }]]]);

  it('🔴 a held run is never claimed by the job: it stays pending with its attempts, the cap cleanup leaves it, and the next run after the hold is lifted claims it', async () => {
    await insertRequest('pubreq_H', RUN_MANIFEST);
    // One attempt below the cap: a hold must neither add one nor let the cleanup fail it.
    await insertRun({
      request: 'pubreq_H',
      collection: 'cards',
      status: 'pending',
      attempts: 4,
      heartbeatMinutesAgo: 30,
    });
    heldApps.add(APP);
    const first = await resumeStorageMigrationRuns();
    const second = await resumeStorageMigrationRuns();
    expect(await rows()).toEqual([
      {
        publish_request_id: 'pubreq_H',
        collection: 'cards',
        status: 'pending',
        attempts: 4,
        claim_token: null,
      },
    ]);
    // Touched, so the job's least-recently-touched-first sweep rotates it behind other apps' runs.
    const touched = await db.query<{ touched: boolean }>(
      `SELECT heartbeat_at > now() - make_interval(mins => 1) AS touched FROM app_storage_migration_runs`
    );
    expect(touched.rows).toEqual([{ touched: true }]);
    expect(dbMock.dbWrite.appBlockPublishRequest.findUnique).not.toHaveBeenCalled();
    expect([first, second]).toEqual([
      { advanced: 0, held: 1, tableMissing: false },
      { advanced: 0, held: 1, tableMissing: false },
    ]);
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-storage-migration-hold', APP, undefined);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-storage-migration-run',
        type: 'info',
        publishRequestId: 'pubreq_H',
        appBlockId: APP,
        held: true,
      }),
      'app-blocks'
    );

    // Lifted: the next job run claims it. The request reads as pending, so the claimed run waits
    // (one claim, one save, no page) — enough to show it was taken.
    heldApps.clear();
    dbMock.dbWrite.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: SLUG,
      manifest: RUN_MANIFEST,
      status: 'pending',
    });
    expect(await resumeStorageMigrationRuns()).toEqual({
      advanced: 1,
      held: 0,
      tableMissing: false,
    });
    const [row] = await rows();
    expect(typeof row.claim_token).toBe('string');
    expect(dbMock.dbWrite.appBlockPublishRequest.findUnique).toHaveBeenCalledTimes(1);
  });

  it('🔴 approve of a held app: the start at approve does not claim the reserved run, and a conflicting approve is refused while it is held', async () => {
    await insertRequest('pubreq_A', RUN_MANIFEST);
    await insertRequest('pubreq_B', RUN_MANIFEST, 'pending');
    heldApps.add(APP);
    await reserveStorageMigrationRuns({
      appBlockId: APP,
      publishRequestId: 'pubreq_A',
      manifest: RUN_MANIFEST,
      plans: PLAN_CARDS,
    });
    await startStorageMigrationsOnApprove({
      publishRequestId: 'pubreq_A',
      appBlockId: APP,
      plans: PLAN_CARDS,
    });
    // The start runs in the background; it is done once it has logged the hold.
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ publishRequestId: 'pubreq_A', held: true }),
        'app-blocks'
      )
    );
    await resumeStorageMigrationRuns();
    expect(await rows()).toEqual([
      {
        publish_request_id: 'pubreq_A',
        collection: 'cards',
        status: 'pending',
        attempts: 0,
        claim_token: null,
      },
    ]);
    await expect(
      reserveStorageMigrationRuns({
        appBlockId: APP,
        publishRequestId: 'pubreq_B',
        manifest: RUN_MANIFEST,
        plans: PLAN_CARDS,
      })
    ).rejects.toThrow(
      'Cannot approve: this version changes the storage of collection cards, and an earlier storage migration of that collection (publish request pubreq_A, collection cards) is held by an operator switch and does not run while held. Approve again once an operator has released the hold and the migration has finished.'
    );
    expect((await rows()).map((r) => r.publish_request_id)).toEqual(['pubreq_A']);
  });

  it('🔴 a held run left running by a dead runner goes back to pending: claim cleared, cursor and counts kept, no attempt added', async () => {
    await insertRequest('pubreq_D', RUN_MANIFEST);
    await insertRun({
      request: 'pubreq_D',
      collection: 'cards',
      status: 'running',
      attempts: 2,
      token: 'dead-runner',
      heartbeatMinutesAgo: 30,
    });
    await db.query(
      `UPDATE app_storage_migration_runs SET cursor = '{"scopeUid":7,"key":"k-41"}'::jsonb, scanned = 41`
    );
    heldApps.add(APP);
    expect(await resumeStorageMigrationRuns()).toEqual({
      advanced: 0,
      held: 1,
      tableMissing: false,
    });
    expect(await rows()).toEqual([
      {
        publish_request_id: 'pubreq_D',
        collection: 'cards',
        status: 'pending',
        attempts: 2,
        claim_token: null,
      },
    ]);
    const kept = await db.query<Record<string, unknown>>(
      `SELECT cursor, scanned, heartbeat_at > now() - make_interval(mins => 1) AS touched
       FROM app_storage_migration_runs`
    );
    expect(kept.rows).toEqual([
      { cursor: { scopeUid: 7, key: 'k-41' }, scanned: 41, touched: true },
    ]);
    expect(dbMock.dbWrite.appBlockPublishRequest.findUnique).not.toHaveBeenCalled();
  });

  it('a held run with a LIVE runner (fresh heartbeat) is left alone: its claim is never clobbered', async () => {
    await insertRequest('pubreq_L', RUN_MANIFEST);
    await insertRun({
      request: 'pubreq_L',
      collection: 'cards',
      status: 'running',
      attempts: 1,
      token: 'live-runner',
      heartbeatMinutesAgo: 1,
    });
    heldApps.add(APP);
    await runStorageMigrationsForRequest('pubreq_L', ['cards'], APP);
    const [row] = await rows();
    expect([row.status, row.attempts, row.claim_token]).toEqual(['running', 1, 'live-runner']);
  });

  it("🔴 rotation: with a batch of one, the run after a held stale one is another app's run", async () => {
    const OTHER = 'apb_SQL2';
    await db.query(`INSERT INTO app_blocks (id) VALUES ($1) ON CONFLICT DO NOTHING`, [OTHER]);
    await insertRequest('pubreq_H', RUN_MANIFEST);
    await insertRequest('pubreq_O', RUN_MANIFEST);
    // The held run is the least recently touched, so the sweep picks it first.
    await insertRun({
      request: 'pubreq_H',
      collection: 'cards',
      status: 'running',
      token: 'dead-runner',
      heartbeatMinutesAgo: 30,
    });
    await insertRun({
      request: 'pubreq_O',
      collection: 'cards',
      status: 'pending',
      heartbeatMinutesAgo: 20,
      app: OTHER,
    });
    heldApps.add(APP);
    dbMock.dbWrite.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: SLUG,
      manifest: RUN_MANIFEST,
      status: 'pending',
    });
    const first = await resumeStorageMigrationRuns({ limit: 1 });
    const second = await resumeStorageMigrationRuns({ limit: 1 });
    expect([first, second]).toEqual([
      { advanced: 0, held: 1, tableMissing: false },
      { advanced: 1, held: 0, tableMissing: false },
    ]);
    const other = (await rows()).find((r) => r.publish_request_id === 'pubreq_O');
    expect(typeof other?.claim_token).toBe('string');
  });
});

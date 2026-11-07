import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as FliptClientModule from '~/server/flipt/client';

// A refusal reads the operator hold; nothing is held in these cases (the held refusal is covered
// on a real database in storage-migration-run.sql.test.ts).
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: async () => false,
}));

const {
  advanceStorageMigrationRun,
  closeStorageMigrationRunsForRequest,
  loadStorageMigrationBaseline,
  recordStorageMigrationRuns,
  reserveStorageMigrationRuns,
  resumeStorageMigrationRuns,
} = await import('~/server/services/apps/storage-migration-run.service');

/**
 * The approve-side guards of App Storage schema migrations, over the canonical db mock:
 *   - EVERY approve of an existing app is refused while an earlier run of the app (another publish
 *     request's) is still open, under a per-app advisory lock, and a plan is reserved in the same
 *     transaction; a plan is refused while the runs table is missing;
 *   - the diff baseline is what the store enforces (`app_blocks.manifest`, on the primary), with
 *     earlier approved manifests as history, and a divergence from the latest approval is logged;
 *   - the plan is recorded in ONE statement.
 */

const APP = 'ab_GATE_4101';
const tableMissing = Object.assign(
  new Error('relation "app_storage_migration_runs" does not exist'),
  {
    code: '42P01',
  }
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reserveStorageMigrationRuns', () => {
  type Plans = ReadonlyMap<string, readonly { op: 'remove'; path: string }[]>;
  const PLAN_CARDS: Plans = new Map([['cards', [{ op: 'remove' as const, path: '/legacy' }]]]);
  const PLAN_NOTES: Plans = new Map([['notes', [{ op: 'remove' as const, path: '/old' }]]]);
  const NO_PLAN: Plans = new Map();
  /** The approved manifest the open `cards` run targets. */
  const RUN_MANIFEST = {
    storage: {
      collections: {
        cards: { visibility: 'private', schema: { type: 'object', required: ['status'] } },
        notes: { visibility: 'private' },
      },
    },
  };
  const withCollections = (collections: Record<string, unknown>) => ({
    ...RUN_MANIFEST,
    name: 'Cards v3',
    storage: { collections: { ...RUN_MANIFEST.storage.collections, ...collections } },
  });
  const OPEN_CARDS = {
    publish_request_id: 'pubreq_OPEN1',
    collection: 'cards',
    status: 'running',
    last_error: null,
    manifest: RUN_MANIFEST,
  };
  const reserve = (plans: Plans, manifest: unknown = RUN_MANIFEST) =>
    reserveStorageMigrationRuns({
      appBlockId: APP,
      publishRequestId: 'pubreq_SELF',
      manifest,
      plans,
    });
  const CARDS_REFUSAL =
    'Cannot approve: this version changes the storage of collection cards, and an earlier storage migration of that collection is still running (publish request pubreq_OPEN1, collection cards); approving now would leave it half-done. Approve again once it has finished.';

  it('🔴 refuses a plan while the runs table is missing', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(tableMissing);
    await expect(reserve(PLAN_CARDS)).rejects.toThrow(
      'Cannot approve: this version migrates stored App Storage documents, but the app_storage_migration_runs table does not exist yet. Apply migration 20261221120000_app_storage_migration_runs first, then approve again.'
    );
  });

  it('a version without a plan passes while the runs table is missing (no run can be open)', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(tableMissing);
    await expect(reserve(NO_PLAN)).resolves.toBeUndefined();
  });

  it("🔴 F1: an approve that leaves the open run's collection untouched goes through (a copy change)", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([OPEN_CARDS]);
    await expect(reserve(NO_PLAN, { ...RUN_MANIFEST, name: 'Cards v3, new copy' })).resolves.toBe(
      undefined
    );
    // Read under the lock; nothing to reserve.
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("🔴 F1: an approve that changes the open run's collection is refused, naming the run", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([OPEN_CARDS]);
    const changed = withCollections({ cards: { visibility: 'private', exportable: false } });
    await expect(reserve(NO_PLAN, changed)).rejects.toThrow(CARDS_REFUSAL);
  });

  it("🔴 F1: an approve that plans a migration for the open run's collection is refused", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([OPEN_CARDS]);
    await expect(reserve(PLAN_CARDS)).rejects.toThrow(CARDS_REFUSAL);
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('🔴 F1: an approve that changes a DIFFERENT collection is accepted and reserves its own run beside the open one', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([OPEN_CARDS]).mockResolvedValueOnce([1]);
    const notesChanged = withCollections({
      notes: { visibility: 'private', schema: { type: 'object', additionalProperties: false } },
    });
    await expect(reserve(PLAN_NOTES, notesChanged)).resolves.toBeUndefined();
    const insert = dbMock.dbWrite.$queryRaw.mock.calls[1];
    expect(insert.slice(1)).toEqual([
      'pubreq_SELF',
      APP,
      ['notes'],
      ['[{"op":"remove","path":"/old"}]'],
    ]);
  });

  it('🔴 F3: a run waiting because app storage is off is named as such', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([
      {
        ...OPEN_CARDS,
        status: 'pending',
        last_error: 'storage_disabled: document storage is disabled',
      },
    ]);
    await expect(reserve(PLAN_CARDS)).rejects.toThrow(
      'Cannot approve: this version changes the storage of collection cards, and an earlier storage migration of that collection (publish request pubreq_OPEN1, collection cards) is waiting because app storage is turned off. It resumes by itself once storage is turned back on; approve again after it has finished.'
    );
  });

  it('🔴 F5: bounds the lock wait, takes the per-app lock, reads the open runs of OTHER requests, then reserves', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([1]);
    await expect(reserve(PLAN_CARDS)).resolves.toBeUndefined();
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$executeRawUnsafe.mock.calls).toEqual([
      [`SET LOCAL lock_timeout = '5s'`],
    ]);
    const lock = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect((lock[0] as readonly string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(lock.slice(1)).toEqual([0x41534d01, APP]);
    // The timeout is set before the lock is taken.
    expect(dbMock.dbWrite.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0]
    );
    const [check, insert] = dbMock.dbWrite.$queryRaw.mock.calls;
    expect(check.slice(1)).toEqual([APP, 'pubreq_SELF']);
    expect((insert[0] as readonly string[]).join('?')).toContain(
      'INSERT INTO "app_storage_migration_runs"'
    );
    expect(insert.slice(1)).toEqual([
      'pubreq_SELF',
      APP,
      ['cards'],
      ['[{"op":"remove","path":"/legacy"}]'],
    ]);
  });

  it('🔴 F5: a lock that times out is a retryable refusal', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('canceling statement due to lock timeout', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '55P03' },
      })
    );
    await expect(reserve(PLAN_CARDS)).rejects.toThrow(
      'Cannot approve right now: another approve of this app is in progress. Try again in a moment.'
    );
  });

  it('rethrows any other error (fail-closed)', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));
    await expect(reserve(NO_PLAN)).rejects.toThrow('connection reset');
  });
});

describe('closeStorageMigrationRunsForRequest (F4)', () => {
  it("supersedes the request's open rows at once", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([1]);
    await closeStorageMigrationRunsForRequest('pubreq_REJ');
    const [call] = dbMock.dbWrite.$queryRaw.mock.calls;
    const sql = (call[0] as readonly string[]).join('?');
    expect(sql).toContain(`SET "status" = 'superseded'`);
    expect(sql).toContain(`WHERE "publish_request_id" = ? AND "status" IN ('pending', 'running')`);
    expect(call.slice(1)).toEqual(['pubreq_REJ']);
  });

  it('never rejects (a missing table is nothing to close)', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(tableMissing);
    await expect(closeStorageMigrationRunsForRequest('pubreq_REJ')).resolves.toBeUndefined();
  });
});

describe('loadStorageMigrationBaseline', () => {
  const ENFORCED = { storage: { collections: { cards: { visibility: 'private' } } } };
  const LATEST = { storage: { collections: { cards: { visibility: 'shared', write: 'own' } } } };
  const OLDER = { storage: { collections: { notes: { visibility: 'private' } } } };

  it('🔴 the baseline is app_blocks.manifest read on the primary; approvals are history; a divergence is logged', async () => {
    dbMock.dbWrite.appBlock.findFirst.mockResolvedValueOnce({ id: APP, manifest: ENFORCED });
    dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValueOnce([
      { id: 'pubreq_L', manifest: LATEST },
      { id: 'pubreq_O', manifest: OLDER },
    ]);
    const baseline = await loadStorageMigrationBaseline({
      slug: 'card-app',
      excludePublishRequestId: 'pubreq_SELF',
    });
    expect(baseline).toEqual({ prev: ENFORCED, history: [LATEST, OLDER] });
    expect(dbMock.dbRead.appBlock.findFirst).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'card-app', status: 'approved', NOT: { id: 'pubreq_SELF' } },
        orderBy: { reviewedAt: 'desc' },
      })
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-storage-migration-run',
        type: 'error',
        publishRequestId: 'pubreq_L',
      }),
      'app-blocks'
    );
  });

  it('logs nothing when the latest approval matches what is enforced', async () => {
    dbMock.dbWrite.appBlock.findFirst.mockResolvedValueOnce({ id: APP, manifest: ENFORCED });
    dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValueOnce([
      { id: 'pubreq_L', manifest: ENFORCED },
    ]);
    await loadStorageMigrationBaseline({ slug: 'card-app' });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it("🔴 RETRY after a failed approve: when app_blocks already holds this request's storage, the latest approval is the baseline", async () => {
    // Attempt 1 wrote SELF onto app_blocks at step (3) and then failed; the moderator re-approves.
    const SELF = { storage: { collections: { cards: { visibility: 'private', schema: {} } } } };
    dbMock.dbWrite.appBlock.findFirst.mockResolvedValueOnce({ id: APP, manifest: SELF });
    dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValueOnce([
      { id: 'pubreq_L', manifest: ENFORCED },
    ]);
    expect(
      await loadStorageMigrationBaseline({
        slug: 'card-app',
        excludePublishRequestId: 'pubreq_SELF',
        selfManifest: SELF,
      })
    ).toEqual({ prev: ENFORCED, history: [ENFORCED] });
  });

  it('a version that does not change storage keeps app_blocks as the baseline', async () => {
    dbMock.dbWrite.appBlock.findFirst.mockResolvedValueOnce({ id: APP, manifest: ENFORCED });
    dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValueOnce([
      { id: 'pubreq_L', manifest: ENFORCED },
    ]);
    expect(
      (
        await loadStorageMigrationBaseline({
          slug: 'card-app',
          excludePublishRequestId: 'pubreq_SELF',
          selfManifest: ENFORCED,
        })
      ).prev
    ).toEqual(ENFORCED);
  });

  it('a first version (no app block) has no baseline', async () => {
    dbMock.dbWrite.appBlock.findFirst.mockResolvedValueOnce(null);
    expect(await loadStorageMigrationBaseline({ slug: 'new-app' })).toEqual({
      prev: null,
      history: [],
    });
  });
});

describe('recordStorageMigrationRuns', () => {
  it('records every planned collection in one statement', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([1, 1]);
    const plans = new Map([
      ['cards', [{ op: 'remove' as const, path: '/legacy' }]],
      ['notes', [{ op: 'default' as const, path: '/s', value: 1 }]],
    ]);
    expect(
      await recordStorageMigrationRuns({ publishRequestId: 'pubreq_R', appBlockId: APP, plans })
    ).toBe('recorded');
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    const values = dbMock.dbWrite.$queryRaw.mock.calls[0].slice(1);
    expect(values).toEqual([
      'pubreq_R',
      APP,
      ['cards', 'notes'],
      ['[{"op":"remove","path":"/legacy"}]', '[{"op":"default","path":"/s","value":1}]'],
    ]);
  });

  it('reports a missing table instead of throwing', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(tableMissing);
    expect(
      await recordStorageMigrationRuns({
        publishRequestId: 'pubreq_R',
        appBlockId: APP,
        plans: new Map([['cards', [{ op: 'remove' as const, path: '/x' }]]]),
      })
    ).toBe('table_missing');
  });
});

describe('resumeStorageMigrationRuns', () => {
  it('🔴 F2: first fails every open run at the attempt cap (pending, or running and stale), so none blocks approves forever', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([1]).mockResolvedValueOnce([]);
    expect(await resumeStorageMigrationRuns()).toEqual({
      advanced: 0,
      held: 0,
      tableMissing: false,
    });
    const [giveUp, pick] = dbMock.dbWrite.$queryRaw.mock.calls;
    const giveUpSql = (giveUp[0] as readonly string[]).join('?');
    expect(giveUpSql).toContain(`SET "status" = 'failed'`);
    // F2: at the cap, a PENDING run (a reclaim raised it, then a transient error saved it) is
    // failed too, not only a running one whose heartbeat went stale.
    expect(giveUpSql).toContain(`WHERE "attempts" >= ?::int`);
    expect(giveUpSql).toContain(`("status" = 'pending'`);
    expect(giveUpSql).toContain(
      `OR ("status" = 'running' AND "heartbeat_at" < CURRENT_TIMESTAMP - `
    );
    expect(giveUp[1]).toBe(5);
    expect((pick[0] as readonly string[]).join('?')).toContain(
      'ORDER BY "heartbeat_at" NULLS FIRST'
    );
  });
});

describe("the runner after a later approval (F1: loadTarget supersedes only on a change to the run's collection)", () => {
  const RUN_MANIFEST = {
    storage: {
      collections: {
        cards: {
          visibility: 'private',
          schema: { type: 'object', additionalProperties: false, properties: { keep: {} } },
        },
        notes: { visibility: 'private' },
      },
    },
  };
  const run = {
    publishRequestId: 'pubreq_RUN',
    collection: 'cards',
    appBlockId: APP,
    ops: [{ op: 'remove' as const, path: '/legacy' }],
    status: 'running' as const,
    cursor: null,
    scanned: 0,
    migrated: 0,
    unchanged: 0,
    failed: 0,
    invalid: 0,
    failures: [],
    lastError: null,
    attempts: 0,
    claimToken: 'claim-1',
  };
  const page = {
    scanned: 1,
    migrated: 1,
    unchanged: 0,
    failed: 0,
    invalid: 0,
    failures: [],
    next: null,
  };
  const wire = (latest: { id: string; manifest: unknown } | null, status = 'approved') => {
    dbMock.dbWrite.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      slug: 'card-app',
      manifest: RUN_MANIFEST,
      status,
    });
    dbMock.dbWrite.appBlockPublishRequest.findFirst.mockResolvedValueOnce(latest);
  };
  const storeReturning = () => {
    const migrateDocuments = vi.fn(async () => page);
    return { migrateDocuments, store: { migrateDocuments } as never };
  };

  it('🔴 a later approval that left the collection untouched does NOT supersede the run: it continues', async () => {
    // v3: a copy change plus a change to ANOTHER collection.
    const v3 = {
      name: 'Cards v3',
      storage: {
        collections: {
          ...RUN_MANIFEST.storage.collections,
          notes: { visibility: 'private', schema: { type: 'object' } },
        },
      },
    };
    wire({ id: 'pubreq_V3', manifest: v3 });
    const { migrateDocuments, store } = storeReturning();
    const left = await advanceStorageMigrationRun(run, { store, persist: async () => undefined });
    expect(left.status).toBe('completed');
    expect(migrateDocuments).toHaveBeenCalledTimes(1);
    // Against the latest approved declaration of `cards` (the same storage config). No enforced
    // manifest is wired here, so its schema major is not known.
    expect((migrateDocuments.mock.calls[0] as unknown[])[1]).toEqual({
      name: 'cards',
      config: expect.objectContaining({
        visibility: 'private',
        schema: RUN_MANIFEST.storage.collections.cards.schema,
      }),
      schemaMajor: null,
    });
  });

  it("🔴 the run's collection carries its current schema major, derived from the approved history and the enforced manifest", async () => {
    // `cards` @v1 had `legacy`; the run's request dropped it from a closed schema (not additive),
    // which minted @v2. Rows in an order the derivation must not depend on.
    const V1 = {
      storage: {
        collections: {
          ...RUN_MANIFEST.storage.collections,
          cards: {
            visibility: 'private',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { keep: {}, legacy: {} },
            },
          },
        },
      },
    };
    wire({ id: 'pubreq_RUN', manifest: RUN_MANIFEST });
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValueOnce({ manifest: RUN_MANIFEST });
    dbMock.dbRead.appBlockPublishRequest.findMany.mockResolvedValueOnce([
      { id: 'pubreq_RUN', manifest: RUN_MANIFEST, reviewedAt: new Date('2026-11-02T00:00:00Z') },
      { id: 'pubreq_V1', manifest: V1, reviewedAt: new Date('2026-11-01T00:00:00Z') },
    ]);
    const { migrateDocuments, store } = storeReturning();
    const left = await advanceStorageMigrationRun(
      { ...run, appBlockId: 'ab_GATE_MAJOR_4102' },
      { store, persist: async () => undefined }
    );
    expect(left.status).toBe('completed');
    expect((migrateDocuments.mock.calls[0] as unknown[])[1]).toMatchObject({
      name: 'cards',
      schemaMajor: 2,
    });
    expect(dbMock.dbWrite.appBlock.findUnique).toHaveBeenCalledWith({
      where: { id: 'ab_GATE_MAJOR_4102' },
      select: { manifest: true, updatedAt: true },
    });
  });

  it('🔴 a later approval that changed the collection supersedes the run, without touching the store', async () => {
    const v3 = {
      storage: {
        collections: { ...RUN_MANIFEST.storage.collections, cards: { visibility: 'private' } },
      },
    };
    wire({ id: 'pubreq_V3', manifest: v3 });
    const { migrateDocuments, store } = storeReturning();
    const left = await advanceStorageMigrationRun(run, { store, persist: async () => undefined });
    expect(left.status).toBe('superseded');
    expect(migrateDocuments).not.toHaveBeenCalled();
  });

  it("the run's own request still being the latest approval runs normally", async () => {
    wire({ id: 'pubreq_RUN', manifest: RUN_MANIFEST });
    const { store } = storeReturning();
    expect(
      (await advanceStorageMigrationRun(run, { store, persist: async () => undefined })).status
    ).toBe('completed');
  });
});

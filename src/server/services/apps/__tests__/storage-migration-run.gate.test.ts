import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const {
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
  const PLAN = new Map([['cards', [{ op: 'remove' as const, path: '/legacy' }]]]);
  const NO_PLAN = new Map<string, { op: 'remove'; path: string }[]>();
  const reserve = (plans: ReadonlyMap<string, readonly { op: 'remove'; path: string }[]>) =>
    reserveStorageMigrationRuns({ appBlockId: APP, publishRequestId: 'pubreq_SELF', plans });
  const OPEN_MESSAGE =
    'Cannot approve: an earlier storage migration of this app is still running (publish request pubreq_OPEN1, collection cards), and approving a newer version now would leave it half-done. Approve again once it has finished.';

  it('🔴 refuses a plan while the runs table is missing', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(tableMissing);
    await expect(reserve(PLAN)).rejects.toThrow(
      'Cannot approve: this version migrates stored App Storage documents, but the app_storage_migration_runs table does not exist yet. Apply migration 20261221120000_app_storage_migration_runs first, then approve again.'
    );
  });

  it('a version without a plan passes while the runs table is missing (no run can be open)', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(tableMissing);
    await expect(reserve(NO_PLAN)).resolves.toBeUndefined();
  });

  it.each([
    ['with a plan', PLAN],
    ['🔴 WITHOUT a plan (a copy change must not strand the run either)', NO_PLAN],
  ])('refuses %s while an earlier run of the app is open, naming it', async (_l, plans) => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([
      { publish_request_id: 'pubreq_OPEN1', collection: 'cards', status: 'running' },
    ]);
    await expect(reserve(plans)).rejects.toThrow(OPEN_MESSAGE);
    // Nothing reserved: the only statement after the lock was the read.
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('🔴 takes the per-app lock, excludes its own request from the open check, then reserves the plan, in one transaction', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([1]);
    await expect(reserve(PLAN)).resolves.toBeUndefined();
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    const lock = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect((lock[0] as readonly string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(lock.slice(1)).toEqual([0x41534d01, APP]);
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

  it('without a plan, checks under the lock and reserves nothing', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);
    await expect(reserve(NO_PLAN)).resolves.toBeUndefined();
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rethrows any other error (fail-closed)', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));
    await expect(reserve(NO_PLAN)).rejects.toThrow('connection reset');
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
  it('first fails the runs whose runner was lost at the attempt cap, so they stop blocking approves', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([1]).mockResolvedValueOnce([]);
    expect(await resumeStorageMigrationRuns()).toEqual({ advanced: 0, tableMissing: false });
    const [giveUp, pick] = dbMock.dbWrite.$queryRaw.mock.calls;
    const giveUpSql = (giveUp[0] as readonly string[]).join('?');
    expect(giveUpSql).toContain(`SET "status" = 'failed'`);
    expect(giveUpSql).toContain(`WHERE "status" = 'running' AND "attempts" >= ?::int`);
    expect(giveUp[1]).toBe(5);
    expect((pick[0] as readonly string[]).join('?')).toContain(
      'ORDER BY "heartbeat_at" NULLS FIRST'
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const {
  assertStorageMigrationsCanStart,
  loadStorageMigrationBaseline,
  recordStorageMigrationRuns,
} = await import('~/server/services/apps/storage-migration-run.service');

/**
 * The approve-side guards of App Storage schema migrations, over the canonical db mock:
 *   - approve is refused while the runs table is missing (nothing could record or resume the run),
 *     or while an earlier run of the same app is still open (it would be left half-done);
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

describe('assertStorageMigrationsCanStart', () => {
  it('🔴 refuses while the runs table is missing', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(tableMissing);
    await expect(assertStorageMigrationsCanStart(APP)).rejects.toThrow(
      'Cannot approve: this version migrates stored App Storage documents, but the app_storage_migration_runs table does not exist yet. Apply migration 20261221120000_app_storage_migration_runs first, then approve again.'
    );
  });

  it('🔴 refuses while an earlier run of the app is still open, naming it', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([
      { publish_request_id: 'pubreq_OPEN1', collection: 'cards', status: 'running' },
    ]);
    await expect(assertStorageMigrationsCanStart(APP)).rejects.toThrow(
      'Cannot approve: an earlier storage migration of this app is still running (publish request pubreq_OPEN1, collection cards), and approving a newer version now would leave it half-done. Approve again once it has finished.'
    );
  });

  it('allows the approve when no run of the app is open', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);
    await expect(assertStorageMigrationsCanStart(APP)).resolves.toBeUndefined();
  });

  it('rethrows any other error (fail-closed)', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));
    await expect(assertStorageMigrationsCanStart(APP)).rejects.toThrow('connection reset');
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

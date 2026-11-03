import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The per-source consent ledger for cross-app storage imports, against the canonical db mock:
 * what the mints read to decide whether `apps:storage:import` is signed, and how a database
 * without the hand-applied table behaves (fail-closed reads, refused writes).
 */

const {
  getStorageImportGrant,
  importScopeCoverage,
  listStorageImportGrants,
  recordStorageImportGrants,
  withholdUncoveredImportScope,
} = await import('~/server/services/apps/storage-import-grant.service');

const IMPORT = 'apps:storage:import';
const CONSUMER = { id: 'apb_consumer_3301', manifest: {} as unknown };
const manifestImporting = (...froms: string[]) => ({
  scopes: ['apps:storage', IMPORT],
  storage: {
    imports: froms.map((from) => ({ from, collections: ['notes'], access: 'readwrite' })),
  },
});

/** Approved apps by blockId, and the grant rows the ledger holds for the consumer. */
function world(approved: Record<string, string>, grantedSourceIds: string[]) {
  dbMock.dbRead.appBlock.findMany.mockImplementation(
    async ({ where }: { where: { blockId: { in: string[] } } }) =>
      where.blockId.in
        .filter((b) => b in approved)
        .map((blockId) => ({ id: approved[blockId], blockId, manifest: { name: blockId } }))
  );
  // Only the ledger's SELECT is answered here; its real SQL runs in
  // `storage-import-grant.sql.behavior.test.ts`.
  dbMock.dbWrite.$queryRaw.mockImplementation(async () =>
    grantedSourceIds.map((sourceAppBlockId) => ({
      sourceAppBlockId,
      collections: ['notes'],
      access: 'readwrite',
    }))
  );
}

// What the mint does with the coverage answer. The coverage rule itself (collections, access,
// a dropped source) runs on real Postgres in `storage-import-grant.sql.behavior.test.ts`.
describe('the mint signs apps:storage:import only while every reachable source is granted', () => {
  const SCOPES = ['apps:storage', IMPORT];

  it('covered: the scope stays signable', async () => {
    world({ 'notes-app': 'apb_src_3311' }, ['apb_src_3311']);
    const covered = await importScopeCoverage(
      7301,
      { ...CONSUMER, manifest: manifestImporting('notes-app') },
      SCOPES
    );
    expect(covered).toBe(true);
    expect(withholdUncoveredImportScope({ signable: SCOPES, missing: [] }, covered)).toEqual({
      signable: SCOPES,
      missing: [],
    });
  });

  it('a source added later, with no grant, withholds the scope and reports it missing', async () => {
    world({ 'notes-app': 'apb_src_3311', 'words-app': 'apb_src_3312' }, ['apb_src_3311']);
    const covered = await importScopeCoverage(
      7301,
      { ...CONSUMER, manifest: manifestImporting('notes-app', 'words-app') },
      SCOPES
    );
    expect(covered).toBe(false);
    expect(
      withholdUncoveredImportScope({ signable: SCOPES, missing: ['posts:write:self'] }, covered)
    ).toEqual({ signable: ['apps:storage'], missing: ['posts:write:self', IMPORT] });
  });

  it('a declared source no approved app holds needs no grant', async () => {
    world({}, []);
    expect(
      await importScopeCoverage(
        7301,
        { ...CONSUMER, manifest: manifestImporting('gone-app') },
        SCOPES
      )
    ).toBe(true);
  });

  it('nothing is read when the token would not carry the scope', async () => {
    world({ 'notes-app': 'apb_src_3311' }, []);
    // Shared mocks reset per FILE, not per test.
    dbMock.dbRead.appBlock.findMany.mockClear();
    expect(
      await importScopeCoverage(7301, { ...CONSUMER, manifest: manifestImporting('notes-app') }, [
        'apps:storage',
      ])
    ).toBeNull();
    expect(dbMock.dbRead.appBlock.findMany).not.toHaveBeenCalled();
  });
});

describe('a database without the hand-applied table', () => {
  // Prisma's raw-query spelling: the SQLSTATE travels in the message.
  const missing = Object.assign(
    new Error(
      'Raw query failed. Code: `42P01`. Message: `relation "app_storage_import_grants" does not exist`'
    ),
    { code: 'P2010', meta: { code: '42P01' } }
  );

  it('reads as nobody granted anything', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(missing);
    expect(
      await listStorageImportGrants({ userId: 7301, consumerAppBlockId: CONSUMER.id })
    ).toEqual(new Map());
  });

  it('refuses a grant write out loud', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(missing);
    await expect(
      recordStorageImportGrants({
        userId: 7301,
        consumerAppBlockId: CONSUMER.id,
        grants: [{ sourceAppBlockId: 'apb_src_3311', collections: ['notes'], access: 'read' }],
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Sharing data between apps is not available yet. Try again later.',
    });
  });

  it('any other database failure still throws', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('connection reset'));
    await expect(
      listStorageImportGrants({ userId: 7301, consumerAppBlockId: CONSUMER.id })
    ).rejects.toThrow('connection reset');
  });
});

describe('a database whose table predates the collections and access columns', () => {
  // `undefined_column`: a table created by the earlier draft of the migration. Fail closed like
  // a missing table, never a 500 on every import call.
  const oldShape = Object.assign(
    new Error('Raw query failed. Code: `42703`. Message: `column "collections" does not exist`'),
    { code: 'P2010', meta: { code: '42703' } }
  );

  it('reads as nobody granted anything', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(oldShape);
    expect(
      await listStorageImportGrants({ userId: 7301, consumerAppBlockId: CONSUMER.id })
    ).toEqual(new Map());
    expect(
      await getStorageImportGrant({
        userId: 7301,
        consumerAppBlockId: CONSUMER.id,
        sourceAppBlockId: 'apb_src_3311',
      })
    ).toBeNull();
  });

  it('refuses a grant write out loud', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(oldShape);
    await expect(
      recordStorageImportGrants({
        userId: 7301,
        consumerAppBlockId: CONSUMER.id,
        grants: [{ sourceAppBlockId: 'apb_src_3311', collections: ['notes'], access: 'read' }],
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Sharing data between apps is not available yet. Try again later.',
    });
  });
});

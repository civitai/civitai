import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createCollectionReadDecider,
  type DataReader,
} from '~/server/services/apps/data-read-grant';

/**
 * The collection-read predicate, directly: each basis (own, grant) and each refusal, reached
 * with a case every earlier check passes. The manifests are parsed for real
 * (`parseManifestStorage`), and the scope ledger, the per-source grant read and `importGrantCovers`
 * are the real services over a stubbed database: the app rows, the scope-ledger row and the grant
 * row. The run gate is passed in.
 *
 * Every id, client and collection is pairwise distinct, and none equals a constant the code
 * names, so a check that compares the wrong pair of values cannot pass by coincidence.
 */

const runGate = vi.fn<(userId: number) => Promise<void>>();
const decideCollectionRead = createCollectionReadDecider({ assertMayRunApps: runGate });

const USER_ID = 5813;
const SOURCE_CLIENT = 'oc-src-41d7';
const CONSUMER_CLIENT = 'oc-con-9b02';
const STRANGER_CLIENT = 'oc-nobody-6e15';
const SOURCE_ID = 'apb_src_7731';
const SOURCE_BLOCK = 'notes-hub-2264';
const CONSUMER_ID = 'apb_con_5590';
const MATURE_RATING = 'x';
const PLAIN_RATING = 'pg13';

/** The source: `journal` (exportable), `vault` (not exportable), `ledger` (exportable). */
const sourceManifest = (rating = PLAIN_RATING) => ({
  contentRating: rating,
  scopes: ['apps:storage'],
  storage: {
    collections: {
      journal: { visibility: 'private' },
      vault: { visibility: 'private', exportable: false },
      ledger: { visibility: 'private' },
    },
  },
});
/** A consumer importing `collections` from the source. */
const consumerManifest = (collections: string[], access: 'read' | 'readwrite' = 'read') => ({
  scopes: ['apps:storage', 'apps:storage:import'],
  storage: {
    collections: { scratch: { visibility: 'private' } },
    imports: [{ from: SOURCE_BLOCK, collections, access }],
  },
});

type Row = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let rows: Row[];
const sourceRow = (over: Partial<Row> = {}): Row => ({
  id: SOURCE_ID,
  appId: SOURCE_CLIENT,
  blockId: SOURCE_BLOCK,
  status: 'approved',
  manifest: sourceManifest(),
  ...over,
});
const consumerRow = (manifest: unknown, over: Partial<Row> = {}): Row => ({
  id: CONSUMER_ID,
  appId: CONSUMER_CLIENT,
  blockId: 'reader-app-8143',
  status: 'approved',
  manifest,
  ...over,
});

const ceilingSeen: Array<string | null> = [];
const reader = (clientId: string): DataReader => ({
  userId: USER_ID,
  clientId,
  matureAllowed: (rating) => {
    ceilingSeen.push(rating);
    return rating !== MATURE_RATING;
  },
});
const target = (collection: string) => ({ sourceBlockId: SOURCE_BLOCK, collection });

/** The viewer's scope-ledger row for the consumer: its granted scopes, or no row. */
let ledgerScopes: string[] | null;
/** The viewer's per-source grant row for (consumer, source), or none. */
let grantRow: { collections: string[]; access: 'read' | 'readwrite' } | null;
/** Each grant-row read's bound values: user, consumer, source. */
let grantReads: unknown[][];
const ledgerRead = () => dbMock.dbWrite.appUserScopeGrant.findUnique;

beforeEach(() => {
  ceilingSeen.length = 0;
  rows = [sourceRow(), consumerRow(consumerManifest(['journal']))];
  dbMock.dbRead.appBlock.findUnique.mockClear();
  dbMock.dbRead.appBlock.findMany.mockClear();
  dbMock.dbRead.appBlock.findUnique.mockImplementation(
    async ({ where }: { where: { blockId: string } }) =>
      rows.find((r) => r.blockId === where.blockId) ?? null
  );
  dbMock.dbRead.appBlock.findMany.mockImplementation(
    async ({ where }: { where: { appId: string; status: string } }) =>
      rows.filter((r) => r.appId === where.appId && r.status === where.status)
  );
  runGate.mockReset().mockResolvedValue(undefined);
  ledgerScopes = ['apps:storage', 'apps:storage:import'];
  grantRow = { collections: ['journal'], access: 'read' };
  grantReads = [];
  ledgerRead().mockClear();
  ledgerRead().mockImplementation(async () =>
    ledgerScopes ? { grantedScopes: ledgerScopes, revokedAt: null, revokedScopes: [] } : null
  );
  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join('?').includes('app_storage_import_grants')) return [];
      grantReads.push(values);
      return grantRow ? [{ sourceAppBlockId: SOURCE_ID, ...grantRow }] : [];
    }
  );
});

describe('basis own: the reading client is the source app', () => {
  it('reads a declared collection, exportable or not, with no import, scope or grant read', async () => {
    expect(await decideCollectionRead(reader(SOURCE_CLIENT), target('journal'))).toMatchObject({
      ok: true,
      basis: 'own',
      source: { id: SOURCE_ID, appId: SOURCE_CLIENT },
    });
    expect(await decideCollectionRead(reader(SOURCE_CLIENT), target('vault'))).toMatchObject({
      ok: true,
      basis: 'own',
    });
    expect(ledgerRead()).not.toHaveBeenCalled();
    expect(grantReads).toEqual([]);
    expect(runGate).toHaveBeenCalledWith(USER_ID);
  });

  it('🔴 a client with a second approved app reads neither as its own', async () => {
    // A second approved app under the SAME client, with a collection it does not export.
    rows.push({
      id: 'apb_twin_4402',
      appId: SOURCE_CLIENT,
      blockId: 'twin-block-9317',
      status: 'approved',
      manifest: sourceManifest(),
    });
    expect(
      await decideCollectionRead(reader(SOURCE_CLIENT), {
        sourceBlockId: 'twin-block-9317',
        collection: 'vault',
      })
    ).toEqual({ ok: false, reason: 'client_owns_multiple_blocks' });
    expect(await decideCollectionRead(reader(SOURCE_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'client_owns_multiple_blocks',
    });
    // Control: the second app not approved, the client owns one approved app again.
    rows[rows.length - 1].status = 'pending';
    expect(await decideCollectionRead(reader(SOURCE_CLIENT), target('journal'))).toMatchObject({
      ok: true,
      basis: 'own',
    });
  });

  it('refuses an unapproved source', async () => {
    rows = [sourceRow({ status: 'pending' })];
    expect(await decideCollectionRead(reader(SOURCE_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'source_not_approved',
    });
  });

  it('refuses a user who may not run apps', async () => {
    runGate.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    expect(await decideCollectionRead(reader(SOURCE_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'apps_disabled',
    });
  });

  it('refuses a collection the source does not declare', async () => {
    expect(await decideCollectionRead(reader(SOURCE_CLIENT), target('diary'))).toEqual({
      ok: false,
      reason: 'collection_not_declared',
    });
  });

  it('refuses a source over the mature ceiling, asking the ceiling with the source rating', async () => {
    rows = [sourceRow({ manifest: sourceManifest(MATURE_RATING) })];
    expect(await decideCollectionRead(reader(SOURCE_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'source_rating',
    });
    expect(ceilingSeen).toEqual([MATURE_RATING]);
  });
});

describe('basis grant: the reading client is another app importing from the source', () => {
  it('reads an imported, exportable collection the user granted', async () => {
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('journal'))).toMatchObject({
      ok: true,
      basis: 'grant',
      source: { id: SOURCE_ID },
    });
    // The consent read is the viewer's ledger row for the CONSUMER, on the primary.
    expect(ledgerRead()).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_appBlockId: { userId: USER_ID, appBlockId: CONSUMER_ID } },
      })
    );
    expect(grantReads).toEqual([[USER_ID, CONSUMER_ID, SOURCE_ID]]);
    expect(ceilingSeen).toEqual([PLAIN_RATING]);
  });

  it('a client that is not the source app is never read as own', async () => {
    // No approved app is this client: not the source's own read, and no consumer either.
    expect(await decideCollectionRead(reader(STRANGER_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'consumer_not_found',
    });
  });

  it('refuses when two approved apps share the client: the consumer is never guessed', async () => {
    rows.push(consumerRow(consumerManifest(['journal']), { id: 'apb_con_twin_3318' }));
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'consumer_ambiguous',
    });
  });

  it('refuses a collection the consumer does not declare importing', async () => {
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('ledger'))).toEqual({
      ok: false,
      reason: 'import_not_declared',
    });
    expect(grantReads).toEqual([]);
  });

  it('refuses a collection the source does not share', async () => {
    rows = [sourceRow(), consumerRow(consumerManifest(['vault']))];
    grantRow = { collections: ['vault'], access: 'read' };
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('vault'))).toEqual({
      ok: false,
      reason: 'not_exportable',
    });
  });

  it('refuses without the apps:storage:import scope grant', async () => {
    ledgerScopes = ['apps:storage'];
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'import_scope_missing',
    });
    expect(grantReads).toEqual([]);
  });

  it('refuses when the per-source grant does not cover the import', async () => {
    rows = [sourceRow(), consumerRow(consumerManifest(['journal', 'ledger']))];
    // A row naming only one of the two imported collections.
    grantRow = { collections: ['journal'], access: 'read' };
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'import_not_granted',
    });
    // No row at all.
    grantRow = null;
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'import_not_granted',
    });
  });

  it('refuses a source over the mature ceiling', async () => {
    rows = [sourceRow({ manifest: sourceManifest(MATURE_RATING) }), rows[1]];
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'source_rating',
    });
    expect(ceilingSeen).toEqual([MATURE_RATING]);
  });

  it('refuses an unapproved source before resolving the consumer', async () => {
    rows = [sourceRow({ status: 'rejected' }), rows[1]];
    expect(await decideCollectionRead(reader(CONSUMER_CLIENT), target('journal'))).toEqual({
      ok: false,
      reason: 'source_not_approved',
    });
    expect(dbMock.dbRead.appBlock.findMany).not.toHaveBeenCalled();
  });
});

describe('through a verified block token (via)', () => {
  const via = (over: Partial<{ importScope: 'held' | 'missing' | 'unavailable' }> = {}) => ({
    appBlockId: CONSUMER_ID,
    imports: new Map([
      [
        SOURCE_BLOCK,
        { from: SOURCE_BLOCK, collections: new Set(['journal']), access: 'read' as const },
      ],
    ]),
    importScope: 'held' as const,
    ...over,
  });

  it('grants from the token consumer, without re-reading the consumer, its scopes or the run gate', async () => {
    expect(await decideCollectionRead(reader(''), target('journal'), via())).toMatchObject({
      ok: true,
      basis: 'grant',
    });
    expect(dbMock.dbRead.appBlock.findMany).not.toHaveBeenCalled();
    expect(ledgerRead()).not.toHaveBeenCalled();
    expect(runGate).not.toHaveBeenCalled();
  });

  it('refuses the source being the consumer itself, even when its client is the reader', async () => {
    expect(
      await decideCollectionRead(reader(SOURCE_CLIENT), target('journal'), {
        ...via(),
        appBlockId: SOURCE_ID,
      })
    ).toEqual({ ok: false, reason: 'import_self' });
  });

  it('carries the token consent state: missing, and unreadable', async () => {
    expect(
      await decideCollectionRead(reader(''), target('journal'), via({ importScope: 'missing' }))
    ).toEqual({ ok: false, reason: 'import_scope_missing' });
    expect(
      await decideCollectionRead(reader(''), target('journal'), via({ importScope: 'unavailable' }))
    ).toEqual({ ok: false, reason: 'import_scope_unavailable' });
  });

  it('refuses an undeclared import before any read', async () => {
    expect(await decideCollectionRead(reader(''), target('ledger'), via())).toEqual({
      ok: false,
      reason: 'import_not_declared',
    });
    expect(dbMock.dbRead.appBlock.findUnique).not.toHaveBeenCalled();
  });
});

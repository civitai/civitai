import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * The per-source import ledger's REAL SQL — the INSERT … `unnest` … ON CONFLICT, the reads and
 * the DELETEs of `storage-import-grant.service.ts` — against an in-process Postgres running the
 * real hand-applied migration. Only the two tables its foreign keys name are stand-ins.
 *
 * And the rule the mint and the storage route read through that SQL: a grant covers exactly the
 * collections and access the viewer was shown. A later version that imports another collection,
 * or turns `read` into `readwrite`, is not covered; one that narrows is; and a source that was
 * dropped and is declared again is prompted for again.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

type Raw = ReturnType<typeof pgliteRaw>;
for (const client of [dbMock.dbWrite, dbMock.dbRead]) {
  client.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
    pgliteRaw(holder.db).queryRaw(...a)) as never);
}

const {
  isImportScopeCovered,
  getStorageImportGrant,
  listStorageImportGrants,
  recordStorageImportGrants,
  revokeStorageImportGrant,
} = await import('~/server/services/apps/storage-import-grant.service');

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261218120000_app_storage_import_grants/migration.sql'
);

const UID = 7341;
const OTHER_UID = 7348;
const CONSUMER = 'apb_consumer_3401';
/** Approved source apps, by blockId. */
const SOURCES: Record<string, string> = {
  'notes-app': 'apb_src_3411',
  'words-app': 'apb_src_3412',
};

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    CREATE TABLE "app_blocks" ("id" text PRIMARY KEY);
    INSERT INTO "User" VALUES (${UID}), (${OTHER_UID});
    INSERT INTO "app_blocks" VALUES ('${CONSUMER}'), ('apb_src_3411'), ('apb_src_3412');
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
  dbMock.dbRead.appBlock.findMany.mockImplementation(
    async ({ where }: { where: { blockId: { in: string[] } } }) =>
      where.blockId.in
        .filter((b) => b in SOURCES)
        .map((blockId) => ({ id: SOURCES[blockId], blockId, manifest: { name: blockId } }))
  );
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "app_storage_import_grants"`);
});

const rows = async () =>
  (
    await holder.db.query<{
      user_id: number;
      source_app_block_id: string;
      collections: string[];
      access: string;
    }>(
      `SELECT "user_id", "source_app_block_id", "collections", "access"
       FROM "app_storage_import_grants" ORDER BY "user_id", "source_app_block_id"`
    )
  ).rows;

type Decl = { from: string; collections: string[]; access: 'read' | 'readwrite' };
const manifestImporting = (...imports: Decl[]) => ({
  scopes: ['apps:storage', 'apps:storage:import'],
  storage: imports.length > 0 ? { imports } : { collections: { own: { visibility: 'private' } } },
});
const grantFor = (uid: number, ...imports: Decl[]) =>
  recordStorageImportGrants({
    userId: uid,
    consumerAppBlockId: CONSUMER,
    grants: imports.map((i) => ({
      sourceAppBlockId: SOURCES[i.from],
      collections: i.collections,
      access: i.access,
    })),
  });
const covered = (uid: number, ...imports: Decl[]) =>
  isImportScopeCovered({
    userId: uid,
    consumerAppBlockId: CONSUMER,
    manifest: manifestImporting(...imports),
  });

describe('the ledger SQL on the real migration', () => {
  it('records the granted collections and access per source, and a re-grant replaces them', async () => {
    await grantFor(
      UID,
      { from: 'notes-app', collections: ['notes', 'prefs'], access: 'read' },
      { from: 'words-app', collections: ['words'], access: 'readwrite' }
    );
    expect(await rows()).toEqual([
      {
        user_id: UID,
        source_app_block_id: 'apb_src_3411',
        collections: ['notes', 'prefs'],
        access: 'read',
      },
      {
        user_id: UID,
        source_app_block_id: 'apb_src_3412',
        collections: ['words'],
        access: 'readwrite',
      },
    ]);
    // The ON CONFLICT branch: the same source again, with what the new prompt showed.
    await grantFor(UID, { from: 'notes-app', collections: ['notes'], access: 'readwrite' });
    expect(
      await getStorageImportGrant({
        userId: UID,
        consumerAppBlockId: CONSUMER,
        sourceAppBlockId: 'apb_src_3411',
      })
    ).toEqual({ collections: ['notes'], access: 'readwrite' });
  });

  it('a re-grant drops a source the prompt no longer named', async () => {
    await grantFor(
      UID,
      { from: 'notes-app', collections: ['notes'], access: 'read' },
      { from: 'words-app', collections: ['words'], access: 'read' }
    );
    await grantFor(UID, { from: 'words-app', collections: ['words'], access: 'read' });
    expect((await rows()).map((r) => r.source_app_block_id)).toEqual(['apb_src_3412']);
  });

  it('lists one viewer only; a revoke deletes one row and reports whether it existed', async () => {
    await grantFor(UID, { from: 'notes-app', collections: ['notes'], access: 'read' });
    await grantFor(OTHER_UID, { from: 'words-app', collections: ['words'], access: 'read' });
    expect(await listStorageImportGrants({ userId: UID, consumerAppBlockId: CONSUMER })).toEqual(
      new Map([['apb_src_3411', { collections: ['notes'], access: 'read' }]])
    );
    const revoke = () =>
      revokeStorageImportGrant({
        userId: UID,
        consumerAppBlockId: CONSUMER,
        sourceAppBlockId: 'apb_src_3411',
      });
    expect(await revoke()).toBe(true);
    expect(await revoke()).toBe(false);
    expect(await rows()).toEqual([
      {
        user_id: OTHER_UID,
        source_app_block_id: 'apb_src_3412',
        collections: ['words'],
        access: 'read',
      },
    ]);
  });

  it('the CHECK refuses an access the code never writes', async () => {
    await expect(
      holder.db.query(
        `INSERT INTO "app_storage_import_grants"
           ("user_id", "consumer_app_block_id", "source_app_block_id", "collections", "access")
         VALUES ($1, $2, $3, ARRAY['notes'], 'write')`,
        [UID, CONSUMER, 'apb_src_3411']
      )
    ).rejects.toThrow(/app_storage_import_grants_access_check/);
  });
});

describe('a grant covers exactly what the viewer was shown', () => {
  const V1: Decl = { from: 'notes-app', collections: ['notes'], access: 'read' };

  it('the version the viewer granted is covered (control)', async () => {
    await grantFor(UID, V1);
    expect(await covered(UID, V1)).toBe(true);
  });

  it('a later version importing another collection is not covered', async () => {
    await grantFor(UID, V1);
    expect(await covered(UID, { ...V1, collections: ['notes', 'prefs'] })).toBe(false);
  });

  it('a later version turning read into readwrite is not covered', async () => {
    await grantFor(UID, V1);
    expect(await covered(UID, { ...V1, access: 'readwrite' })).toBe(false);
  });

  it('a later version that narrows is still covered', async () => {
    await grantFor(UID, {
      from: 'notes-app',
      collections: ['notes', 'prefs'],
      access: 'readwrite',
    });
    expect(await covered(UID, V1)).toBe(true);
  });

  it('a source dropped and declared again is prompted for again', async () => {
    await grantFor(UID, V1, { from: 'words-app', collections: ['words'], access: 'read' });
    // A mint under the version that dropped notes-app: nothing it imports needs that grant.
    expect(await covered(UID, { from: 'words-app', collections: ['words'], access: 'read' })).toBe(
      true
    );
    // The same declaration as before is back: the stale grant does not cover it.
    expect(
      await covered(UID, V1, { from: 'words-app', collections: ['words'], access: 'read' })
    ).toBe(false);
    expect((await rows()).map((r) => r.source_app_block_id)).toEqual(['apb_src_3412']);
  });
});

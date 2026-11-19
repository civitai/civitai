import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as EnvServer from '~/env/server';

/**
 * A DELETED source app's data, reached through another app's import, against an in-process
 * Postgres holding `app_blocks` (with the hand-applied `storage_deleted_at` column and the real
 * slug uniqueness constraint) and the real import-grant ledger migration:
 *   - with the record core ON, a grant the viewer gave before the deletion still READS the
 *     source's data, every write is refused, and an import with no grant is refused (never a
 *     consent prompt); the consent surfaces never offer the source, so no new grant can name it,
 *     and an existing grant survives every prune;
 *   - with the record core OFF, a deleted source is an unapproved one, exactly as before;
 *   - a deleted app's slug stays taken: no second app row can claim it.
 * Expected values are literals.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const flags = vi.hoisted(() => ({ recordCore: false }));
vi.mock('~/env/server', async (importOriginal) => {
  const mod = await importOriginal<typeof EnvServer>();
  return {
    ...mod,
    env: new Proxy(mod.env, {
      get: (target, prop) =>
        prop === 'APP_RECORD_CORE_ENABLED' ? flags.recordCore : Reflect.get(target, prop),
    }),
  };
});

// `server-domain.ts` reads its host map at import: civitai.red is red-capable, civitai.com is not.
vi.stubEnv('SERVER_DOMAIN_GREEN', 'civitai.green');
vi.stubEnv('SERVER_DOMAIN_GREEN_ALIASES', '');
vi.stubEnv('SERVER_DOMAIN_BLUE', 'civitai.com');
vi.stubEnv('SERVER_DOMAIN_BLUE_ALIASES', 'civitai.red');
vi.stubEnv('SERVER_DOMAIN_RED', 'civitai.red');
vi.stubEnv('SERVER_DOMAIN_RED_ALIASES', '');

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
for (const client of [dbMock.dbWrite, dbMock.dbRead]) {
  client.$queryRaw.mockImplementation(((
    ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
  ) => pgliteRaw(holder.db).queryRaw(...a)) as never);
}

const { resolveImportAccess } = await import('~/server/services/apps/doc-store-access');
const {
  grantImportSourcePublish,
  isImportScopeCovered,
  listStorageImportGrants,
  recordStorageImportGrants,
  resolveDeclaredImports,
} = await import('~/server/services/apps/storage-import-grant.service');
const { deletedAppBlockIds } = await import('~/server/services/apps/deleted-app-storage');
const { parseManifestStorage, APP_STORAGE_ALL_FEATURES_ON } = await import(
  '~/shared/constants/block-storage.constants'
);

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations'
);
const GRANTS_MIGRATION = path.join(
  MIGRATIONS,
  '20261218120000_app_storage_import_grants/migration.sql'
);
/** The slug constraint, read from the migration that added it; throws if it is no longer there. */
function slugConstraint(): string {
  const sql = readFileSync(
    path.join(MIGRATIONS, '20260528210000_w1_uniqueness_constraints/migration.sql'),
    'utf8'
  );
  const m = sql.match(
    /ALTER TABLE "app_blocks"\s+ADD CONSTRAINT "app_blocks_block_id_unique"[^;]*;/
  );
  if (!m) throw new Error('app_blocks_block_id_unique not found in its migration');
  return m[0];
}

// Pairwise distinct ids, distinct from every other suite's.
const UID = 6_417;
const OTHER_UID = 6_428;
const CONSUMER = 'apb_cons_6401';
const DELETED = { id: 'apb_del_6402', blockId: 'gone-notes' };
const LIVE = { id: 'apb_live_6403', blockId: 'live-notes' };
// Suspended (delisted) with no deletion recorded: not deleted.
const DELISTED = { id: 'apb_dls_6404', blockId: 'delisted-notes' };
// Deleted, then written again (restored to draft without clearing the column): not deleted.
const RESTORED = { id: 'apb_rst_6405', blockId: 'restored-notes' };

const T_DELETED = new Date('2026-10-01T00:00:00.000Z');
const T_BEFORE = new Date('2026-09-01T00:00:00.000Z');
const T_AFTER = new Date('2026-10-05T00:00:00.000Z');

const SOURCE_MANIFEST = {
  scopes: ['apps:storage'],
  storage: { collections: { notes: { visibility: 'private' } } },
};
const consumerManifest = (from: string, access: 'read' | 'readwrite' = 'readwrite') => ({
  scopes: ['apps:storage', 'apps:storage:import'],
  storage: { imports: [{ from, collections: ['notes'], access }] },
});

async function block(
  b: { id: string; blockId: string },
  status: string,
  deletedAt: Date | null,
  updatedAt: Date
) {
  await holder.db.query(
    `INSERT INTO app_blocks (id, block_id, status, manifest, storage_deleted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [b.id, b.blockId, status, JSON.stringify(SOURCE_MANIFEST), deletedAt, updatedAt]
  );
}

type BlockRow = { id: string; blockId: string; status: string; manifest: unknown; updatedAt: Date };
async function blocksWhere(where: {
  blockId?: string | { in: string[] };
  status?: string;
}): Promise<BlockRow[]> {
  const all = (
    await holder.db.query<BlockRow>(
      `SELECT id, block_id AS "blockId", status, manifest, updated_at AS "updatedAt" FROM app_blocks
       ORDER BY id`
    )
  ).rows;
  return all.filter(
    (r) =>
      (where.status === undefined || r.status === where.status) &&
      (where.blockId === undefined ||
        (typeof where.blockId === 'string'
          ? r.blockId === where.blockId
          : where.blockId.in.includes(r.blockId)))
  );
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    CREATE TABLE app_blocks (
      id text PRIMARY KEY,
      block_id text NOT NULL,
      status text NOT NULL,
      manifest jsonb NOT NULL,
      storage_deleted_at timestamptz,
      updated_at timestamptz NOT NULL
    );
    INSERT INTO "User" VALUES (${UID}), (${OTHER_UID});
  `);
  await holder.db.exec(slugConstraint());
  await holder.db.exec(readFileSync(GRANTS_MIGRATION, 'utf8'));
  dbMock.dbRead.appBlock.findUnique.mockImplementation(
    (async ({ where }: any) =>
      (await blocksWhere({})).find((r) =>
        where.id !== undefined ? r.id === where.id : r.blockId === where.blockId
      ) ?? null) as never
  );
  dbMock.dbRead.appBlock.findMany.mockImplementation((async ({ where }: any) =>
    blocksWhere(where)) as never);
});

afterAll(async () => {
  await holder.db?.close();
});

beforeEach(async () => {
  flags.recordCore = false;
  await holder.db.exec(`TRUNCATE "app_storage_import_grants"; DELETE FROM app_blocks;`);
  await holder.db.query(
    `INSERT INTO app_blocks (id, block_id, status, manifest, updated_at) VALUES ($1, 'consumer-app', 'approved', $2, $3)`,
    [CONSUMER, JSON.stringify(consumerManifest(DELETED.blockId)), T_BEFORE]
  );
  await block(DELETED, 'suspended', T_DELETED, T_BEFORE);
  await block(LIVE, 'approved', null, T_BEFORE);
  await block(DELISTED, 'suspended', null, T_BEFORE);
  await block(RESTORED, 'pending', T_DELETED, T_AFTER);
});

/** The consumer's own access, as `resolveStorageAccess` returns it for an ordinary app token. */
function consumerAccess(from: string, access: 'read' | 'readwrite' = 'readwrite') {
  return {
    ctx: { appId: CONSUMER, ns: 'prod', viewerUid: UID },
    scopes: ['apps:storage', 'apps:storage:import'],
    consentUnavailable: false,
    collections: new Map(),
    imports: parseManifestStorage(consumerManifest(from, access), APP_STORAGE_ALL_FEATURES_ON)
      .imports,
    tokenKind: 'app' as const,
    maxBrowsingLevel: 1,
  };
}

const grant = (sourceAppBlockId: string, access: 'read' | 'readwrite' = 'readwrite', uid = UID) =>
  recordStorageImportGrants({
    userId: uid,
    consumerAppBlockId: CONSUMER,
    grants: [{ sourceAppBlockId, collections: ['notes'], access }],
  });

const grantRows = async () =>
  (
    await holder.db.query<{ user_id: number; source_app_block_id: string; access: string }>(
      `SELECT user_id, source_app_block_id, access FROM app_storage_import_grants
       ORDER BY user_id, source_app_block_id`
    )
  ).rows;

describe('deletedAppBlockIds: the deleted-app predicate', () => {
  it('names a not-approved block with a deletion and no write since, and nothing else', async () => {
    expect([
      ...(await deletedAppBlockIds([CONSUMER, DELETED.id, LIVE.id, DELISTED.id, RESTORED.id])),
    ]).toEqual([DELETED.id]);
  });
});

describe('an import of a DELETED source, record core ON', () => {
  beforeEach(() => {
    flags.recordCore = true;
  });

  it('an existing grant still reads it, read-only, as the source app', async () => {
    await grant(DELETED.id);
    const access = await resolveImportAccess(consumerAccess(DELETED.blockId) as never, {
      from: DELETED.blockId,
      collection: 'notes',
      op: 'read',
    });
    expect(access).toMatchObject({
      ctx: { appId: DELETED.id, ns: 'prod', viewerUid: UID },
      scopes: ['apps:storage'],
      importedFrom: DELETED.blockId,
      importAccess: 'read',
    });
  });

  it('a read grant reads it too', async () => {
    await grant(DELETED.id, 'read');
    await expect(
      resolveImportAccess(consumerAccess(DELETED.blockId) as never, {
        from: DELETED.blockId,
        collection: 'notes',
        op: 'read',
      })
    ).resolves.toMatchObject({ importAccess: 'read' });
  });

  it('every write through the import is refused, even with a readwrite grant', async () => {
    await grant(DELETED.id, 'readwrite');
    for (const op of ['author', 'delete'] as const) {
      await expect(
        resolveImportAccess(consumerAccess(DELETED.blockId) as never, {
          from: DELETED.blockId,
          collection: 'notes',
          op,
        })
      ).rejects.toMatchObject({
        code: 'write_policy',
        details: { from: DELETED.blockId, reason: 'import_source_deleted' },
      });
    }
  });

  it('no grant: refused as deleted, never a consent prompt', async () => {
    // Another user's grant is not this viewer's.
    await grant(DELETED.id, 'readwrite', OTHER_UID);
    await expect(
      resolveImportAccess(consumerAccess(DELETED.blockId) as never, {
        from: DELETED.blockId,
        collection: 'notes',
        op: 'read',
      })
    ).rejects.toMatchObject({
      code: 'not_eligible',
      message: 'the app gone-notes was deleted',
      details: { reason: 'source_deleted' },
    });
  });

  it('a delisted source with no deletion, and a deleted one written since, stay unavailable', async () => {
    for (const b of [DELISTED, RESTORED]) {
      await grant(b.id);
      await expect(
        resolveImportAccess(consumerAccess(b.blockId) as never, {
          from: b.blockId,
          collection: 'notes',
          op: 'read',
        })
      ).rejects.toMatchObject({ code: 'not_eligible', details: { reason: 'source_not_approved' } });
    }
  });

  it('control: a live source with a grant reads with its declared access', async () => {
    await grant(LIVE.id);
    await expect(
      resolveImportAccess(consumerAccess(LIVE.blockId) as never, {
        from: LIVE.blockId,
        collection: 'notes',
        op: 'read',
      })
    ).resolves.toMatchObject({ ctx: { appId: LIVE.id }, importAccess: 'readwrite' });
  });

  it('the consent surfaces never offer it: it resolves as source_deleted, holding its id', async () => {
    expect(
      await resolveDeclaredImports(consumerManifest(DELETED.blockId), { host: 'civitai.com' })
    ).toEqual([
      {
        from: 'gone-notes',
        collections: ['notes'],
        access: 'readwrite',
        source: null,
        unavailable: 'source_deleted',
        unshownAppBlockId: 'apb_del_6402',
      },
    ]);
  });

  it('an existing grant survives the prune on mint, and coverage does not require the deleted source', async () => {
    await grant(DELETED.id);
    expect(
      await isImportScopeCovered({
        userId: UID,
        consumerAppBlockId: CONSUMER,
        manifest: consumerManifest(DELETED.blockId),
        host: 'civitai.com',
      })
    ).toBe(true);
    expect(await grantRows()).toEqual([
      { user_id: UID, source_app_block_id: 'apb_del_6402', access: 'readwrite' },
    ]);
  });

  it('no new grant: a re-consent records none for it and keeps the one that exists', async () => {
    await grant(DELETED.id, 'read');
    // What `blocks.grantScopes` records from the consent surface: only offered sources are
    // granted, and the unshown ones are kept.
    const imports = await resolveDeclaredImports(consumerManifest(DELETED.blockId), {
      host: 'civitai.com',
    });
    for (const uid of [UID, OTHER_UID]) {
      await recordStorageImportGrants({
        userId: uid,
        consumerAppBlockId: CONSUMER,
        keepUnshown: imports.flatMap((i) => (i.unshownAppBlockId ? [i.unshownAppBlockId] : [])),
        grants: imports.flatMap((i) =>
          i.source
            ? [
                {
                  sourceAppBlockId: i.source.appBlockId,
                  collections: i.collections,
                  access: i.access,
                },
              ]
            : []
        ),
      });
    }
    expect(await grantRows()).toEqual([
      { user_id: UID, source_app_block_id: 'apb_del_6402', access: 'read' },
    ]);
  });

  it('no new publish consent in it either: the source is not available', async () => {
    await expect(
      grantImportSourcePublish({
        userId: UID,
        consumer: {
          id: CONSUMER,
          manifest: consumerManifest(DELETED.blockId),
          approvedScopes: ['apps:storage', 'apps:storage:import'],
        },
        from: DELETED.blockId,
        host: 'civitai.com',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'gone-notes is not available' });
  });
});

describe('an import of a deleted source, record core OFF: exactly as before', () => {
  it('a grant does not reach it: not approved', async () => {
    await grant(DELETED.id);
    await expect(
      resolveImportAccess(consumerAccess(DELETED.blockId) as never, {
        from: DELETED.blockId,
        collection: 'notes',
        op: 'read',
      })
    ).rejects.toMatchObject({
      code: 'not_eligible',
      message: 'the app gone-notes is not available',
      details: { reason: 'source_not_approved' },
    });
  });

  it('the consent surface reads it as a blockId no app holds, and the mint prunes its grant', async () => {
    expect(
      await resolveDeclaredImports(consumerManifest(DELETED.blockId), { host: 'civitai.com' })
    ).toEqual([{ from: 'gone-notes', collections: ['notes'], access: 'readwrite', source: null }]);
    await grant(DELETED.id);
    await isImportScopeCovered({
      userId: UID,
      consumerAppBlockId: CONSUMER,
      manifest: consumerManifest(DELETED.blockId),
      host: 'civitai.com',
    });
    expect(await listStorageImportGrants({ userId: UID, consumerAppBlockId: CONSUMER })).toEqual(
      new Map()
    );
  });
});

describe("a deleted app's slug is never reused", () => {
  it('no second app row can take the slug a deleted app holds', async () => {
    // The deleted app's row is kept (delisting and deletion never remove it), so its slug stays
    // taken by the unique constraint.
    expect(await deletedAppBlockIds([DELETED.id])).toEqual(new Set([DELETED.id]));
    await expect(
      holder.db.query(
        `INSERT INTO app_blocks (id, block_id, status, manifest, updated_at)
         VALUES ('apb_new_6409', $1, 'approved', '{}', now())`,
        [DELETED.blockId]
      )
    ).rejects.toThrow(/app_blocks_block_id_unique/);
    // Control: a fresh slug is accepted.
    await holder.db.query(
      `INSERT INTO app_blocks (id, block_id, status, manifest, updated_at)
       VALUES ('apb_new_6409', 'fresh-notes', 'approved', '{}', now())`
    );
  });
});

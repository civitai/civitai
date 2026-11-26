import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The staff platform-update check on a version's files (`platform-update-bundle-check.ts`), with
 * its REAL queries against the two manual migrations in PGlite, and a fake source repo at the
 * git-host boundary (`forgejo.service`). Claims:
 *   - a version missing an unshipped update is reported with its id, reason, staff username and
 *     the paths it lacks; one containing it (exact bytes, or hand-merged text) is not;
 *   - a delete update holds only when the path is gone;
 *   - superseded and shipped updates are never checked; a `merged` one still is (the client's
 *     report is not read); an author who is not staff now is not checked;
 *   - the approve step marks shipped only the updates the approved files contain, and an update
 *     keeps the request that shipped it first;
 *   - off: the flag, a first version, and a missing table or `shipped` column (logged once);
 *   - only the touched paths are read from the version, in one call.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  flag: true,
  /** `${org}/${slug}@${commit}` → path → blob sha */
  trees: new Map<string, Map<string, string>>(),
  blobs: new Map<string, Buffer>(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: async (flag: string) =>
      flag === actual.FLIPT_FEATURE_FLAGS.APP_BLOCKS_PLATFORM_UPDATES ? h.flag : false,
  };
});
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  listRepoTreeAtRef: vi.fn(async (slug: string, ref: string, org: string) => {
    const tree = h.trees.get(`${org}/${slug}@${ref}`);
    if (!tree) throw new Error(`no tree ${org}/${slug}@${ref}`);
    return tree;
  }),
  getBlobContent: vi.fn(async (slug: string, sha: string, org: string) => {
    const blob = h.blobs.get(`${org}/${slug}:${sha}`);
    if (!blob) throw new Error(`no blob ${sha}`);
    return blob;
  }),
}));

const { checkPlatformUpdates, markShippedPlatformUpdates, assertBundleHasPlatformUpdates } =
  await import('~/server/services/blocks/platform-update-bundle-check');
const { FORGEJO_SOURCE_ORG } = await import('~/server/services/blocks/forgejo-orgs');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations'
);
const SHIPPED_MIGRATION = '20271206120000_app_platform_updates_shipped';
const TABLE_MIGRATION = '20271205140000_app_platform_updates';

const APP = 'apb_bundlegate_1';
const SLUG = 'bundle-gate-app';
const MOD = 51;
const EX_MOD = 52;
const BASE_SHA = 'a'.repeat(40);

const BASE_TEXT = 'export const a = 1;\n';
const UPDATE_TEXT = 'export const a = 1;\nexport const staffFix = true;\n';
const DELETED_TEXT = 'legacy\n';

let seq = 0;
/** A staff update commit on the fake source repo, cut from BASE_SHA. */
function staffCommit(files: Record<string, string | null>): string {
  seq += 1;
  const sha = seq.toString(16).padStart(40, 'c');
  const base = h.trees.get(`${FORGEJO_SOURCE_ORG}/${SLUG}@${BASE_SHA}`)!;
  const tree = new Map(base);
  for (const [p, content] of Object.entries(files)) {
    if (content === null) tree.delete(p);
    else {
      const blob = `blob-${sha}-${p}`;
      h.blobs.set(`${FORGEJO_SOURCE_ORG}/${SLUG}:${blob}`, Buffer.from(content));
      tree.set(p, blob);
    }
  }
  h.trees.set(`${FORGEJO_SOURCE_ORG}/${SLUG}@${sha}`, tree);
  return sha;
}

let pg: PGlite;
function installRaw(db: PGlite) {
  const raw = pgliteRaw(db);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw);
    client.$executeRaw.mockImplementation(raw.executeRaw);
  }
}

async function freshDb(migrations: string[]): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" (
      id INT PRIMARY KEY, username TEXT, "isModerator" BOOLEAN NOT NULL,
      "bannedAt" TIMESTAMPTZ, "deletedAt" TIMESTAMPTZ
    );
    INSERT INTO "User" VALUES (${MOD}, 'mod-jane', true, NULL, NULL),
      (${EX_MOD}, 'former-mod', false, NULL, NULL);
  `);
  for (const dir of migrations)
    await db.exec(readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  return db;
}

async function addUpdate(args: {
  id: string;
  commitSha: string;
  paths: Array<{ path: string; operation: 'create' | 'update' | 'delete' }>;
  status?: string;
  staff?: number;
  reason?: string;
  shippedIn?: string;
  at?: string;
}) {
  await pg.query(
    `INSERT INTO app_platform_updates (id, app_block_id, slug, staff_user_id, reason, branch,
       base_commit_sha, commit_sha, paths, status, shipped_in_publish_request_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
    [
      args.id,
      APP,
      SLUG,
      args.staff ?? MOD,
      args.reason ?? 'Fix the deprecated SDK call',
      `platform-update/${args.id}`,
      BASE_SHA,
      args.commitSha,
      JSON.stringify(args.paths),
      args.status ?? 'pending',
      args.shippedIn ?? null,
      args.at ?? '2027-01-01T00:00:00Z',
    ]
  );
}

/** The version under check: path → content, and every call made to read it. */
function version(files: Record<string, string>) {
  const calls: string[][] = [];
  return {
    calls,
    readFiles: async (paths: string[]) => {
      calls.push([...paths]);
      const out = new Map<string, Buffer>();
      for (const p of paths) if (p in files) out.set(p, Buffer.from(files[p]));
      return out;
    },
  };
}

const shippedColumn = async () =>
  (
    await pg.query<{ id: string; shipped: string | null; at: Date | null }>(
      `SELECT id, shipped_in_publish_request_id AS shipped, shipped_at AS at
         FROM app_platform_updates ORDER BY id`
    )
  ).rows;

beforeAll(async () => {
  pg = await freshDb([TABLE_MIGRATION, SHIPPED_MIGRATION]);
});
afterAll(() => pg.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec('TRUNCATE app_platform_updates');
  installRaw(pg);
  h.flag = true;
  h.trees = new Map();
  h.blobs = new Map();
  seq = 0;
  // The source repo's main at the updates' base: two files.
  h.blobs.set(`${FORGEJO_SOURCE_ORG}/${SLUG}:blob-base-a`, Buffer.from(BASE_TEXT));
  h.blobs.set(`${FORGEJO_SOURCE_ORG}/${SLUG}:blob-base-legacy`, Buffer.from(DELETED_TEXT));
  h.trees.set(
    `${FORGEJO_SOURCE_ORG}/${SLUG}@${BASE_SHA}`,
    new Map([
      ['src/a.ts', 'blob-base-a'],
      ['src/legacy.ts', 'blob-base-legacy'],
    ])
  );
});

describe('checkPlatformUpdates', () => {
  it('🔴 reports an update the version lacks: id, reason, staff username, the paths it lacks', async () => {
    const sha = staffCommit({ 'src/a.ts': UPDATE_TEXT, 'src/new.ts': 'export {};\n' });
    await addUpdate({
      id: 'apu_missing',
      commitSha: sha,
      paths: [
        { path: 'src/a.ts', operation: 'update' },
        { path: 'src/new.ts', operation: 'create' },
      ],
    });
    const v = version({ 'src/a.ts': BASE_TEXT, 'index.html': '<html></html>' });
    expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toEqual({
      contained: [],
      missing: [
        {
          id: 'apu_missing',
          reason: 'Fix the deprecated SDK call',
          by: 'mod-jane',
          paths: ['src/a.ts', 'src/new.ts'],
        },
      ],
    });
    // Only the touched paths, in one read.
    expect(v.calls).toEqual([['src/a.ts', 'src/new.ts']]);
  });

  it('a version with the update’s exact file contains it', async () => {
    const sha = staffCommit({ 'src/a.ts': UPDATE_TEXT });
    await addUpdate({
      id: 'apu_exact',
      commitSha: sha,
      paths: [{ path: 'src/a.ts', operation: 'update' }],
    });
    const v = version({ 'src/a.ts': UPDATE_TEXT });
    expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toEqual({
      contained: ['apu_exact'],
      missing: [],
    });
  });

  it('a hand-merged text file with every added line contains it', async () => {
    const sha = staffCommit({ 'src/a.ts': UPDATE_TEXT });
    await addUpdate({
      id: 'apu_merged',
      commitSha: sha,
      paths: [{ path: 'src/a.ts', operation: 'update' }],
    });
    const merged =
      '// owner header\nexport const a = 1;\nexport const owner = 2;\nexport const staffFix = true;\n';
    const v = version({ 'src/a.ts': merged });
    expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toEqual({
      contained: ['apu_merged'],
      missing: [],
    });
  });

  it('a delete update holds only when the path is gone', async () => {
    const sha = staffCommit({ 'src/legacy.ts': null });
    await addUpdate({
      id: 'apu_delete',
      commitSha: sha,
      paths: [{ path: 'src/legacy.ts', operation: 'delete' }],
    });
    const gone = version({ 'src/a.ts': BASE_TEXT });
    expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: gone.readFiles })).toEqual({
      contained: ['apu_delete'],
      missing: [],
    });
    const kept = version({ 'src/legacy.ts': DELETED_TEXT });
    expect(
      (await checkPlatformUpdates({ appBlockId: APP, readFiles: kept.readFiles }))?.missing
    ).toEqual([
      {
        id: 'apu_delete',
        reason: 'Fix the deprecated SDK call',
        by: 'mod-jane',
        paths: ['src/legacy.ts'],
      },
    ]);
  });

  it('🔴 never checks a superseded or a shipped update; still checks a merged one', async () => {
    const sha1 = staffCommit({ 'src/a.ts': UPDATE_TEXT });
    const sha2 = staffCommit({ 'src/b.ts': 'b\n' });
    const sha3 = staffCommit({ 'src/c.ts': 'c\n' });
    await addUpdate({
      id: 'apu_superseded',
      commitSha: sha1,
      status: 'superseded',
      paths: [{ path: 'src/a.ts', operation: 'update' }],
    });
    await addUpdate({
      id: 'apu_shipped',
      commitSha: sha2,
      shippedIn: 'pubreq_old',
      paths: [{ path: 'src/b.ts', operation: 'create' }],
    });
    await addUpdate({
      id: 'apu_merged_status',
      commitSha: sha3,
      status: 'merged',
      paths: [{ path: 'src/c.ts', operation: 'create' }],
    });
    const v = version({ 'src/a.ts': BASE_TEXT });
    expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toEqual({
      contained: [],
      missing: [
        {
          id: 'apu_merged_status',
          reason: 'Fix the deprecated SDK call',
          by: 'mod-jane',
          paths: ['src/c.ts'],
        },
      ],
    });
    // The superseded and shipped updates' paths were not even read.
    expect(v.calls).toEqual([['src/c.ts']]);
  });

  it('does not check an update whose author is not staff now', async () => {
    const sha = staffCommit({ 'src/a.ts': UPDATE_TEXT });
    await addUpdate({
      id: 'apu_exmod',
      commitSha: sha,
      staff: EX_MOD,
      paths: [{ path: 'src/a.ts', operation: 'update' }],
    });
    const v = version({ 'src/a.ts': BASE_TEXT });
    expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toEqual({
      contained: [],
      missing: [],
    });
  });

  it('is off with the flag off, and for a first version (no app): no query, no read', async () => {
    const sha = staffCommit({ 'src/a.ts': UPDATE_TEXT });
    await addUpdate({
      id: 'apu_off',
      commitSha: sha,
      paths: [{ path: 'src/a.ts', operation: 'update' }],
    });
    const v = version({});
    h.flag = false;
    expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toBeNull();
    h.flag = true;
    expect(await checkPlatformUpdates({ appBlockId: null, readFiles: v.readFiles })).toBeNull();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(v.calls).toEqual([]);
    // Positive control: the same update, flag on, IS reported.
    expect(
      (await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles }))?.missing
    ).toHaveLength(1);
  });

  it('🔴 is off while the table or the shipped columns are missing, and logs that once', async () => {
    const offMessage =
      'bundle check off: the platform-update table or its shipped columns are missing';
    const logged = () =>
      loggingMock.logToAxiom.mock.calls.filter(
        ([d]) => (d as { message?: string }).message === offMessage
      ).length;
    const before = logged();
    const noTable = await freshDb([]);
    const noColumns = await freshDb([TABLE_MIGRATION]);
    try {
      const v = version({});
      installRaw(noTable);
      expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toBeNull();
      installRaw(noColumns);
      expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toBeNull();
      expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: v.readFiles })).toBeNull();
      // The submit is not refused either.
      expect(
        await assertBundleHasPlatformUpdates({
          appBlockId: APP,
          readFiles: v.readFiles,
          allow: false,
        })
      ).toEqual([]);
      await vi.waitFor(() => expect(logged() - before).toBe(1));
    } finally {
      await noTable.close();
      await noColumns.close();
    }
  });
});

describe('markShippedPlatformUpdates (approve)', () => {
  it('🔴 marks shipped only the updates the approved files contain', async () => {
    const shaIn = staffCommit({ 'src/a.ts': UPDATE_TEXT });
    const shaOut = staffCommit({ 'src/new.ts': 'export {};\n' });
    await addUpdate({
      id: 'apu_in',
      commitSha: shaIn,
      paths: [{ path: 'src/a.ts', operation: 'update' }],
      at: '2027-01-01T00:00:00Z',
    });
    await addUpdate({
      id: 'apu_out',
      commitSha: shaOut,
      paths: [{ path: 'src/new.ts', operation: 'create' }],
      at: '2027-01-02T00:00:00Z',
    });
    const v = version({ 'src/a.ts': UPDATE_TEXT });
    expect(
      await markShippedPlatformUpdates({
        appBlockId: APP,
        publishRequestId: 'pubreq_v2',
        readFiles: v.readFiles,
      })
    ).toEqual(['apu_in']);
    const rows = await shippedColumn();
    expect(rows.map(({ id, shipped }) => ({ id, shipped }))).toEqual([
      { id: 'apu_in', shipped: 'pubreq_v2' },
      { id: 'apu_out', shipped: null },
    ]);
    expect(rows[0].at).not.toBeNull();
    // Shipped: the next submit no longer checks it, even when the owner has since edited the file.
    const later = version({ 'src/a.ts': 'owner rewrote it\n', 'src/new.ts': 'export {};\n' });
    expect(await checkPlatformUpdates({ appBlockId: APP, readFiles: later.readFiles })).toEqual({
      contained: ['apu_out'],
      missing: [],
    });
  });

  it('keeps the request that shipped an update first', async () => {
    const sha = staffCommit({ 'src/a.ts': UPDATE_TEXT });
    await addUpdate({
      id: 'apu_first',
      commitSha: sha,
      paths: [{ path: 'src/a.ts', operation: 'update' }],
    });
    const v = version({ 'src/a.ts': UPDATE_TEXT });
    await markShippedPlatformUpdates({
      appBlockId: APP,
      publishRequestId: 'pubreq_first',
      readFiles: v.readFiles,
    });
    // A second approve does not see it (shipped) and does not overwrite it.
    expect(
      await markShippedPlatformUpdates({
        appBlockId: APP,
        publishRequestId: 'pubreq_second',
        readFiles: v.readFiles,
      })
    ).toEqual([]);
    expect((await shippedColumn()).map((r) => r.shipped)).toEqual(['pubreq_first']);
  });

  // Two approves racing past the read: the write itself keeps the first. Reached directly, since
  // through `markShippedPlatformUpdates` the second approve's read already excludes the update.
  it('the shipped write never overwrites an earlier shipping request (race guard)', async () => {
    const { markPlatformUpdatesShipped } = await import(
      '~/server/services/blocks/app-platform-update-shipped'
    );
    await addUpdate({
      id: 'apu_race',
      commitSha: BASE_SHA,
      paths: [{ path: 'src/a.ts', operation: 'update' }],
    });
    expect(await markPlatformUpdatesShipped(['apu_race'], 'pubreq_one')).toBe(1);
    expect(await markPlatformUpdatesShipped(['apu_race'], 'pubreq_two')).toBe(0);
    expect((await shippedColumn()).map((r) => r.shipped)).toEqual(['pubreq_one']);
  });

  it('never throws: an unreadable source repo leaves the update unshipped', async () => {
    await addUpdate({
      id: 'apu_lost',
      commitSha: 'f'.repeat(40),
      paths: [{ path: 'src/a.ts', operation: 'update' }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v = version({ 'src/a.ts': UPDATE_TEXT });
    await expect(
      markShippedPlatformUpdates({
        appBlockId: APP,
        publishRequestId: 'pubreq_x',
        readFiles: v.readFiles,
      })
    ).resolves.toEqual([]);
    expect((await shippedColumn()).map((r) => r.shipped)).toEqual([null]);
    warn.mockRestore();
  });
});

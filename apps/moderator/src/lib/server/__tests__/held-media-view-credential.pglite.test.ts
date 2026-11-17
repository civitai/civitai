import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HeldMediaModule from '../held-media';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The held-media view row carries the credential that fetched it. The column comes from the real
 * migration applied over the table's prior shape, the row from the real `recordHeldView`, and the
 * readers that look for it (the full view's `opened/` here; the main app's `shown.ts` uses the same
 * predicate) still find it.
 */

const { dbHandle, getHeldMedia } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  getHeldMedia: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('$lib/server/access', () => ({ canAccess: () => true }));
vi.mock('$lib/server/held-media', async (importOriginal) => ({
  ...(await importOriginal<typeof HeldMediaModule>()),
  getHeldMedia,
}));

const { recordHeldView } = await import('../held-media');
const { POST: opened } = await import('../../../routes/api/held-media/[imageId]/opened/+server');

const MIGRATION = new URL(
  '../../../../../../packages/civitai-db-schema/prisma/migrations/20261231180000_mod_activity_credential/migration.sql',
  import.meta.url
);

let db: PGlite;

const viewRows = async () =>
  (
    await db.query<{ userId: number; entityId: number; credential: string | null }>(
      `SELECT "userId", "entityId", credential FROM "ModActivity" WHERE activity = 'heldMedia:view' ORDER BY id`
    )
  ).rows;

async function postOpened(imageId: number) {
  const url = new URL(`http://mod.test/api/held-media/${imageId}/opened`);
  try {
    const res = await opened({
      params: { imageId: String(imageId) },
      url,
      request: new Request(url, { method: 'POST', headers: { origin: 'http://mod.test' } }),
      locals: { user: { id: 42, roles: ['moderator:senior'] }, grants: {} },
    } as never);
    return res.status;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

beforeAll(async () => {
  db = await freshPglite();
  // The table as it stood before this migration (20261205120000_mod_activity_host and earlier).
  await db.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "activity" TEXT NOT NULL,
      "entityType" TEXT,
      "entityId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "host" TEXT
    );
    INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
    VALUES (1, 'heldMedia:view', 'image', 1);
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  await db.exec(`DELETE FROM "ModActivity" WHERE "userId" <> 1`);
  getHeldMedia.mockReset().mockResolvedValue({ url: 'key', type: 'image', mimeType: null });
});

describe('heldMedia:view credential', () => {
  it('leaves rows from before the migration NULL', async () => {
    expect((await viewRows())[0]).toEqual({ userId: 1, entityId: 1, credential: null });
  });

  it.each(['sheet', 'web'] as const)('records a %s fetch', async (credential) => {
    await recordHeldView(42, 7, credential);
    expect((await viewRows()).slice(1)).toEqual([{ userId: 42, entityId: 7, credential }]);
  });

  it('refuses any other credential value', async () => {
    await expect(
      db.query(
        `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", credential)
         VALUES (42, 'heldMedia:view', 'image', 7, 'other')`
      )
    ).rejects.toThrow(/ModActivity_credential_check/);
  });

  // A skipped insert raises nothing in Postgres; only the empty RETURNING shows it.
  it('throws when the insert is skipped without an error', async () => {
    await db.exec(`
      CREATE FUNCTION skip_row() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER skip_row BEFORE INSERT ON "ModActivity" FOR EACH ROW EXECUTE FUNCTION skip_row();
    `);
    try {
      await expect(recordHeldView(42, 7, 'sheet')).rejects.toThrow(/not written/);
    } finally {
      await db.exec(`DROP TRIGGER skip_row ON "ModActivity"; DROP FUNCTION skip_row();`);
    }
  });

  it.each(['sheet', 'web'] as const)(
    'lets the full view record an open after a %s fetch',
    async (credential) => {
      await recordHeldView(42, 7, credential);
      expect(await postOpened(7)).toBe(204);
    }
  );

  it('still refuses an open with no fetch behind it', async () => {
    expect(await postOpened(8)).toBe(403);
  });
});

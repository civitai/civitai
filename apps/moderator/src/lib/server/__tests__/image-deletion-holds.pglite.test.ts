import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Axiom from '../axiom';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import type { ImageKeptReason } from '$lib/image-kept-reasons';

/** A moderator delete refuses any image a CSAM review, block, report or owner hold covers. */

const { dbHandle, deletedKeys } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  deletedKeys: [] as string[],
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../storage', () => ({
  getStorage: () => ({
    deleteObject: async ({ key }: { key: string }) => {
      deletedKeys.push(key);
    },
  }),
}));
vi.mock('../redis', () => ({
  getRedis: () => ({ del: vi.fn(async () => 0) }),
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
}));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk: vi.fn() }));
vi.mock('../image-moderation-effects', () => ({ bustPostGalleryCaches: vi.fn() }));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ insert: vi.fn(async () => undefined) }),
}));
vi.mock('../axiom', async (importOriginal) => ({
  ...(await importOriginal<typeof Axiom>()),
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(async () => undefined),
}));

const { deleteImageRows, finishImageDeletes } = await import('../image-deletion');
const { imageDeleteHoldLegs } = await import('../delete-hold-sql');
const { moderateArticle } = await import('../article-moderation');

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "profilePictureId" INTEGER);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT,
  "userId" INTEGER NOT NULL,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "metadata" JSONB,
  "postId" INTEGER,
  "updatedAt" TIMESTAMP(3)
);
CREATE TABLE "CollectionItem" ("imageId" INTEGER);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "details" JSONB NOT NULL DEFAULT '{}',
  "images" JSONB NOT NULL DEFAULT '[]',
  "reportSentAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "EvidenceHoldImage" ("imageId" INTEGER, "postId" INTEGER);
CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "coverId" INTEGER, "userId" INTEGER);
CREATE TABLE "File" ("entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "CdnQueued" ("imageId" INTEGER);
CREATE FUNCTION queue_cdn_access_sync(entity_id integer, entity_type text, payload jsonb)
  RETURNS void LANGUAGE sql AS $$ INSERT INTO "CdnQueued" VALUES (entity_id) $$;
`;

const OWNER = 10;
const OTHER_OWNER = 11;
const PLAIN = 1;

let db: PGlite;

beforeEach(async () => {
  deletedKeys.length = 0;
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const image = (
  id: number,
  { userId = OWNER, needsReview = null as string | null, blockedFor = null as string | null } = {}
) =>
  db.query(
    `INSERT INTO "Image" (id, url, "userId", "needsReview", "blockedFor") VALUES ($1, $2, $3, $4, $5)`,
    [id, `key-${id}`, userId, needsReview, blockedFor]
  );

const report = (fields: {
  userId?: number | null;
  images?: unknown[];
  details?: Record<string, unknown>;
  sentDaysAgo?: number | null;
  archivedDaysAgo?: number | null;
}) =>
  db.query(
    `INSERT INTO "CsamReport" ("userId", images, details, "reportSentAt", "archivedAt") VALUES (
      $1, $2::jsonb, $3::jsonb,
      CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END,
      CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END
    )`,
    [
      fields.userId ?? null,
      JSON.stringify(fields.images ?? []),
      JSON.stringify(fields.details ?? {}),
      fields.sentDaysAgo ?? null,
      fields.archivedDaysAgo ?? null,
    ]
  );

const remaining = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map((r) => r.id);
const cdnQueued = async () =>
  (await db.query<{ imageId: number }>(`SELECT "imageId" FROM "CdnQueued"`)).rows.map(
    (r) => r.imageId
  );

const deleteImages = async (ids: number[]) => {
  const rows = await (dbHandle.current as Kysely<DB>)
    .transaction()
    .execute((trx) => deleteImageRows(trx, ids));
  await finishImageDeletes(rows);
  return rows;
};

const imageRow = async (id: number) =>
  (await db.query(`SELECT * FROM "Image" WHERE id = $1`, [id])).rows[0];
const collectionItems = async () =>
  (
    await db.query<{ imageId: number }>(`SELECT "imageId" FROM "CollectionItem" ORDER BY 1`)
  ).rows.map((r) => r.imageId);

/**
 * Deletes `id` beside the plain control, and asserts `id` alone was refused for `reason` and left
 * exactly as it was, collection entries included.
 */
const expectRefused = async (id: number, reason: ImageKeptReason) => {
  await db.query(`INSERT INTO "CollectionItem" VALUES ($1), ($2)`, [PLAIN, id]);
  const before = await imageRow(id);
  const rows = await deleteImages([PLAIN, id]);
  expect(await remaining()).toEqual([id]);
  expect(await imageRow(id)).toEqual(before);
  expect(await collectionItems()).toEqual([id]);
  expect(deletedKeys).toEqual([`key-${PLAIN}`]);
  expect(await cdnQueued()).toEqual([PLAIN]);
  expect(rows.deleted.map((d) => d.id)).toEqual([PLAIN]);
  expect(rows.refused).toEqual([{ id, reason }]);
};

describe('deleteImageRows', () => {
  beforeEach(() => image(PLAIN, { userId: OTHER_OWNER }));

  it('deletes an image no hold covers, with its stored file', async () => {
    await image(2);
    const rows = await deleteImages([PLAIN, 2]);
    expect(await remaining()).toEqual([]);
    expect(deletedKeys.sort()).toEqual(['key-1', 'key-2']);
    expect(rows.refused).toEqual([]);
  });

  it('deletes an image whose owner was named only on a report closed over a year ago', async () => {
    await image(2);
    await report({ userId: OWNER, sentDaysAgo: 400, archivedDaysAgo: 390 });
    const rows = await deleteImages([2]);
    expect(await remaining()).toEqual([PLAIN]);
    expect(rows.refused).toEqual([]);
  });

  describe('(a) the image is under a CSAM review or block', () => {
    // The owner leg holds these images too (their owner has a flagged or blocked image), so each
    // image leg is also read on its own.
    const legHolds = async (leg: 'review' | 'block', id: number) =>
      (
        await db.query<{ held: boolean }>(
          `SELECT (${imageDeleteHoldLegs('"Image"')[leg]}) AS held FROM "Image" WHERE id = $1`,
          [id]
        )
      ).rows[0].held;

    it('refuses an image flagged for CSAM review', async () => {
      await image(2, { needsReview: 'csam' });
      expect([await legHolds('review', 2), await legHolds('review', PLAIN)]).toEqual([true, false]);
      await expectRefused(2, 'review');
    });

    it('refuses an image blocked for CSAM', async () => {
      await image(2, { blockedFor: 'CSAM' });
      expect([await legHolds('block', 2), await legHolds('block', PLAIN)]).toEqual([true, false]);
      await expectRefused(2, 'review');
    });
  });

  describe('(b) a CSAM report lists the image', () => {
    // Each report below is closed over a year ago and names someone else, so only its list holds.
    const closed = { userId: 99, sentDaysAgo: 400, archivedDaysAgo: 390 };

    it('refuses an image listed as an object', async () => {
      await image(2);
      await report({ ...closed, images: [{ id: 2 }] });
      await expectRefused(2, 'review');
    });

    it('refuses an image listed as a bare id', async () => {
      await image(2);
      await report({ ...closed, images: [2] });
      await expectRefused(2, 'review');
    });

    it('is not fooled by a list entry with no id', async () => {
      await image(2);
      await report({ ...closed, images: [{ url: 'x' }, null] });
      await deleteImages([2]);
      expect(await remaining()).toEqual([PLAIN]);
    });
  });

  describe('(c) the owner is held', () => {
    it('refuses an image whose owner is named on an unsent report', async () => {
      await image(2);
      await report({ userId: OWNER });
      await expectRefused(2, 'account');
    });

    it('refuses an image whose owner is the secondary user on a report sent within the year', async () => {
      await image(2);
      await report({
        userId: 99,
        details: { secondaryUserId: String(OWNER) },
        sentDaysAgo: 30,
        archivedDaysAgo: 20,
      });
      await expectRefused(2, 'account');
    });

    it('refuses an image whose owner has another image flagged for CSAM review', async () => {
      await image(2);
      await image(3, { needsReview: 'csam' });
      const rows = await deleteImages([PLAIN, 2]);
      expect(await remaining()).toEqual([2, 3]);
      expect(rows.refused).toEqual([{ id: 2, reason: 'account' }]);
    });

    it('refuses an image owned by the placeholder owner', async () => {
      await image(2, { userId: -1 });
      await expectRefused(2, 'account');
    });
  });

  it('keeps an image a hold covers by the time of the delete, after the check passed it', async () => {
    await image(2);
    // Flags image 2 between the check and its delete: the first CollectionItem delete runs after
    // the check, before any Image delete.
    await db.exec(`
      CREATE FUNCTION flag_late() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 2; RETURN OLD; END $$;
      CREATE TRIGGER flag_late BEFORE DELETE ON "CollectionItem"
        FOR EACH ROW EXECUTE FUNCTION flag_late();
      INSERT INTO "CollectionItem" VALUES (${PLAIN}), (2);
    `);
    const rows = await deleteImages([PLAIN, 2]);
    expect(await remaining()).toEqual([2]);
    expect(await collectionItems()).toEqual([2]);
    expect(deletedKeys).toEqual([`key-${PLAIN}`]);
    expect(rows.refused).toEqual([{ id: 2, reason: 'review' }]);
    expect(rows.notReturned).toEqual([]);
  });
});

// The hold marker's own delete trigger (the real migrations) keeps such an image and blocks it, so
// the delete goes ahead rather than leaving a held owner's image live.
describe('deleteImageRows on an owner with a hold marker', () => {
  const migration = (name: string) =>
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
      ),
      'utf-8'
    );

  beforeEach(async () => {
    await db.exec(`
      DROP TABLE "EvidenceHeldUser";
      DROP TABLE "EvidenceHoldImage";
      CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
      CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
    `);
    await db.exec(migration('20261019220000_evidence_hold'));
    await db.exec(migration('20261204120000_evidence_hold_image_prior_state'));
    await db.exec(`
      INSERT INTO "EvidenceHold" ("userId", "role", "reason") VALUES (${OWNER}, 'manual', 'review');
    `);
    await image(PLAIN, { userId: OTHER_OWNER });
  });

  it.each([
    ['a clean image', {}],
    ['an image flagged for CSAM review', { needsReview: 'csam' }],
  ])('blocks %s instead of leaving it live, and keeps its file', async (_label, state) => {
    await image(2, state);
    await db.query(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id = 2`);
    const rows = await deleteImages([PLAIN, 2]);
    expect(await remaining()).toEqual([2]);
    expect(await imageRow(2)).toMatchObject({ ingestion: 'Blocked', nsfwLevel: 32 });
    expect(deletedKeys).toEqual([`key-${PLAIN}`]);
    expect(await cdnQueued()).toEqual([PLAIN]);
    expect(rows.refused).toEqual([{ id: 2, reason: 'evidence' }]);
    expect(rows.notReturned).toEqual([2]);
  });
});

describe('an article delete', () => {
  it('deletes the article and its unheld images, and reports the held ones', async () => {
    await image(PLAIN, { userId: OTHER_OWNER });
    await image(2, { blockedFor: 'CSAM' });
    await db.exec(`
      INSERT INTO "Article" VALUES (50, ${PLAIN}, ${OTHER_OWNER});
      INSERT INTO "ImageConnection" VALUES (2, 50, 'Article');
    `);

    const result = await moderateArticle({ action: 'delete', articleId: 50, userId: 1 });

    expect(result).toEqual({ ok: true, kept: [{ id: 2, reason: 'review' }] });
    expect((await db.query(`SELECT 1 FROM "Article"`)).rows).toHaveLength(0);
    expect(await remaining()).toEqual([2]);
    expect(deletedKeys).toEqual([`key-${PLAIN}`]);
  });
});

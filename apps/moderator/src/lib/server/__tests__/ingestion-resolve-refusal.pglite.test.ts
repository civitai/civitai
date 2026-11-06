import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

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
  getStorage: () => ({ headObject: vi.fn() }),
  getMediaProbeStorage: () => ({ headObject: vi.fn() }),
}));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));

const { resolveIngestionError } = await import('../ingestion.service');

const SCHEMA = `
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "bannedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "postId" INTEGER,
  "url" TEXT NOT NULL,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT NOT NULL,
  "metadata" JSONB,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "scannedAt" TIMESTAMP(3)
);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER);
`;

const IMAGE_ID = 41;
const OWNER = 7;
// Not a bare-uuid key, so the missing-media probe is skipped and never reaches storage.
const URL = 'https://example.com/legacy.jpeg';

let db: PGlite;
/** Runs once, just before the publishing UPDATE: a write that lands between the read and it. */
let beforeImageUpdate: (() => Promise<void>) | null = null;

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db = await freshPglite();
  await db.exec(SCHEMA);
  beforeImageUpdate = null;
  const hooked = {
    query: async (sql: string, params?: unknown[]) => {
      if (beforeImageUpdate && /^update "Image"/i.test(sql)) {
        const hook = beforeImageUpdate;
        beforeImageUpdate = null;
        await hook();
      }
      return db.query(sql, params);
    },
  } as unknown as PGlite;
  dbHandle.current = new Kysely({ dialect: pgliteDialect(hooked) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
  vi.restoreAllMocks();
});

async function seed({
  blockedFor = null,
  needsReview = null,
  bannedAt = null,
  deletedAt = null,
}: {
  blockedFor?: string | null;
  needsReview?: string | null;
  bannedAt?: string | null;
  deletedAt?: string | null;
}) {
  await db.query(`INSERT INTO "User" ("id", "bannedAt", "deletedAt") VALUES ($1, $2, $3)`, [
    OWNER,
    bannedAt,
    deletedAt,
  ]);
  await db.query(
    `INSERT INTO "Image" ("id", "userId", "url", "needsReview", "blockedFor", "ingestion", "metadata")
     VALUES ($1, $2, $3, $4, $5, 'Error', '{}')`,
    [IMAGE_ID, OWNER, URL, needsReview, blockedFor]
  );
  await db.query(
    `INSERT INTO "JobQueue" ("type", "entityType", "entityId") VALUES ('BlockedImageDelete', 'Image', $1)`,
    [IMAGE_ID]
  );
}

const imageRow = async () =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM "Image" WHERE "id" = $1`, [IMAGE_ID]))
    .rows[0];
const purgeRows = async () =>
  (
    await db.query(
      `SELECT 1 FROM "JobQueue" WHERE "type" = 'BlockedImageDelete' AND "entityId" = $1`,
      [IMAGE_ID]
    )
  ).rows.length;

const resolve = () => resolveIngestionError({ id: IMAGE_ID, nsfwLevel: 1, userId: 99 });

describe('spoke resolveIngestionError refusals', () => {
  it.each([
    ['a CSAM block', { blockedFor: 'CSAM' }, /moderation block/],
    ['a moderator block', { blockedFor: 'moderated' }, /moderation block/],
    ['a moderator block in legacy casing', { blockedFor: 'Moderated' }, /moderation block/],
    ['a ToS block', { blockedFor: 'tos' }, /moderation block/],
    ['an unverified-AI block', { blockedFor: 'AiNotVerified' }, /moderation block/],
    ['a csam review hold', { needsReview: 'csam' }, /moderation block/],
    ['a banned owner', { bannedAt: '2026-01-01' }, /banned or deleted/],
    ['a deleted owner', { deletedAt: '2026-01-01' }, /banned or deleted/],
  ])(
    'refuses an image with %s, leaving the row and its purge row as they were',
    async (_, seedWith, message) => {
      await seed(seedWith);
      const before = await imageRow();

      await expect(resolve()).rejects.toThrow(message);

      expect(await imageRow()).toEqual(before);
      expect(await purgeRows()).toBe(1);
    }
  );

  it('refuses when the owner is banned between the read and the write', async () => {
    await seed({ blockedFor: 'a prompt audit reason' });
    const before = await imageRow();
    beforeImageUpdate = async () => {
      await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE "id" = $1`, [OWNER]);
    };

    await expect(resolve()).rejects.toThrow(/changed since the queue loaded/);

    expect(await imageRow()).toEqual(before);
    expect(await purgeRows()).toBe(1);
  });

  it('refuses when a moderator block lands between the read and the write', async () => {
    await seed({ blockedFor: 'a prompt audit reason' });
    beforeImageUpdate = async () => {
      await db.query(`UPDATE "Image" SET "blockedFor" = 'moderated' WHERE "id" = $1`, [IMAGE_ID]);
    };

    await expect(resolve()).rejects.toThrow(/changed since the queue loaded/);

    expect((await imageRow()).blockedFor).toBe('moderated');
    expect(await purgeRows()).toBe(1);
  });
});

describe('spoke resolveIngestionError publishing', () => {
  it('clears a block the scan set and drops its purge row', async () => {
    await seed({ blockedFor: 'a prompt audit reason' });

    await resolve();

    const row = await imageRow();
    expect(row).toMatchObject({ ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1 });
    expect(await purgeRows()).toBe(0);
  });

  it('leaves the purge queue alone when there was no block to clear', async () => {
    await seed({});

    await resolve();

    expect((await imageRow()).ingestion).toBe('Scanned');
    expect(await purgeRows()).toBe(1);
  });
});

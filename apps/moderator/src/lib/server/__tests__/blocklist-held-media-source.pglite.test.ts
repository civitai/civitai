import type { PGlite } from '@electric-sql/pglite';
import { csamSignalImageSql, mirrorBlockedHashesSql } from '@civitai/shared/held-media';
import { Kysely, sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A blocklist CSAM entry is copied into "BlockedImage", the table the CSAM restriction reads
 * (`csamSignalImageSql`), so an image whose hash only the blocklist holds still counts as CSAM.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, ch } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  ch: {
    inserts: [] as { table: string; values: unknown[] }[],
    /** Hashes the CSAM-entry lookup reports as live. */
    csamHashes: [] as string[],
    /** Rows the plain live-row lookup returns. */
    liveRows: [] as { hash: string; reason: string }[],
  },
}));

vi.mock('../db', () => ({
  get dbRead() {
    throw new Error('the copy must be written to the primary');
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    query: async ({ query }: { query: string }) => ({
      json: async () =>
        query.includes("= 'CSAM'") ? ch.csamHashes.map((hash) => ({ hash })) : ch.liveRows,
    }),
    insert: async ({ table, values }: { table: string; values: unknown[] }) => {
      ch.inserts.push({ table, values });
    },
  }),
}));
vi.mock('../axiom', () => ({ logToAxiom: vi.fn(), logAxiomError: vi.fn() }));
vi.mock('../notifications', () => ({ getNotifications: () => ({}) }));

const { addImagesToBlocklist, removeImagesFromBlocklist } = await import(
  '../image-moderation-effects'
);

// Past 2^53, so a copy that went through a JS number would land a different value.
const HASH = '-4276845791567733103';
const OTHER = '1234567890123';
const UNBLOCKED = '990000123';

const SCHEMA = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "userId" INTEGER NOT NULL DEFAULT 1,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT FALSE,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "pHash" BIGINT
);
CREATE TABLE "CsamReport" ("id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB, "images" JSONB);
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, "disabled" BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TYPE "BlockImageReason" AS ENUM ('Ownership', 'CSAM', 'TOS');
CREATE TABLE "BlockedImage" ("hash" BIGINT PRIMARY KEY, "reason" "BlockImageReason" NOT NULL DEFAULT 'Ownership');
CREATE TABLE "ScanLabelItem" ("id" SERIAL PRIMARY KEY, "imageId" INTEGER UNIQUE, "voidReason" TEXT);
CREATE TABLE "ScanLabelFlag" ("itemId" INTEGER, "snapshot" JSONB);
CREATE TABLE "ScanLabelVote" ("itemId" INTEGER, "userId" INTEGER, "reason" TEXT);
INSERT INTO "Image" ("id", "pHash") VALUES (1, ${HASH}), (2, ${OTHER}), (3, ${UNBLOCKED});
`;

let pg: PGlite;
let db: Kysely<any>;

beforeAll(async () => {
  pg = await freshPglite();
  await pg.exec(SCHEMA);
  db = new Kysely({ dialect: pgliteDialect(pg) });
  dbHandle.current = db;
});

afterAll(async () => {
  dbHandle.current = null;
  await pg.close();
});

beforeEach(async () => {
  ch.inserts = [];
  ch.csamHashes = [];
  ch.liveRows = [];
  await pg.exec('DELETE FROM "BlockedImage"');
});

const block = (pHash: string, csam: boolean) =>
  addImagesToBlocklist([{ pHash, needsReview: null, blockedFor: 'moderated', csam }]);

async function suspect(id: number) {
  const { rows } = await sql<{ suspect: boolean }>`
    SELECT ${sql.raw(csamSignalImageSql('i'))} AS suspect FROM "Image" i WHERE i.id = ${id}
  `.execute(db);
  return rows[0]?.suspect;
}

const pgRows = async () =>
  (
    await sql<{ hash: string; reason: string }>`
      SELECT hash::text AS hash, reason::text AS reason FROM "BlockedImage" ORDER BY hash
    `.execute(db)
  ).rows;

describe('a blocklist CSAM entry routes its images as suspect', () => {
  it('a hash only the blocklist held routes as suspect once blocked', async () => {
    expect(await suspect(1)).toBe(false);

    await block(HASH, true);

    expect(await pgRows()).toEqual([{ hash: HASH, reason: 'CSAM' }]);
    expect(await suspect(1)).toBe(true);
  });

  it('an image whose hash is not blocked does not (control)', async () => {
    await block(HASH, true);

    expect(await suspect(3)).toBe(false);
  });

  it('a block of another reason copies nothing', async () => {
    await block(OTHER, false);

    expect(ch.inserts).toHaveLength(1);
    expect(await pgRows()).toEqual([]);
    expect(await suspect(2)).toBe(false);
  });

  it('a row of another reason on the hash becomes CSAM', async () => {
    await pg.exec(`INSERT INTO "BlockedImage" ("hash", "reason") VALUES (${HASH}, 'TOS')`);
    expect(await suspect(1)).toBe(false);

    await block(HASH, true);

    expect(await pgRows()).toEqual([{ hash: HASH, reason: 'CSAM' }]);
    expect(await suspect(1)).toBe(true);
  });

  it('a failed copy fails the write, which the block reports for a retry', async () => {
    await pg.exec('ALTER TABLE "BlockedImage" RENAME TO "BlockedImageGone"');
    try {
      await expect(block(HASH, true)).rejects.toThrow();
    } finally {
      await pg.exec('ALTER TABLE "BlockedImageGone" RENAME TO "BlockedImage"');
    }
  });
});

// Deliberate: the copy is never deleted on an unblock. Both unblock paths leave a live CSAM entry in
// place, so a matching copy stays true; a stale one only routes an image to the CSAM tier. Before
// adding a delete here, read both unblock paths and the PR that added this.
describe('an unblock never removes the copy', () => {
  it('an unblock of a hash with a live CSAM entry leaves the entry and the copy', async () => {
    await block(HASH, true);
    ch.inserts = [];
    ch.csamHashes = [HASH];
    ch.liveRows = [{ hash: HASH, reason: 'CSAM' }];

    await removeImagesFromBlocklist([HASH]);

    expect(ch.inserts).toEqual([]);
    expect(await suspect(1)).toBe(true);
  });
});

describe('mirrorBlockedHashesSql', () => {
  it('refuses text that is not a 64-bit integer', () => {
    expect(() => mirrorBlockedHashesSql(['1); DROP TABLE "Image"; --'])).toThrow('Bad int64');
    expect(() => mirrorBlockedHashesSql(['9223372036854775808'])).toThrow('Bad int64');
    expect(mirrorBlockedHashesSql([])).toBeNull();
  });

  it('writes a hash listed twice once', async () => {
    await sql.raw(mirrorBlockedHashesSql([HASH, HASH, BigInt(OTHER)])!).execute(db);

    expect(await pgRows()).toEqual([
      { hash: HASH, reason: 'CSAM' },
      { hash: OTHER, reason: 'CSAM' },
    ]);
  });
});

import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
}));

const { countImageTagsNeedingReview, IMAGE_TAGS_COUNT_TIMEOUT_MS } = await import(
  '../image-tags-count'
);

let db: PGlite;
const statements: string[] = [];

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "nsfwLevel" INTEGER NOT NULL);
    CREATE TABLE "TagsOnImageNew" ("imageId" INTEGER NOT NULL, "tagId" INTEGER NOT NULL, "attributes" INTEGER NOT NULL);
    INSERT INTO "Image" VALUES (1, 1), (2, 1), (3, 1), (4, 32);
    -- needs review: bit 9 set, bit 10 clear. Image 1 has two such tags and counts once.
    INSERT INTO "TagsOnImageNew" VALUES (1, 1, 512), (1, 2, 512), (2, 1, 512);
    -- bit 10 set (reviewed), and no bit 9
    INSERT INTO "TagsOnImageNew" VALUES (3, 1, 1536), (3, 2, 0);
    -- blocked image
    INSERT INTO "TagsOnImageNew" VALUES (4, 1, 512);
  `);
  const recording = {
    query: (sql: string, params?: unknown[]) => {
      statements.push(sql);
      return db.query(sql, params);
    },
  } as unknown as PGlite;
  dbHandle.current = new Kysely({ dialect: pgliteDialect(recording) });
});

afterAll(async () => {
  await db?.close();
});

describe('countImageTagsNeedingReview', () => {
  it('counts images with an unreviewed tag once, leaving out blocked images', async () => {
    expect(await countImageTagsNeedingReview()).toBe(2);
  });

  it('runs the scan in a transaction under a statement timeout', async () => {
    statements.length = 0;

    await countImageTagsNeedingReview();

    const timeout = statements.findIndex((sql) => /statement_timeout/i.test(sql));
    expect(timeout).toBeGreaterThan(0);
    expect(statements[timeout]).toContain(String(IMAGE_TAGS_COUNT_TIMEOUT_MS));
    expect(statements.slice(0, timeout).some((sql) => /^begin/i.test(sql))).toBe(true);
    expect(statements.findIndex((sql) => /"TagsOnImageNew"/.test(sql))).toBeGreaterThan(timeout);
  });
});

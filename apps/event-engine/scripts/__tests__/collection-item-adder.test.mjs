import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  backfillSql,
  clickhouseConfig,
  openLedger,
  readLedger,
  touchEvents,
} from '../lib/collection-item-adder.mjs';

const read = (lines) => readLedger(lines, 'Article');
const line = (o) => JSON.stringify(o);
const pending = (lo, hi) =>
  line({ lo, hi, phase: 'pending', entity: 'Article', xid: String(lo), ids: [lo + 1] });

describe('readLedger', () => {
  it('returns the unfinished batch and where the run resumes', () => {
    const state = read([
      pending(0, 100),
      line({ lo: 0, phase: 'committed' }),
      pending(100, 200),
      line({ lo: 100, phase: 'committed' }),
      pending(200, 300),
      '',
    ]);
    expect(state.open).toMatchObject({ lo: 200, hi: 300, phase: 'pending', xid: '200' });
    expect(state.resumeFrom).toBe(200);
    expect(state.touched).toBe(false);
  });

  it('does not count an abandoned batch as done, so its range is redone', () => {
    const state = read([
      pending(0, 100),
      line({ lo: 0, phase: 'committed' }),
      pending(100, 200),
      line({ lo: 100, phase: 'abandoned' }),
    ]);
    expect(state.open).toBeNull();
    expect(state.resumeFrom).toBe(100);
  });

  it('reports a finished touch', () => {
    expect(read([pending(0, 100), line({ phase: 'touched', entity: 'Article' })]).touched).toBe(
      true
    );
  });

  it('drops a torn final line but not a torn line in the middle', () => {
    expect(read([pending(0, 100), '{"lo":0,"pha']).open).toMatchObject({ phase: 'pending' });
    expect(() => read(['{"lo":0,"pha', pending(0, 100)])).toThrow();
  });

  it('refuses a ledger written for another entity', () => {
    expect(() => readLedger([pending(0, 100)], 'Model')).toThrow(/written for Article/);
  });

  it('refuses two unfinished batches, and a ledger from the earlier versions of this script', () => {
    expect(() => read([pending(0, 100), pending(100, 200)])).toThrow(/2 unfinished batches/);
    expect(() => read([pending(0, 100), line({ phase: 'reconcile', entity: 'Article' })])).toThrow(
      /unknown phase reconcile/
    );
  });
});

describe('openLedger', () => {
  it('cuts a torn tail so the next line survives a later read', () => {
    // Otherwise a `committed` line glued onto the fragment is lost on a later read, and the
    // resume has to ask Postgres about a batch the ledger already settled.
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl');
    writeFileSync(path, `${pending(0, 100)}\n{"lo":0,"pha`);
    const ledger = openLedger(path);
    ledger.write({ lo: 0, phase: 'committed' });
    ledger.close();
    expect(read(readFileSync(path, 'utf-8').split('\n')).resumeFrom).toBe(100);
  });

  it('keeps a complete final line that only lacks its newline', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl');
    writeFileSync(path, `${pending(0, 100)}\n${line({ lo: 0, phase: 'committed' })}`);
    const ledger = openLedger(path);
    ledger.write({ phase: 'touched', entity: 'Article' });
    ledger.close();
    const lines = readFileSync(path, 'utf-8').split('\n');
    expect(lines.filter(Boolean).map((l) => JSON.parse(l).phase)).toEqual([
      'pending',
      'committed',
      'touched',
    ]);
  });
});

describe('touchEvents', () => {
  it('writes a 0 per entity, which marks it for a recount and moves no sum', () => {
    expect(touchEvents('Article', 'collectedCount', [3, 4], 1_761_000_000)).toEqual([
      {
        entityType: 'Article',
        entityId: 3,
        metricType: 'collectedCount',
        userId: -1,
        metricValue: 0,
        createdAt: 1_761_000_000,
      },
      {
        entityType: 'Article',
        entityId: 4,
        metricType: 'collectedCount',
        userId: -1,
        metricValue: 0,
        createdAt: 1_761_000_000,
      },
    ]);
  });
});

describe('backfillSql', () => {
  // Run against a real Postgres, so this checks which rows the queries touch, not their text.
  async function db() {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
      CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int, mode "CollectionMode");
      CREATE TABLE "CollectionItem" (
        id int PRIMARY KEY, "collectionId" int, "articleId" int, "modelId" int, "postId" int,
        "imageId" int, "addedById" int);
      CREATE TABLE "ArticleMetric" ("articleId" int, timeframe text, "collectedCount" int);
      INSERT INTO "Collection" VALUES (1, 5, 'Bookmark'), (2, 6, NULL), (3, 7, 'Contest');
      INSERT INTO "CollectionItem" VALUES
        (1, 1, 30, NULL, NULL, NULL, NULL),
        (2, 2, 31, NULL, NULL, NULL, NULL),
        (3, 3, 32, NULL, NULL, NULL, NULL),
        (4, 1, NULL, 40, NULL, NULL, NULL);
      -- 35 lost all its rows while they had no adder, so nothing ever uncounted it.
      INSERT INTO "ArticleMetric" VALUES (30, 'AllTime', 1), (35, 'AllTime', 4), (36, 'AllTime', 0);
    `);
    return pg;
  }

  it('gives an adder only to Bookmark-collection rows of the chosen entity', async () => {
    const pg = await db();
    const { rows } = await pg.query(backfillSql('Article').update, [0, 100]);
    expect(rows.map((r) => r.id)).toEqual([1]);
    const { rows: after } = await pg.query(
      'SELECT id, "addedById" FROM "CollectionItem" ORDER BY id'
    );
    expect(after.map((r) => [r.id, r.addedById])).toEqual([
      [1, 5],
      [2, null],
      [3, null],
      [4, null],
    ]);
    await pg.close();
  });

  it('counts the rows it leaves out by collection mode', async () => {
    const pg = await db();
    const { rows } = await pg.query(backfillSql('Article').candidates, [0, 100]);
    expect(Object.fromEntries(rows.map((r) => [r.mode ?? 'none', r.n]))).toEqual({
      Bookmark: 1,
      Contest: 1,
      none: 1,
    });
    await pg.close();
  });

  it('marks every entity with rows, and every one still showing a count without them', async () => {
    const pg = await db();
    const sql = backfillSql('Article');
    const ids = async (q) => (await pg.query(q)).rows.map((r) => r.id).sort((a, b) => a - b);
    expect(await ids(sql.touchEntities)).toEqual([30, 31, 32, 35]);
    expect(await ids(sql.touchCollections)).toEqual([1, 2, 3]);
    await pg.close();
  });

  it('rejects an entity it does not know', () => {
    expect(() => backfillSql('Image')).toThrow(/--entity must be one of/);
  });
});

describe('clickhouseConfig', () => {
  it('takes credentials from the environment only, and names what is missing', () => {
    expect(clickhouseConfig({ CLICKHOUSE_URL: 'http://u:p@h' })).toEqual({ url: 'http://u:p@h' });
    expect(
      clickhouseConfig({ CLICKHOUSE_HOST: 'h', CLICKHOUSE_USER: 'u', CLICKHOUSE_PASSWORD: 'p' })
    ).toEqual({ url: 'h', username: 'u', password: 'p' });
    expect(() => clickhouseConfig({ CLICKHOUSE_HOST: 'h' })).toThrow(
      'set CLICKHOUSE_URL, or CLICKHOUSE_USERNAME (or CLICKHOUSE_USER), CLICKHOUSE_PASSWORD, in the environment'
    );
    expect(() => clickhouseConfig({})).toThrow(/CLICKHOUSE_HOST/);
  });
});

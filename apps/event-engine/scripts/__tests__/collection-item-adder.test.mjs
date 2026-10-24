import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  backfillSql,
  clickhouseConfig,
  tableNamePattern,
  deltaSummary,
  landedState,
  nextStampMs,
  openLedger,
  readLedger,
  reconcile,
} from '../lib/collection-item-adder.mjs';

const T = 1_761_000_000;
const read = (lines) => readLedger(lines, 'Article');
const line = (o) => JSON.stringify(o);
const pending = (lo, hi, extra = {}) =>
  line({
    lo,
    hi,
    phase: 'pending',
    entity: 'Article',
    xid: String(lo),
    ids: [lo + 1],
    entityIds: [lo + 30],
    collectionIds: [lo + 10],
    ...extra,
  });

describe('nextStampMs', () => {
  it('gives each stamp its own second even when two fall within one', () => {
    const first = nextStampMs(null, T * 1000 + 400);
    const second = nextStampMs(first, T * 1000 + 900);
    expect(first).toBe(T * 1000);
    expect(second).toBe(T * 1000 + 1000);
  });
});

describe('readLedger', () => {
  it('returns the unfinished batch, where phase 1 resumes, and what committed batches touched', () => {
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
    expect(state.touched).toEqual({ entityIds: [30, 130], collectionIds: [10, 110] });
    expect(state.reconcile).toBeNull();
  });

  it('does not count an abandoned batch as done or touched, so its range is redone', () => {
    const state = read([
      pending(0, 100),
      line({ lo: 0, phase: 'committed' }),
      pending(100, 200),
      line({ lo: 100, phase: 'abandoned' }),
    ]);
    expect(state.open).toBeNull();
    expect(state.resumeFrom).toBe(100);
    expect(state.touched.entityIds).toEqual([30]);
  });

  it('carries the reconcile with its latest stamp and events', () => {
    const events = [{ entityType: 'Article', entityId: 1, metricValue: 3 }];
    const state = read([
      pending(0, 100),
      line({ lo: 0, phase: 'committed' }),
      line({ phase: 'reconcile', entity: 'Article', stampMs: 5000, events }),
      line({ phase: 'restamped', stampMs: 9000, events }),
    ]);
    expect(state.reconcile).toMatchObject({ phase: 'restamped', stampMs: 9000, events });
    expect(state.lastStampMs).toBe(9000);
  });

  it('drops a torn final line but not a torn line in the middle', () => {
    expect(read([pending(0, 100), '{"lo":0,"pha']).open).toMatchObject({ phase: 'pending' });
    expect(() => read(['{"lo":0,"pha', pending(0, 100)])).toThrow();
  });

  it('refuses a ledger written for another entity', () => {
    expect(() => readLedger([pending(0, 100)], 'Model')).toThrow(/written for Article/);
    expect(() =>
      readLedger([line({ phase: 'reconcile', entity: 'Article', stampMs: 1, events: [] })], 'Model')
    ).toThrow(/written for Article/);
  });

  it('refuses two unfinished batches, and a ledger from the per-row version of this script', () => {
    expect(() => read([pending(0, 100), pending(100, 200)])).toThrow(/2 unfinished batches/);
    expect(() => read([pending(0, 100), line({ lo: 0, phase: 'inserted' })])).toThrow(
      /unknown phase inserted/
    );
  });
});

describe('openLedger', () => {
  const reconcileLine = line({ phase: 'reconcile', entity: 'Article', stampMs: 1000, events: [] });

  it('cuts a torn tail so the next line survives a later read', () => {
    // Otherwise a restamp line glued onto the fragment is dropped as torn, the next resume checks
    // the old stamp, finds nothing, and inserts the reconcile a second time.
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl');
    writeFileSync(path, `${reconcileLine}\n{"phase":"resta`);
    const ledger = openLedger(path);
    ledger.write({ phase: 'restamped', stampMs: 9000, events: [] });
    ledger.close();
    expect(read(readFileSync(path, 'utf-8').split('\n')).reconcile).toMatchObject({
      phase: 'restamped',
      stampMs: 9000,
    });
  });

  it('keeps a complete final line that only lacks its newline', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl');
    writeFileSync(path, `${pending(0, 100)}\n${line({ lo: 0, phase: 'committed' })}`);
    const ledger = openLedger(path);
    ledger.write(JSON.parse(reconcileLine));
    ledger.close();
    const lines = readFileSync(path, 'utf-8').split('\n');
    expect(lines.filter(Boolean).map((l) => JSON.parse(l).phase)).toEqual([
      'pending',
      'committed',
      'reconcile',
    ]);
  });
});

describe('landedState', () => {
  const ev = (entityId, metricValue) => ({
    entityType: 'Article',
    entityId,
    metricType: 'collectedCount',
    userId: -1,
    metricValue,
  });

  it('reads all, none and partial', () => {
    expect(landedState([ev(1, 2), ev(2, -1)], [ev(1, 2), ev(2, -1)])).toBe('all');
    expect(landedState([ev(1, 2), ev(2, -1)], [])).toBe('none');
    expect(landedState([ev(1, 2), ev(2, -1)], [ev(1, 2)])).toBe('partial');
    expect(landedState([], [])).toBe('all');
  });

  it('does not take an event with the same key but another value as ours', () => {
    expect(landedState([ev(1, 2)], [ev(1, 1)])).toBe('none');
  });
});

describe('reconcile', () => {
  // Bookmarks from before the November 2025 seed are already in ClickHouse, so the correction is
  // the gap to the truth, not one per null-adder row: a +1 per row would double count them.
  async function db() {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
      CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int, mode "CollectionMode");
      CREATE TABLE "CollectionItem" (
        id int PRIMARY KEY, "collectionId" int, "articleId" int, "modelId" int, "postId" int,
        "imageId" int, "addedById" int);
      INSERT INTO "Collection" VALUES
        (1, 5, 'Bookmark'), (2, 6, 'Bookmark'), (3, 7, NULL), (4, 8, 'Contest');
      INSERT INTO "CollectionItem" VALUES
        (1, 1, 30, NULL, NULL, NULL, NULL),  -- seeded bookmark, no adder
        (2, 2, 30, NULL, NULL, NULL, NULL),  -- seeded bookmark, no adder
        (3, 3, 30, NULL, NULL, NULL, 9),     -- user collection, has an adder
        (4, 4, 30, NULL, NULL, NULL, NULL),  -- contest row with no adder: never counted
        (5, 1, 31, NULL, NULL, NULL, 5),     -- bookmark made after the fix
        (6, 2, 31, NULL, NULL, NULL, NULL),  -- bookmark made after the seed, uncounted
        (7, 2, 32, NULL, NULL, NULL, NULL),
        (8, 1, NULL, NULL, NULL, 70, NULL);  -- image in a bookmark collection, out of scope
    `);
    return pg;
  }
  const truthOf = async (pg, sql, ids, excluded = []) =>
    new Map((await pg.query(sql, [ids, excluded])).rows.map((r) => [r.id, r.n]));

  // have: 30 fully seeded; 31 short its post-seed bookmark; 32 over by seeded rows since deleted.
  // Collection 1 seeded with its image row; collection 2 never counted.
  const articleCh = new Map([
    [30, 3],
    [31, 1],
    [32, 4],
  ]);
  const collectionCh = new Map([[1, 3]]);

  it('reads the same truth before and after phase 1, so the dry run predicts the real run', async () => {
    const pg = await db();
    const sql = backfillSql('Article');
    const before = await truthOf(pg, sql.entityTruth, [30, 31, 32]);
    const collectionsBefore = await truthOf(pg, sql.collectionTruth, [1, 2]);
    const { rows } = await pg.query(sql.update, [0, 100]);
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2, 6, 7]);
    expect(await truthOf(pg, sql.entityTruth, [30, 31, 32])).toEqual(before);
    expect(await truthOf(pg, sql.collectionTruth, [1, 2])).toEqual(collectionsBefore);
    expect(before).toEqual(
      new Map([
        [30, 3],
        [31, 2],
        [32, 1],
      ])
    );
    expect(collectionsBefore).toEqual(
      new Map([
        [1, 2],
        [2, 3],
      ])
    );
    await pg.close();
  });

  it('writes the gap to the truth per entity, negative where over and nothing where right', async () => {
    const pg = await db();
    const sql = backfillSql('Article');
    const articles = reconcile({
      entityType: 'Article',
      metricType: 'collectedCount',
      ids: [30, 31, 32],
      truth: await truthOf(pg, sql.entityTruth, [30, 31, 32]),
      ch: articleCh,
      createdAt: T,
    });
    const collections = reconcile({
      entityType: 'Collection',
      metricType: 'itemCount',
      ids: [1, 2],
      truth: await truthOf(pg, sql.collectionTruth, [1, 2]),
      ch: collectionCh,
      createdAt: T,
    });
    // A +1 per null-adder row would have written Article 30 +2, 31 +1, 32 +1, Collection 1 +1, 2 +3.
    expect(
      [...articles.events, ...collections.events].map((e) => [
        e.entityType,
        e.entityId,
        e.metricValue,
      ])
    ).toEqual([
      ['Article', 31, 1],
      ['Article', 32, -3],
      ['Collection', 1, -1],
      ['Collection', 2, 3],
    ]);
    expect(articles.events[0]).toEqual({
      entityType: 'Article',
      entityId: 31,
      metricType: 'collectedCount',
      userId: -1,
      metricValue: 1,
      createdAt: T,
    });
    await pg.close();
  });

  it('leaves out rows by users the metric aggregates exclude, as adder or as owner-to-be', async () => {
    const pg = await db();
    const sql = backfillSql('Article');
    // 9 added row 3; 6 owns collection 2, whose null rows this run would credit to 6.
    expect(await truthOf(pg, sql.entityTruth, [30, 31, 32], [9, 6])).toEqual(
      new Map([
        [30, 1],
        [31, 1],
      ])
    );
    expect(await truthOf(pg, sql.collectionTruth, [1, 2], [6])).toEqual(new Map([[1, 2]]));
    await pg.close();
  });

  it('gives an adder only to Bookmark-collection rows of the chosen entity', async () => {
    const pg = await db();
    await pg.query(backfillSql('Article').update, [0, 100]);
    const { rows } = await pg.query('SELECT id, "addedById" FROM "CollectionItem" ORDER BY id');
    expect(rows.map((r) => r.addedById)).toEqual([5, 6, 9, null, 5, 6, 6, null]);
    await pg.close();
  });

  it('lists candidates by collection mode, so the dry run shows what it leaves out', async () => {
    const pg = await db();
    const { rows } = await pg.query(backfillSql('Article').candidates, [0, 100]);
    const byMode = {};
    for (const r of rows) byMode[r.mode ?? 'none'] = (byMode[r.mode ?? 'none'] ?? 0) + r.n;
    expect(byMode).toEqual({ Bookmark: 4, Contest: 1 });
    await pg.close();
  });

  it('rejects an entity it does not know', () => {
    expect(() => backfillSql('Image')).toThrow(/--entity must be one of/);
  });
});

describe('deltaSummary', () => {
  it('buckets deltas and totals what is added and removed', () => {
    const rows = [-150, -3, 0, 0, 1, 222, 5000].map((delta, i) => ({ entityId: i, delta }));
    expect(deltaSummary(rows)).toEqual({
      entities: 7,
      events: 5,
      added: 5223,
      removed: -153,
      net: 5070,
      histogram: {
        '< -100': 1,
        '-100..-11': 0,
        '-10..-1': 1,
        0: 2,
        '1..10': 1,
        '11..100': 0,
        '101..1000': 1,
        '> 1000': 1,
      },
    });
  });
});

describe('tableNamePattern', () => {
  // The daily views read the events table inside a subquery; the first preflight looked for
  // `FROM <table>` at the top level and refused the real prod views.
  const matches = (query) => new RegExp(tableNamePattern('entityMetricEvents_month')).test(query);

  it('finds the table inside a subquery, qualified or not, and nothing that only shares a prefix', () => {
    expect(
      matches('TO x AS SELECT a FROM (SELECT a FROM default.entityMetricEvents_month WHERE b)')
    ).toBe(true);
    expect(matches('FROM (SELECT * FROM entityMetricEvents_month)')).toBe(true);
    expect(matches('FROM default.`entityMetricEvents_month`')).toBe(true);
    expect(matches('FROM default.entityMetricEvents_month_v2')).toBe(false);
    expect(matches('FROM default.entityMetricEvents')).toBe(false);
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

import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  backfillSql,
  buildEvents,
  clickhouseConfig,
  landedState,
  nextStampMs,
  openLedger,
  readLedger,
} from '../lib/collection-item-adder.mjs';

const T = 1_761_000_000;
const read = (lines) => readLedger(lines, 'Article');

describe('buildEvents', () => {
  it('emits what the CDC handler would, one event per key valued at its row count', () => {
    // One owner holding model 7 in two collections: two +1 rows with the same raw-table key would
    // collapse to one under ReplacingMergeTree, so they must arrive as a single +2.
    const events = buildEvents(
      [
        { id: 1, collectionId: 10, modelId: 7, addedById: 5 },
        { id: 2, collectionId: 11, modelId: 7, addedById: 5 },
        { id: 3, collectionId: 12, articleId: 3, addedById: 6 },
        { id: 4, collectionId: 12, postId: 9, addedById: 6 },
      ],
      T
    );

    const by = (entityType, entityId) =>
      events.filter((e) => e.entityType === entityType && e.entityId === entityId);
    expect(by('Model', 7)).toEqual([
      {
        entityType: 'Model',
        entityId: 7,
        metricType: 'collectedCount',
        userId: 5,
        metricValue: 2,
        createdAt: T,
      },
    ]);
    expect(by('Article', 3)).toMatchObject([
      { metricType: 'collectedCount', userId: 6, metricValue: 1 },
    ]);
    expect(by('Post', 9)).toMatchObject([
      { metricType: 'collectedCount', userId: 6, metricValue: 1 },
    ]);
    expect(by('Collection', 12)).toMatchObject([
      { metricType: 'itemCount', userId: 6, metricValue: 2 },
    ]);
    expect(events).toHaveLength(6);
  });
});

describe('nextStampMs', () => {
  it('gives each batch its own second even when batches finish within one', () => {
    const first = nextStampMs(null, T * 1000 + 400);
    const second = nextStampMs(first, T * 1000 + 900);
    expect(first).toBe(T * 1000);
    expect(second).toBe(T * 1000 + 1000);
  });
});

describe('readLedger', () => {
  const line = (o) => JSON.stringify(o);

  const pending = (lo, hi, stampMs) =>
    line({ lo, hi, phase: 'pending', entity: 'Article', xid: String(lo), stampMs, events: [] });

  it('returns the one unfinished batch and where finished work ends', () => {
    const state = read([
      pending(0, 100, 1000),
      line({ lo: 0, phase: 'committed' }),
      line({ lo: 0, phase: 'inserted' }),
      pending(100, 200, 2000),
      line({ lo: 100, phase: 'committed' }),
      '',
    ]);
    expect(state.open).toMatchObject({ lo: 100, hi: 200, phase: 'committed', xid: '100' });
    expect(state.resumeFrom).toBe(100);
    expect(state.lastStampMs).toBe(2000);
  });

  it('does not count an abandoned batch as done, so its range is redone', () => {
    const state = read([
      pending(0, 100, 1000),
      line({ lo: 0, phase: 'inserted' }),
      pending(100, 200, 2000),
      line({ lo: 100, phase: 'abandoned' }),
    ]);
    expect(state.open).toBeNull();
    expect(state.resumeFrom).toBe(100);
  });

  it('resumes a restamped batch with its new stamp and events', () => {
    const events = [{ entityType: 'Model', entityId: 1, createdAt: 9 }];
    const state = read([
      pending(0, 100, 1000),
      line({ lo: 0, phase: 'committed' }),
      line({ lo: 0, phase: 'restamped', stampMs: 9000, events }),
    ]);
    expect(state.open).toMatchObject({ phase: 'restamped', stampMs: 9000, events });
    expect(state.lastStampMs).toBe(9000);
  });

  it('drops a torn final line but not a torn line in the middle', () => {
    expect(read([pending(0, 100, 1000), '{"lo":0,"pha']).open).toMatchObject({
      phase: 'pending',
      entity: 'Article',
    });
    expect(() => read(['{"lo":0,"pha', pending(0, 100, 1000)])).toThrow();
  });

  it('refuses a ledger written for another entity', () => {
    expect(() => readLedger([pending(0, 100, 1000)], 'Model')).toThrow(/written for Article/);
  });

  it('refuses a ledger with two unfinished batches', () => {
    expect(() => read([pending(0, 100, 1000), pending(100, 200, 2000)])).toThrow(
      /2 unfinished batches/
    );
  });
});

describe('openLedger', () => {
  it('cuts a torn tail so the next line survives a later read', () => {
    // Otherwise a restamp line glued onto the fragment is dropped as torn, the next resume checks
    // the old stamp, finds nothing, and inserts the batch a second time.
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl');
    const pending = {
      lo: 0,
      hi: 100,
      phase: 'pending',
      entity: 'Article',
      xid: '1',
      stampMs: 1000,
      events: [],
    };
    writeFileSync(path, `${JSON.stringify(pending)}\n{"lo":0,"pha`);
    const ledger = openLedger(path);
    ledger.write({ lo: 0, phase: 'restamped', stampMs: 9000, events: [] });
    ledger.close();
    expect(read(readFileSync(path, 'utf-8').split('\n')).open).toMatchObject({
      phase: 'restamped',
      stampMs: 9000,
    });
  });

  it('keeps a complete final line that only lacks its newline', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl');
    const pending = {
      lo: 0,
      hi: 100,
      phase: 'pending',
      entity: 'Article',
      xid: '1',
      stampMs: 1000,
      events: [],
    };
    writeFileSync(
      path,
      `${JSON.stringify(pending)}\n${JSON.stringify({ lo: 0, phase: 'committed' })}`
    );
    const ledger = openLedger(path);
    ledger.write({ lo: 0, phase: 'inserted' });
    ledger.close();
    const lines = readFileSync(path, 'utf-8').split('\n');
    expect(lines.filter(Boolean).map((l) => JSON.parse(l).phase)).toEqual([
      'pending',
      'committed',
      'inserted',
    ]);
  });
});

describe('landedState', () => {
  const ev = (entityId, metricValue) => ({
    entityType: 'Model',
    entityId,
    metricType: 'collectedCount',
    userId: 5,
    metricValue,
  });

  it('reads all, none and partial', () => {
    expect(landedState([ev(1, 2), ev(2, 1)], [ev(1, 2), ev(2, 1)])).toBe('all');
    expect(landedState([ev(1, 2), ev(2, 1)], [])).toBe('none');
    expect(landedState([ev(1, 2), ev(2, 1)], [ev(1, 2)])).toBe('partial');
  });

  it('does not take a live event with the same key but another value as ours', () => {
    expect(landedState([ev(1, 2)], [ev(1, 1)])).toBe('none');
  });
});

describe('backfillSql', () => {
  // Run against a real Postgres, so this checks which rows the UPDATE touches, not its text.
  async function db() {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
      CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int, mode "CollectionMode");
      CREATE TABLE "CollectionItem" (
        id int PRIMARY KEY, "collectionId" int, "articleId" int, "modelId" int, "postId" int,
        "imageId" int, "addedById" int);
      INSERT INTO "Collection" VALUES (1, 5, 'Bookmark'), (2, 6, NULL), (3, 7, 'Contest');
      INSERT INTO "CollectionItem" VALUES
        (1, 1, 30, NULL, NULL, NULL, NULL),
        (2, 2, 31, NULL, NULL, NULL, NULL),
        (3, 3, 32, NULL, NULL, NULL, NULL),
        (4, 1, NULL, 40, NULL, NULL, NULL);
    `);
    return pg;
  }

  it('gives an adder only to Bookmark-collection rows of the chosen entity', async () => {
    const pg = await db();
    const { update } = backfillSql('Article');
    const { rows } = await pg.query(update, [0, 100]);
    expect(rows.map((r) => [r.id, r.addedById])).toEqual([[1, 5]]);
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
    const { rows } = await pg.query(backfillSql('Article').breakdown, [0, 100]);
    expect(Object.fromEntries(rows.map((r) => [r.mode ?? 'none', r.n]))).toEqual({
      Bookmark: 1,
      Contest: 1,
      none: 1,
    });
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

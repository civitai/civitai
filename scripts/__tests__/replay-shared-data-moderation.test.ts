import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlockedContentHit } from '~/server/services/blocklist.service';

/**
 * The offline replay of shared-data moderation. The detectors run FOR REAL through the live
 * `scanSharedData` / `scanCounterKey`; only the Redis-backed list reads are mocked (as in
 * `src/server/services/apps/__tests__/shared-data-moderation.test.ts`), and the database is a fake
 * `Query` that records every statement it is sent. All fixtures are synthetic.
 */

const { mockFindBlocked } = vi.hoisted(() => ({
  mockFindBlocked: vi.fn<
    (values: unknown, opts?: { exemptFromPatterns?: boolean }) => Promise<BlockedContentHit[]>
  >(async () => []),
}));

vi.mock('~/server/services/blocklist.service', () => ({
  findBlockedUserContent: (values: unknown, opts?: { exemptFromPatterns?: boolean }) =>
    mockFindBlocked(values, opts),
  stripBenignPhrases: async (text: string) => text,
}));

import {
  blocklistSelfCheck,
  csvCell,
  csvHeader,
  csvRowLine,
  formatSummary,
  LIST_APP_SCHEMAS_SQL,
  replayApp,
  replayCsvRows,
  selectAppSchemas,
  totalTally,
  type AppSchema,
  type Query,
  type ReplayCsvRow,
} from '../shared-data-replay/replay';
import {
  assertNoSinks,
  parseArgs,
  resolveOutPath,
  suppressCacheWrites,
  withReadOnlyTransaction,
} from '../replay-shared-data-moderation';
import {
  SHARED_DATA_HIT_TEXT_MAX_BYTES,
  type SharedTextScan,
} from '~/server/services/apps/shared-data-moderation';

const MINOR = '13 year old girl';
const POI = 'emma watson';

beforeEach(() => {
  vi.clearAllMocks();
  mockFindBlocked.mockResolvedValue([]);
});

type KvFixture = { key: string; data?: unknown; hidden?: boolean };
type CounterFixture = { key: string; anchor?: boolean };

/**
 * A fake storage database. It answers the two page queries by keyset over sorted fixtures and
 * records every statement. It refuses to serve more than 50 statements, so a paging loop that never
 * ends fails as an assertion instead of hanging the worker.
 */
function fakeDb(kv: KvFixture[], counters: CounterFixture[]) {
  const sent: Array<{ sql: string; params?: unknown[] }> = [];
  const page = <T extends { key: string }>(rows: T[], params?: unknown[]) => {
    const [after, limit] = params as [string | null, number];
    return [...rows]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .filter((r) => after === null || r.key > after)
      .slice(0, limit);
  };
  const query: Query = async <R>(sql: string, params?: unknown[]) => {
    sent.push({ sql, params });
    if (sent.length > 50) throw new Error(`fake db: ${sent.length} statements, paging never ended`);
    if (/\.shared_kv\s/.test(sql) && !/\.counters/.test(sql)) {
      return page(kv, params).map((r) => ({
        key: r.key,
        has_data: r.data !== undefined,
        data: r.data === undefined ? null : r.data,
        hidden: !!r.hidden,
      })) as R[];
    }
    if (/\.counters/.test(sql)) {
      return page(counters, params).map((r) => ({
        key: r.key,
        anchor: r.anchor ?? null,
        hidden: false,
      })) as R[];
    }
    throw new Error(`fake db: unexpected statement ${sql}`);
  };
  return { query, sent };
}

const APP: AppSchema = { schema: 'app_demo', slug: 'demo', hasSharedKv: true, hasCounters: true };

async function run(kv: KvFixture[], counters: CounterFixture[], pageSize = 500) {
  const db = fakeDb(kv, counters);
  const rows: ReplayCsvRow[] = [];
  const tally = await replayApp(db.query, APP, (r) => rows.push(r), { pageSize });
  return { ...db, rows, tally };
}

describe('replayApp — the scan path (positive control)', () => {
  // A minor or POI term also trips the green-domain audit, so each planted leaf yields two hit rows:
  // three flagged leaves, six rows.
  it('finds a planted bad data value, a bad object key and a bad counter key: exactly 3 flagged leaves', async () => {
    const { rows, tally } = await run(
      [
        { key: 'r1', data: { note: 'hello', list: ['fine', MINOR] } },
        { key: 'r2', data: { tags: { [POI]: 1 } } },
        { key: 'r3' },
      ],
      [{ key: MINOR, anchor: true }, { key: 'r1' }]
    );
    expect(
      rows.map(({ surface, rowKey, leafPath, leafKind, category }) => ({
        surface,
        rowKey,
        leafPath,
        leafKind,
        category,
      }))
    ).toEqual([
      { surface: 'data', rowKey: 'r1', leafPath: 'list/1', leafKind: 'value', category: 'minor' },
      {
        surface: 'data',
        rowKey: 'r1',
        leafPath: 'list/1',
        leafKind: 'value',
        category: 'audit_regex',
      },
      { surface: 'data', rowKey: 'r2', leafPath: `tags/${POI}`, leafKind: 'key', category: 'poi' },
      {
        surface: 'data',
        rowKey: 'r2',
        leafPath: `tags/${POI}`,
        leafKind: 'key',
        category: 'audit_regex',
      },
      { surface: 'counter', rowKey: MINOR, leafPath: '', leafKind: 'key', category: 'minor' },
      { surface: 'counter', rowKey: MINOR, leafPath: '', leafKind: 'key', category: 'audit_regex' },
    ]);
    expect(new Set(rows.map((r) => `${r.surface}|${r.rowKey}|${r.leafPath}`)).size).toBe(3);
    expect(rows.map((r) => r.leaf)).toEqual([MINOR, MINOR, POI, POI, MINOR, MINOR]);
    expect(rows.every((r) => r.blocksUnderEnforce && r.blocksUnderEnforceWithPatterns)).toBe(true);
    expect(tally).toMatchObject({
      app: 'demo',
      rows: 3,
      rowsWithData: 2,
      counterKeys: 2,
      counterKeysUserChosen: 1,
      blocked: { data: 2, counter: 1 },
    });
    expect(tally.hits.data).toEqual({
      minor: 1,
      poi: 1,
      link: 0,
      pattern: 0,
      audit_regex: 2,
      overflow: 0,
    });
    expect(tally.hits.counter).toEqual({
      minor: 1,
      poi: 0,
      link: 0,
      pattern: 0,
      audit_regex: 1,
      overflow: 0,
    });
  });

  it('a clean fixture of the same shape: 0 hits, with a non-zero denominator', async () => {
    const { rows, tally } = await run(
      [
        { key: 'r1', data: { note: 'hello', list: ['fine', 'a sunny day'] } },
        { key: 'r2', data: { tags: { landscape: 1 } } },
        { key: 'r3' },
      ],
      [{ key: 'likes', anchor: true }, { key: 'r1' }]
    );
    expect(rows).toEqual([]);
    expect(tally).toMatchObject({ rows: 3, rowsWithData: 2, counterKeys: 2 });
    // note, list, hello, fine, a sunny day, tags, landscape = 7 distinct leaves.
    expect(tally.dataLeaves).toBe(7);
    expect(Object.values(tally.hits.data).every((n) => n === 0)).toBe(true);
  });

  it('a pattern-only hit blocks only once patterns are enforced', async () => {
    mockFindBlocked.mockImplementation(async (values) =>
      (values as string[]).flatMap((v, index) =>
        v === 'zz-pattern-zz' ? [{ kind: 'pattern' as const, index, matched: 'pattern' }] : []
      )
    );
    const { rows, tally } = await run([{ key: 'r1', data: { a: 'zz-pattern-zz' } }], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'pattern',
      blocksUnderEnforce: false,
      blocksUnderEnforceWithPatterns: true,
    });
    expect(tally.blocked.data).toBe(0);
    expect(tally.blockedWithPatterns.data).toBe(1);
  });

  it('pages by key from a NULL cursor, reads every row, stops on a short page, and sends only SELECTs', async () => {
    const kv = ['', 'a', 'b', 'c', 'd'].map((key) => ({ key, data: { v: key || 'empty' } }));
    const { sent, tally } = await run(kv, [{ key: 'k1' }, { key: 'k2' }], 2);
    expect(tally.rows).toBe(5);
    expect(tally.counterKeys).toBe(2);
    const kvCursors = sent.filter((s) => !/\.counters/.test(s.sql)).map((s) => s.params?.[0]);
    // 5 rows at 2 per page: 2 + 2 + 1. The first cursor is NULL so the '' key is not skipped.
    expect(kvCursors).toEqual([null, 'a', 'c']);
    expect(sent.every((s) => /^SELECT\b/.test(s.sql.trim()))).toBe(true);
  });
});

describe('selectAppSchemas', () => {
  it('keeps provisioned app schemas with a shared table, and reports the rest', () => {
    const t = (schema: string, kv = true, counters = true) => ({
      schema,
      has_shared_kv: kv,
      has_counters: counters,
    });
    const selection = selectAppSchemas([
      t('app_alpha'),
      t('app_beta_2', true, false),
      t('app_gamma', false, true),
      t('app_userdata_only', false, false),
      t('apprev_alpha'),
      t('app_Upper'),
      t('app_ab'),
    ]);
    expect(selection.apps).toEqual([
      { schema: 'app_alpha', slug: 'alpha', hasSharedKv: true, hasCounters: true },
      { schema: 'app_beta_2', slug: 'beta_2', hasSharedKv: true, hasCounters: false },
      { schema: 'app_gamma', slug: 'gamma', hasSharedKv: false, hasCounters: true },
    ]);
    expect(selection.withoutSharedTables).toEqual(['app_userdata_only']);
    expect(selection.rejected).toEqual(['apprev_alpha', 'app_Upper', 'app_ab']);
  });

  it('INVARIANT GUARD: the listing SQL escapes the LIKE underscore and reads pg_catalog', () => {
    expect(LIST_APP_SCHEMAS_SQL).toContain(`LIKE 'app\\_%'`);
    expect(LIST_APP_SCHEMAS_SQL).not.toContain('information_schema');
  });
});

describe('replayCsvRows / CSV', () => {
  const scanOf = (hits: SharedTextScan['hits']): SharedTextScan => ({
    leafCount: hits.length,
    overflow: null,
    hits,
  });

  it('cuts the leaf as a live shadow record does, and maps an overflow to an empty path', () => {
    const long = 'é'.repeat(SHARED_DATA_HIT_TEXT_MAX_BYTES);
    const rows = replayCsvRows(
      scanOf([
        {
          category: 'minor',
          matched: 'minor',
          label: 'minor',
          leaf: { raw: long, path: 'a/0', segments: ['a', 0], kind: 'value' },
        },
        { category: 'overflow', matched: 'depth', label: 'depth', leaf: null },
      ]),
      { app: 'demo', surface: 'data', rowKey: 'r1', hidden: true }
    );
    expect(Buffer.byteLength(rows[0].leaf)).toBe(SHARED_DATA_HIT_TEXT_MAX_BYTES);
    expect(rows[0]).toMatchObject({ leafPath: 'a/0', leafLength: long.length, hidden: true });
    expect(rows[1]).toMatchObject({ category: 'overflow', leafPath: '', leafKind: '', leaf: '' });
  });

  it('no hits, no rows', () => {
    expect(
      replayCsvRows(scanOf([]), { app: 'a', surface: 'counter', rowKey: 'k', hidden: false })
    ).toEqual([]);
  });

  it('quotes, escapes, and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"\nbye')).toBe('"say ""hi""\nbye"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(true)).toBe('true');
  });

  it('a row line has one cell per header column', () => {
    const row: ReplayCsvRow = {
      app: 'a',
      surface: 'data',
      rowKey: 'k',
      hidden: false,
      leafPath: 'p',
      leafKind: 'value',
      category: 'minor',
      matched: 'minor',
      leafLength: 3,
      leaf: 'x,y',
      blocksUnderEnforce: true,
      blocksUnderEnforceWithPatterns: true,
    };
    expect(csvHeader()).toBe(
      'app,surface,rowKey,hidden,leafPath,leafKind,category,matched,leafLength,leaf,' +
        'blocksUnderEnforce,blocksUnderEnforceWithPatterns\n'
    );
    expect(csvRowLine(row)).toBe('a,data,k,false,p,value,minor,minor,3,"x,y",true,true\n');
  });
});

describe('summary', () => {
  it('totals every count across apps', async () => {
    const a = (await run([{ key: 'r1', data: { x: MINOR } }], [{ key: MINOR, anchor: true }]))
      .tally;
    const b = (await run([{ key: 'r1', data: { y: 'fine' } }, { key: 'r2' }], [])).tally;
    const total = totalTally([a, { ...b, app: 'other' }]);
    expect(total).toMatchObject({
      app: 'TOTAL',
      rows: 3,
      rowsWithData: 2,
      dataLeaves: 4,
      counterKeys: 1,
      counterKeysUserChosen: 1,
      blocked: { data: 1, counter: 1 },
    });
    expect(total.hits.data.minor).toBe(1);
    expect(total.hits.counter.minor).toBe(1);
    const text = formatSummary([a, { ...b, app: 'other' }]);
    expect(text).toContain(
      'TOTAL: rows=3 rowsWithData=2 dataLeaves=4 counterKeys=1 (userChosen=1)'
    );
    expect(text).toContain('demo: rows=1');
    expect(text).toContain('other: rows=2');
  });
});

describe('blocklistSelfCheck', () => {
  const lists = { linkDomains: ['Not A Host', 'bad.example'], messagePatterns: ['zz probe'] };
  const scanWith =
    (...categories: Array<'link' | 'pattern'>) =>
    async (): Promise<SharedTextScan> => ({
      leafCount: 2,
      overflow: null,
      hits: categories.map((category) => ({ category, matched: '', label: '', leaf: null })),
    });

  it('passes when both detectors catch the probe, built from a usable entry of each list', async () => {
    const scan = vi.fn(scanWith('link', 'pattern'));
    await expect(blocklistSelfCheck(lists, scan)).resolves.toBeUndefined();
    expect(scan).toHaveBeenCalledWith({ a: 'see https://bad.example/x', b: 'zz zz probe zz' });
  });

  it.each([
    ['link', scanWith('pattern'), /not caught by: link/],
    ['pattern', scanWith('link'), /not caught by: pattern/],
  ] as const)('fails when the %s detector misses its probe', async (_, scan, error) => {
    await expect(blocklistSelfCheck(lists, scan)).rejects.toThrow(error);
  });

  it('fails on an empty list instead of reading it as a clean zero', async () => {
    const scan = scanWith('link', 'pattern');
    await expect(blocklistSelfCheck({ ...lists, linkDomains: [] }, scan)).rejects.toThrow(
      /LinkDomain blocklist read as EMPTY/
    );
    await expect(blocklistSelfCheck({ ...lists, messagePatterns: [] }, scan)).rejects.toThrow(
      /MessagePattern blocklist read as EMPTY/
    );
    await expect(
      blocklistSelfCheck({ linkDomains: ['Not A Host'], messagePatterns: ['zz'] }, scan)
    ).rejects.toThrow(/no usable/);
  });
});

describe('entry-script guards', () => {
  it('refuses ClickHouse or Axiom configuration', () => {
    expect(() => assertNoSinks({ CLICKHOUSE_HOST: '', AXIOM_TOKEN: '' })).not.toThrow();
    expect(() => assertNoSinks({})).not.toThrow();
    expect(() => assertNoSinks({ CLICKHOUSE_HOST: 'h', AXIOM_TOKEN: '' })).toThrow(
      /CLICKHOUSE_HOST must be empty/
    );
    expect(() => assertNoSinks({ AXIOM_TOKEN: 't' })).toThrow(/AXIOM_TOKEN must be empty/);
  });

  it('refuses an output path inside the repository, accepts one outside', () => {
    const repo = path.resolve('/work/repo');
    expect(() => resolveOutPath('/work/repo/out.csv', repo)).toThrow(/inside the repository/);
    expect(() => resolveOutPath('/work/repo', repo)).toThrow(/inside the repository/);
    expect(resolveOutPath('/work/repo-other/out.csv', repo)).toBe('/work/repo-other/out.csv');
    expect(resolveOutPath('/tmp/out.csv', repo)).toBe('/tmp/out.csv');
  });

  it('parses arguments and defaults the CSV to the OS temp dir', () => {
    const args = parseArgs([], new Date('2026-01-02T03:04:05.006Z'));
    expect(path.basename(args.out)).toBe('shared-data-replay-2026-01-02T03-04-05-006Z.csv');
    expect(args.pageSize).toBe(500);
    expect(parseArgs(['--out', '/x/y.csv', '--page-size', '7'])).toEqual({
      out: '/x/y.csv',
      pageSize: 7,
    });
    expect(() => parseArgs(['--page-size', '0'])).toThrow();
    expect(() => parseArgs(['--write'])).toThrow(/unknown/);
  });

  it('suppressCacheWrites: the cache client set never reaches the original, and is counted', async () => {
    const original = vi.fn(async () => 'OK');
    const client = { set: original, get: vi.fn() };
    const guard = suppressCacheWrites(client);
    await client.set();
    await client.set();
    expect(original).not.toHaveBeenCalled();
    expect(guard.suppressed()).toBe(2);
  });

  it('withReadOnlyTransaction: READ ONLY first, ROLLBACK last even on failure, client released', async () => {
    const statements: string[] = [];
    const release = vi.fn();
    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [{ ok: 1 }] };
        },
        release,
      }),
    };
    await expect(
      withReadOnlyTransaction(pool, async (query) => {
        await query('SELECT 1');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(statements).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SELECT 1',
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

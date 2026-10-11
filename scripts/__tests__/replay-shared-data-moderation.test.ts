import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCluster, RESP_TYPES } from 'redis';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlockedContentHit } from '~/server/services/blocklist.service';

/**
 * The offline replay of shared-data moderation. The detectors run FOR REAL through the live
 * `scanSharedData` / `scanCounterKey`; only the Redis-backed list reads are mocked (as in
 * `src/server/services/apps/__tests__/shared-data-moderation.test.ts`), and the database is a fake
 * `Query` that records every statement it is sent. All fixtures are synthetic.
 *
 * What these tests cannot see: the SQL text is never executed here (the fake implements keyset
 * semantics itself). It was run against a throwaway local Postgres when this was written — see the
 * PR — and nothing in CI re-runs it.
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
  countersPageSql,
  csvHeader,
  csvRowLine,
  formatSummary,
  LIST_APP_SCHEMAS_SQL,
  replayApp,
  replayCsvRows,
  selectAppSchemas,
  sharedKvPageSql,
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
  withCsvFile,
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
type CounterFixture = { key: string; anchor?: boolean; hidden?: boolean };

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
        hidden: !!r.hidden,
      })) as R[];
    }
    throw new Error(`fake db: unexpected statement ${sql}`);
  };
  return { query, sent };
}

const APP: AppSchema = { schema: 'app_demo', slug: 'demo', hasSharedKv: true, hasCounters: true };

async function run(kv: KvFixture[], counters: CounterFixture[], pageSize = 500, app = APP) {
  const db = fakeDb(kv, counters);
  const rows: ReplayCsvRow[] = [];
  const tally = await replayApp(db.query, app, (r) => rows.push(r), { pageSize });
  return { ...db, rows, tally };
}

describe('replayApp — the scan path (positive control)', () => {
  // A minor or POI term also trips the green-domain audit, so each planted leaf yields two hit rows:
  // three flagged leaves, six rows.
  it('finds a planted bad data value, a bad object key and a bad counter key: exactly 3 flagged leaves', async () => {
    const { rows, tally } = await run(
      [
        { key: 'r1', data: { note: 'hello', list: ['fine', MINOR] } },
        { key: 'r2', data: { tags: { [POI]: 1 } }, hidden: true },
        { key: 'r3' },
      ],
      [{ key: MINOR, anchor: true }, { key: 'r1' }]
    );
    expect(
      rows.map(
        ({ app, surface, rowKey, hidden, leafPath, leafKind, category, userChosenCounter }) =>
          [app, surface, rowKey, hidden, leafPath, leafKind, category, userChosenCounter].join('|')
      )
    ).toEqual([
      'demo|data|r1|false|list/1|value|minor|',
      'demo|data|r1|false|list/1|value|audit_regex|',
      `demo|data|r2|true|tags/${POI}|key|poi|`,
      `demo|data|r2|true|tags/${POI}|key|audit_regex|`,
      `demo|counter|${MINOR}|false||key|minor|true`,
      `demo|counter|${MINOR}|false||key|audit_regex|true`,
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
      userChosenCounters: { blocked: 1, blockedWithPatterns: 1 },
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
    expect(tally.userChosenCounters.hits).toEqual(tally.hits.counter);
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

  it('a bad key whose anchor is NOT user-chosen is reported, but kept out of the user-chosen tally', async () => {
    const { rows, tally } = await run([], [{ key: MINOR, anchor: false, hidden: true }]);
    expect(rows.map((r) => [r.userChosenCounter, r.hidden])).toEqual([
      [false, true],
      [false, true],
    ]);
    expect(tally.blocked.counter).toBe(1);
    expect(tally.counterKeysUserChosen).toBe(0);
    expect(tally.userChosenCounters).toEqual({
      hits: { minor: 0, poi: 0, link: 0, pattern: 0, audit_regex: 0, overflow: 0 },
      blocked: 0,
      blockedWithPatterns: 0,
    });
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
    const { sent, tally } = await run(kv, [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }], 2);
    expect(tally.rows).toBe(5);
    expect(tally.counterKeys).toBe(3);
    const cursors = (counters: boolean) =>
      sent.filter((s) => /\.counters/.test(s.sql) === counters).map((s) => s.params);
    // 5 rows at 2 per page: 2 + 2 + 1. The first cursor is NULL so the '' key is not skipped.
    expect(cursors(false)).toEqual([
      [null, 2],
      ['a', 2],
      ['c', 2],
    ]);
    expect(cursors(true)).toEqual([
      [null, 2],
      ['k2', 2],
    ]);
    expect(sent.every((s) => /^SELECT\b/.test(s.sql.trim()))).toBe(true);
  });

  it('a counters-only app reads counters WITHOUT the shared_kv join; a shared-only app never reads counters', async () => {
    const countersOnly = await run([{ key: 'r1', data: { a: 'x' } }], [{ key: 'k1' }], 500, {
      ...APP,
      hasSharedKv: false,
    });
    expect(countersOnly.sent).toHaveLength(1);
    expect(countersOnly.sent[0].sql).toBe(countersPageSql('demo', false));
    expect(countersOnly.sent[0].sql).not.toContain('shared_kv');
    expect(countersOnly.tally).toMatchObject({ rows: 0, counterKeys: 1, counterKeysUserChosen: 0 });

    const sharedOnly = await run([{ key: 'r1', data: { a: 'x' } }], [{ key: 'k1' }], 500, {
      ...APP,
      hasCounters: false,
    });
    expect(sharedOnly.sent.map((s) => s.sql)).toEqual([sharedKvPageSql('demo')]);
    expect(sharedOnly.tally).toMatchObject({ rows: 1, counterKeys: 0 });
  });

  it('quotes the schema with the provisioner identifier helper, and refuses an unsafe slug', () => {
    expect(sharedKvPageSql('demo')).toContain('FROM "app_demo".shared_kv');
    expect(countersPageSql('demo', true)).toContain('LEFT JOIN "app_demo".shared_kv s');
    expect(() => sharedKvPageSql('demo"; drop')).toThrow(/invalid app slug/);
    expect(() => countersPageSql('Demo', false)).toThrow(/invalid app slug/);
  });
});

describe('selectAppSchemas', () => {
  const t = (schema: string, kv = true, counters = true) => ({
    schema,
    has_shared_kv: kv,
    has_counters: counters,
  });

  it('keeps provisioned app schemas with a shared table, and reports the rest', () => {
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

  it('rejects names with a valid prefix and an unsafe tail, and holds the length bounds', () => {
    const slug41 = `a${'b'.repeat(40)}`;
    const slug42 = `a${'b'.repeat(41)}`;
    const names = [
      'app_alpha"x',
      'app_alpha-x',
      'app_alpha x',
      'xapp_alpha',
      'app_1alpha',
      `app_${slug42}`,
    ];
    const selection = selectAppSchemas([
      ...names.map((n) => t(n)),
      t('app_abc'),
      t(`app_${slug41}`),
    ]);
    expect(selection.rejected).toEqual(names);
    expect(selection.apps.map((a) => a.slug)).toEqual(['abc', slug41]);
  });

  it('INVARIANT GUARD: the listing SQL escapes the LIKE underscore and reads pg_catalog', () => {
    // Spelled, and labelled as such: `selectAppSchemas` rejects `apprev_*` regardless, so this only
    // pins that the database is not asked for the review sandboxes in the first place.
    expect(LIST_APP_SCHEMAS_SQL).toContain(`WHERE n.nspname LIKE 'app\\_%'`);
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
    expect(rows[0]).toMatchObject({
      leafPath: 'a/0',
      leafLength: long.length,
      hidden: true,
      userChosenCounter: null,
    });
    expect(rows[1]).toMatchObject({ category: 'overflow', leafPath: '', leafKind: '', leaf: '' });
  });

  it('no hits, no rows', () => {
    expect(
      replayCsvRows(scanOf([]), { app: 'a', surface: 'counter', rowKey: 'k', hidden: false })
    ).toEqual([]);
  });

  const row = (over: Partial<ReplayCsvRow>): ReplayCsvRow => ({
    app: 'a',
    surface: 'data',
    rowKey: 'k',
    hidden: false,
    leafPath: 'p',
    leafKind: 'value',
    category: 'minor',
    matched: 'minor',
    leafLength: 3,
    leaf: 'x',
    userChosenCounter: null,
    blocksUnderEnforce: true,
    blocksUnderEnforceWithPatterns: false,
    ...over,
  });

  it('a row line has one cell per header column, CRLF-terminated', () => {
    expect(csvHeader()).toBe(
      'app,surface,rowKey,hidden,leafPath,leafKind,category,matched,leafLength,leaf,' +
        'userChosenCounter,blocksUnderEnforce,blocksUnderEnforceWithPatterns\r\n'
    );
    expect(csvRowLine(row({ leaf: 'x,y', userChosenCounter: true }))).toBe(
      'a,data,k,false,p,value,minor,minor,3,"x,y",true,true,false\r\n'
    );
    expect(csvRowLine(row({}))).toBe('a,data,k,false,p,value,minor,minor,3,x,,true,false\r\n');
  });

  it.each([
    ['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
    ['say "hi"\nbye', '"say ""hi""\nbye"'],
  ])('escapes a user-text cell %j as %j', (leaf, cell) => {
    expect(csvRowLine(row({ leaf }))).toBe(
      `a,data,k,false,p,value,minor,minor,3,${cell},,true,false\r\n`
    );
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
      blockedWithPatterns: { data: 1, counter: 1 },
      userChosenCounters: { blocked: 1, blockedWithPatterns: 1 },
    });
    expect(total.hits.data.minor).toBe(1);
    expect(total.hits.counter.minor).toBe(1);
    expect(total.userChosenCounters.hits.minor).toBe(1);
  });

  it('prints one block per app with rows or counters, then TOTAL — literally', async () => {
    const a = (await run([{ key: 'r1', data: { x: MINOR } }], [{ key: 'ok', anchor: true }])).tally;
    const empty = (await run([], [])).tally;
    expect(formatSummary([a, { ...empty, app: 'idle' }])).toBe(
      [
        'demo: rows=1 rowsWithData=1 dataLeaves=2 counterKeys=1 (userChosen=1)',
        '  data hits:    minor=1 poi=0 link=0 pattern=0 audit_regex=1 overflow=0',
        '  counter hits: minor=0 poi=0 link=0 pattern=0 audit_regex=0 overflow=0',
        '  user-chosen counter hits: minor=0 poi=0 link=0 pattern=0 audit_regex=0 overflow=0',
        '  would block under enforce: data=1 counter=0 | with patterns enforced: data=1 counter=0',
        '  user-chosen counters that would block: 0 | with patterns enforced: 0',
        'TOTAL: rows=1 rowsWithData=1 dataLeaves=2 counterKeys=1 (userChosen=1)',
        '  data hits:    minor=1 poi=0 link=0 pattern=0 audit_regex=1 overflow=0',
        '  counter hits: minor=0 poi=0 link=0 pattern=0 audit_regex=0 overflow=0',
        '  user-chosen counter hits: minor=0 poi=0 link=0 pattern=0 audit_regex=0 overflow=0',
        '  would block under enforce: data=1 counter=0 | with patterns enforced: data=1 counter=0',
        '  user-chosen counters that would block: 0 | with patterns enforced: 0',
      ].join('\n')
    );
  });
});

describe('blocklistSelfCheck', () => {
  const lists = {
    linkDomains: ['Not A Host', 'Upper.Example', 'bad.example'],
    messagePatterns: ['   ', 'ZZ Upper', 'zz probe'],
  };
  const scanWith =
    (...categories: Array<'link' | 'pattern'>) =>
    async (): Promise<SharedTextScan> => ({
      leafCount: 2,
      overflow: null,
      hits: categories.map((category) => ({ category, matched: '', label: '', leaf: null })),
    });

  it('builds the probe from the first entry each detector can actually match', async () => {
    const scan = vi.fn(scanWith('link', 'pattern'));
    await expect(blocklistSelfCheck(lists, scan)).resolves.toBeUndefined();
    expect(scan).toHaveBeenCalledWith({ a: 'see https://bad.example/x', b: 'zz zz probe zz' });
  });

  it('runs the probe through the REAL scan, and passes only when both lists catch it', async () => {
    mockFindBlocked.mockImplementation(async (values) =>
      (values as string[]).flatMap((v, index): BlockedContentHit[] => [
        ...(v.includes('https://bad.example/')
          ? [{ kind: 'link' as const, index, matched: ['x'] }]
          : []),
        ...(v.includes('zz probe')
          ? [{ kind: 'pattern' as const, index, matched: 'zz probe' }]
          : []),
      ])
    );
    await expect(blocklistSelfCheck(lists)).resolves.toBeUndefined();
    mockFindBlocked.mockResolvedValue([]);
    await expect(blocklistSelfCheck(lists)).rejects.toThrow(/not caught by: link, pattern/);
  });

  it.each([
    ['link', scanWith('pattern'), /not caught by: link$/],
    ['pattern', scanWith('link'), /not caught by: pattern$/],
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
      blocklistSelfCheck({ linkDomains: ['Upper.Example'], messagePatterns: ['zz'] }, scan)
    ).rejects.toThrow(/no usable/);
    await expect(
      blocklistSelfCheck({ linkDomains: ['bad.example'], messagePatterns: ['   ', 'ZZ'] }, scan)
    ).rejects.toThrow(/no usable/);
  });
});

describe('entry-script guards', () => {
  it('refuses ClickHouse or Axiom configuration — any non-empty value, as the client gates read it', () => {
    expect(() => assertNoSinks({ CLICKHOUSE_HOST: '', AXIOM_TOKEN: '' })).not.toThrow();
    expect(() => assertNoSinks({})).not.toThrow();
    expect(() => assertNoSinks({ CLICKHOUSE_HOST: 'h', AXIOM_TOKEN: '' })).toThrow(
      /^CLICKHOUSE_HOST must be empty/
    );
    expect(() => assertNoSinks({ AXIOM_TOKEN: ' ' })).toThrow(/^AXIOM_TOKEN must be empty/);
    expect(() => assertNoSinks({ CLICKHOUSE_HOST: 'h', AXIOM_TOKEN: 't' })).toThrow(
      /^CLICKHOUSE_HOST and AXIOM_TOKEN must be empty/
    );
  });

  describe('resolveOutPath', () => {
    // A fake filesystem: these paths exist, and `/tmp/link` is a symlink into a checkout.
    const fsFake = (paths: string[], links: Record<string, string> = {}) => ({
      exists: (p: string) => paths.includes(p),
      realpath: (p: string) => links[p] ?? p,
    });

    it('refuses a path inside any checkout — found by its .git — and accepts one outside', () => {
      const f = fsFake(['/', '/work', '/work/repo', '/work/repo/.git', '/work/other', '/tmp']);
      const resolve = (out: string) => resolveOutPath(out, f.exists, f.realpath);
      expect(() => resolve('/work/repo/out.csv')).toThrow(
        /inside a git checkout: \/work\/repo\/out.csv/
      );
      // A directory that does not exist yet, inside the checkout, is still refused.
      expect(() => resolve('/work/repo/new/dir/out.csv')).toThrow(/inside a git checkout/);
      expect(resolve('/work/other/out.csv')).toBe('/work/other/out.csv');
      expect(resolve('/tmp/out.csv')).toBe('/tmp/out.csv');
    });

    it('resolves the parent through symlinks first, so a link cannot smuggle the file in', () => {
      const f = fsFake(['/', '/tmp', '/tmp/link', '/work', '/work/repo', '/work/repo/.git'], {
        '/tmp/link': '/work/repo/sub',
      });
      expect(() => resolveOutPath('/tmp/link/out.csv', f.exists, f.realpath)).toThrow(
        /inside a git checkout/
      );
    });

    it('against the real filesystem: the OS temp dir passes, this checkout does not', () => {
      const tmp = fs.realpathSync(os.tmpdir());
      expect(resolveOutPath(path.join(tmp, 'x.csv'))).toBe(path.join(tmp, 'x.csv'));
      expect(() => resolveOutPath(path.join(__dirname, 'x.csv'))).toThrow(/inside a git checkout/);
    });
  });

  it('parses arguments and defaults the CSV to the OS temp dir', () => {
    const args = parseArgs([], new Date('2026-01-02T03:04:05.006Z'));
    expect(args.out).toBe(
      path.join(os.tmpdir(), 'shared-data-replay-2026-01-02T03-04-05-006Z.csv')
    );
    expect(args.pageSize).toBe(500);
    expect(parseArgs(['--out', '/x/y.csv', '--page-size', '7'])).toEqual({
      out: '/x/y.csv',
      pageSize: 7,
    });
    for (const bad of ['0', '1.5', 'abc', '-3']) {
      expect(() => parseArgs(['--page-size', bad])).toThrow();
    }
    expect(() => parseArgs(['--out', '--page-size', '5'])).toThrow(/incomplete argument: --out/);
    expect(() => parseArgs(['--write'])).toThrow(/unknown/);
  });

  describe('suppressCacheWrites', () => {
    it('set never reaches the original; get serves what was set, and forwards everything else', async () => {
      const originalSet = vi.fn<(key: string, value: string) => Promise<string>>(async () => 'OK');
      const originalGet = vi.fn(async (key: string) => `redis:${key}`);
      const client = { set: originalSet, get: originalGet };
      const guard = suppressCacheWrites(client);
      await expect(client.set('k1', 'v1')).resolves.toBeNull();
      await expect(client.set('k1', 'v2')).resolves.toBeNull();
      await expect(client.get('k1')).resolves.toBe('v2');
      await expect(client.get('other')).resolves.toBe('redis:other');
      expect(originalSet).not.toHaveBeenCalled();
      expect(originalGet).toHaveBeenCalledTimes(1);
      expect(originalGet).toHaveBeenCalledWith('other');
      expect(guard.memoisedKeys()).toBe(1);
    });

    it('a client DERIVED by prototype keeps its own get (its own `this`), and never sees the memo', async () => {
      class Client {
        constructor(public tag: string) {}
        async get(key: string) {
          return `${this.tag}:${key}`;
        }
        async set() {
          return 'OK';
        }
      }
      const base = new Client('base');
      const derived = Object.create(base) as Client;
      derived.tag = 'derived';
      suppressCacheWrites(base);
      await base.set();
      await (base.set as (k: string, v: string) => Promise<unknown>)('k', 'memo');
      await expect(base.get('k')).resolves.toBe('memo');
      await expect(derived.get('k')).resolves.toBe('derived:k');
      await expect(derived.get('x')).resolves.toBe('derived:x');
      // `set` is intercepted for every caller, derived ones included: no path through it writes.
      await expect(derived.set()).resolves.toBeNull();
    });

    it('on a real node-redis cluster client (never connected): set and get are served locally, while a derived reader still goes to Redis', async () => {
      // Control: unguarded, a never-connected client refuses the write.
      const control = createCluster({ rootNodes: [{ url: 'redis://127.0.0.1:1' }] });
      await expect(control.set('k', 'v')).rejects.toThrow();

      const client = createCluster({ rootNodes: [{ url: 'redis://127.0.0.1:1' }] });
      const derived = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
      suppressCacheWrites(client);
      await expect(client.set('k', 'v')).resolves.toBeNull();
      await expect(client.get('k')).resolves.toBe('v');
      // The Buffer-mapped reader is NOT handed the memo's string: it runs the real command, which
      // rejects here because nothing is connected.
      await expect(derived.get('k')).rejects.toThrow();
      expect(client.isOpen).toBe(false);
    });
  });

  describe('withCsvFile', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-csv-test-'));
      return () => fs.rmSync(dir, { recursive: true, force: true });
    });

    it('creates the file 0600, writes the lines, and prints its path', async () => {
      const out = path.join(dir, 'a.csv');
      const log = vi.fn();
      await expect(
        withCsvFile(
          out,
          async (write) => {
            write('h\r\n');
            write('r\r\n');
            return 7;
          },
          log
        )
      ).resolves.toBe(7);
      expect(fs.readFileSync(out, 'utf8')).toBe('h\r\nr\r\n');
      expect(fs.statSync(out).mode & 0o777).toBe(0o600);
      expect(log).toHaveBeenCalledWith(`writing CSV: ${out}`);
    });

    it('deletes the partial file when the body fails, and rethrows', async () => {
      const out = path.join(dir, 'b.csv');
      const log = vi.fn();
      await expect(
        withCsvFile(
          out,
          async (write) => {
            write('partial user text\r\n');
            throw new Error('scan failed');
          },
          log
        )
      ).rejects.toThrow('scan failed');
      expect(fs.existsSync(out)).toBe(false);
      expect(log).toHaveBeenCalledWith(`run failed; deleted the partial CSV ${out}`);
    });

    it('refuses an existing file and leaves it untouched', async () => {
      const out = path.join(dir, 'c.csv');
      fs.writeFileSync(out, 'keep');
      const body = vi.fn(async () => undefined);
      await expect(withCsvFile(out, body, () => undefined)).rejects.toThrow(/EEXIST/);
      expect(body).not.toHaveBeenCalled();
      expect(fs.readFileSync(out, 'utf8')).toBe('keep');
    });
  });

  describe('withReadOnlyTransaction', () => {
    const fakePool = (fail?: string) => {
      const statements: Array<[string, unknown[] | undefined]> = [];
      const release = vi.fn();
      const pool = {
        connect: async () => ({
          query: async (sql: string, params?: unknown[]) => {
            statements.push([sql, params]);
            if (sql === fail) throw new Error(`boom: ${sql}`);
            return { rows: [{ sql }] };
          },
          release,
        }),
      };
      return { pool, statements, release };
    };
    const OPEN = [
      ['BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', undefined],
      ['SET LOCAL idle_in_transaction_session_timeout = 0', undefined],
    ];

    it('success: READ ONLY first, params forwarded, rows returned, ROLLBACK last, released', async () => {
      const { pool, statements, release } = fakePool();
      const result = await withReadOnlyTransaction(pool, (query) => query('SELECT $1', ['p']));
      expect(result).toEqual([{ sql: 'SELECT $1' }]);
      expect(statements).toEqual([...OPEN, ['SELECT $1', ['p']], ['ROLLBACK', undefined]]);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('failure: still ROLLBACK and release', async () => {
      const { pool, statements, release } = fakePool('SELECT 1');
      await expect(withReadOnlyTransaction(pool, (query) => query('SELECT 1'))).rejects.toThrow(
        'boom: SELECT 1'
      );
      expect(statements).toEqual([...OPEN, ['SELECT 1', undefined], ['ROLLBACK', undefined]]);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('a failing ROLLBACK does not mask the result, and the client is still released', async () => {
      const { pool, release } = fakePool('ROLLBACK');
      await expect(withReadOnlyTransaction(pool, (query) => query('SELECT 2'))).resolves.toEqual([
        { sql: 'SELECT 2' },
      ]);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  describe('STRUCTURAL: nothing that could build a client loads before the sink check', () => {
    // The sink check must run after `.env` loads and BEFORE any module that constructs a ClickHouse,
    // Axiom or Redis client, and the cache guard must be installed before any blocklist read. Read
    // from the entry script's AST, so the spelling of an import (quotes, side-effect form, require,
    // re-export) cannot walk past it.
    const ALLOWED_STATIC = [
      'node:fs',
      'node:os',
      'node:path',
      './decision-eval/safety',
      './lib/run-as-script',
    ];

    function violations(source: string): string[] {
      const file = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true);
      const found: string[] = [];
      const dynamicImports: Array<{ spec: string; pos: number }> = [];
      const calls: Record<string, number[]> = {};
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
          const spec = (node.moduleSpecifier as ts.StringLiteral).text;
          if (!node.importClause?.isTypeOnly && !ALLOWED_STATIC.includes(spec)) {
            found.push(`static import ${spec}`);
          }
        } else if (ts.isImportEqualsDeclaration(node)) {
          found.push('import = require');
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          found.push('export … from');
        } else if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (callee.kind === ts.SyntaxKind.ImportKeyword) {
            const arg = node.arguments[0];
            dynamicImports.push({
              spec: arg && ts.isStringLiteral(arg) ? arg.text : '<computed>',
              pos: node.getStart(),
            });
          } else {
            const name = ts.isIdentifier(callee)
              ? callee.text
              : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : '';
            if (name === 'require') found.push('require()');
            (calls[name] ??= []).push(node.getStart());
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);

      const sinkCheck = calls.assertNoSinks?.[0] ?? -1;
      const guard = calls.suppressCacheWrites?.[0] ?? -1;
      if (sinkCheck < 0) found.push('no assertNoSinks call');
      if (guard < 0) found.push('no suppressCacheWrites call');
      for (const { spec, pos } of dynamicImports) {
        if (spec === '~/env/server' ? pos > sinkCheck : pos < sinkCheck) {
          found.push(`import(${spec}) on the wrong side of assertNoSinks`);
        }
      }
      for (const name of ['getBlocklistData', 'blocklistSelfCheck', 'replayApp']) {
        for (const pos of calls[name] ?? []) {
          if (pos < guard) found.push(`${name} before suppressCacheWrites`);
        }
      }
      return found;
    }

    const entry = fs.readFileSync(
      path.join(__dirname, '..', 'replay-shared-data-moderation.ts'),
      'utf8'
    );

    it('the entry script has no violation', () => {
      expect(violations(entry)).toEqual([]);
    });

    it.each([
      ['a side-effect import', `import '~/server/redis/client';\n${entry}`, 'static import'],
      [
        'a double-quoted import',
        `import { x } from "~/server/db/client";\n${entry}`,
        'static import',
      ],
      ['a re-export', `export * from '~/server/db/client';\n${entry}`, 'export … from'],
      ['import = require', `import x = require('y');\n${entry}`, 'import = require'],
      ['a bare require', `${entry}\nconst z = require('w');`, 'require()'],
      [
        'a server import hoisted above the check',
        entry.replace(
          '  assertNoSinks(process.env);',
          "  await import('./shared-data-replay/replay');\n  assertNoSinks(process.env);"
        ),
        'wrong side of assertNoSinks',
      ],
      [
        'a blocklist read before the cache guard',
        entry.replace(
          '  const cacheGuard = suppressCacheWrites(redis);',
          "  getBlocklistData('x');\n  const cacheGuard = suppressCacheWrites(redis);"
        ),
        'getBlocklistData before suppressCacheWrites',
      ],
    ])('negative control: catches %s', (_, source, expected) => {
      expect(source).not.toBe(entry);
      expect(violations(source).join('\n')).toContain(expected);
    });
  });
});

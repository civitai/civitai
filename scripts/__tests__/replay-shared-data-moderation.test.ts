import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCluster } from 'redis';
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
  isInGitWorkTree,
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
    const repoRoot = path.resolve('/work/repo');
    const opts = (inGit = false) => ({
      repoRoot,
      inGitWorkTree: () => inGit,
      realpath: (p: string) => p,
    });

    it('refuses this repository, and accepts a sibling whose name merely starts with the repo or ..', () => {
      expect(() => resolveOutPath('/work/repo/out.csv', opts())).toThrow(/inside a git work tree/);
      expect(() => resolveOutPath('/work/repo/..foo/out.csv', opts())).toThrow(/inside a git/);
      expect(resolveOutPath('/work/repo-other/out.csv', opts())).toBe('/work/repo-other/out.csv');
      expect(resolveOutPath('/work/..x/out.csv', opts())).toBe('/work/..x/out.csv');
    });

    it('refuses any OTHER git work tree, and resolves the parent through symlinks first', () => {
      expect(() => resolveOutPath('/elsewhere/out.csv', opts(true))).toThrow(/inside a git/);
      const realpath = (p: string) => (p === '/tmp/link' ? '/work/repo/sub' : p);
      expect(() => resolveOutPath('/tmp/link/out.csv', { ...opts(), realpath })).toThrow(
        /inside a git work tree: \/work\/repo\/sub\/out.csv/
      );
    });

    it('against the real filesystem and git: the OS temp dir passes, this checkout does not', () => {
      const tmp = fs.realpathSync(os.tmpdir());
      expect(isInGitWorkTree(tmp)).toBe(false);
      expect(isInGitWorkTree(process.cwd())).toBe(true);
      expect(resolveOutPath(path.join(tmp, 'x.csv'))).toBe(path.join(tmp, 'x.csv'));
      expect(() => resolveOutPath(path.join(process.cwd(), 'x.csv'))).toThrow(/inside a git/);
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
      await expect(client.get('k1')).resolves.toBe('v1');
      await expect(client.get('other')).resolves.toBe('redis:other');
      expect(originalSet).not.toHaveBeenCalled();
      expect(originalGet).toHaveBeenCalledTimes(1);
      expect(originalGet).toHaveBeenCalledWith('other');
      expect(guard.suppressed()).toBe(1);
    });

    it('takes effect on a real node-redis cluster client (never connected)', async () => {
      const client = createCluster({ rootNodes: [{ url: 'redis://127.0.0.1:1' }] });
      suppressCacheWrites(client);
      await expect(client.set('k', 'v')).resolves.toBeNull();
      await expect(client.get('k')).resolves.toBe('v');
      expect(client.isOpen).toBe(false);
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
            if (sql === fail) throw new Error('boom');
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
        'boom'
      );
      expect(statements).toEqual([...OPEN, ['SELECT 1', undefined], ['ROLLBACK', undefined]]);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it('STRUCTURAL: the entry script statically imports nothing that could build a client', () => {
    // The sink check must run after `.env` loads and BEFORE any module that constructs a ClickHouse,
    // Axiom or Redis client. That holds only while every server-graph import in the entry script is
    // a dynamic `await import(...)` inside `main`. A static import is hoisted above the check.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'replay-shared-data-moderation.ts'),
      'utf8'
    );
    const staticImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)].map(
      (m) => m[1]
    );
    expect(staticImports).toEqual([
      'node:child_process',
      'node:fs',
      'node:os',
      'node:path',
      './lib/run-as-script',
    ]);
    const order = ['~/env/server', 'assertNoSinks(process.env)', '~/server/redis/client'].map(
      (needle) => source.indexOf(needle, source.indexOf('async function main'))
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});

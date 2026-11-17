import { describe, it, expect, beforeEach, vi } from 'vitest';

// Regression guard for ClickUp 868kta7p0. The blocked-hash writers moved their values
// through a JS `number`, which holds 53 bits — every 64-bit hash was silently rounded on
// the way in, while both readers pass the value through at full precision. Nothing errors
// and the row count looks right, so the only thing that catches it is asserting the exact
// value at the clickhouse boundary.
//
// image.service is the graph root. db/redis/logging come from the canonical shared mocks
// registered in setup; what is left here is the clickhouse boundary this asserts on, plus
// the env and submodule stubs image.service needs to import at all.

const capturedInserts: Array<{ table: string; values: any[] }> = [];
const capturedQueries: string[] = [];
let queryResult: any[] = [];
/** What the CSAM-entry lookup returns; every other query gets `queryResult`. */
let csamQueryResult: any[] = [];
let csamLookupFails = false;
let clientAbsent = false;

function makePermissive(overrides: Record<string, unknown> = {}): any {
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop in overrides) return overrides[prop as string];
      if (!(prop in target)) target[prop as string] = makePermissive();
      return target[prop as string];
    },
    apply() {
      return Promise.resolve([]);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return new Proxy(function () {}, handler);
}

// event-engine-common is a git submodule, not checked out by default.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Real env validation throws in test; a Proxy hands back safe defaults for whatever
// image.service reads at import time.
vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

const fakeClickhouse = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return clientAbsent ? undefined : fakeClickhouse.client;
  },
}));
fakeClickhouse.client = makePermissive({
  insert: async (args: { table: string; values: any[] }) => {
    capturedInserts.push({ table: args.table, values: args.values });
  },
  $query: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = Array.isArray(strings)
      ? strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '')
      : String(strings);
    capturedQueries.push(query);
    if (!query.includes("= 'CSAM'")) return Promise.resolve(queryResult);
    if (csamLookupFails) return Promise.reject(new Error('Socket hang up'));
    if (tableRows) return Promise.resolve(liveCsamHashes(tableRows, query));
    return Promise.resolve(csamQueryResult);
  },
});

type TableRow = { hash: string; reason: string; disabled: boolean; at?: number };
// Rows oldest first; `at` is created_at in seconds (default: list order). An argMax-per-hash query
// reads only each hash's newest row, and with the live-CSAM tie-break a same-second live CSAM row
// wins the tie; without it the later-listed row does. A plain filter reads every row.
let tableRows: TableRow[] | undefined;
function liveCsamHashes(rows: TableRow[], query: string) {
  const live = (row: TableRow) => row.reason === 'CSAM' && !row.disabled;
  const tieBreak = query.includes("tuple(created_at, reason = 'CSAM' AND disabled = false)");
  const newest = new Map<string, { row: TableRow; at: number }>();
  rows.forEach((row, i) => {
    const at = row.at ?? i;
    const held = newest.get(row.hash);
    if (
      !held ||
      at > held.at ||
      (at === held.at && (!tieBreak || Number(live(row)) >= Number(live(held.row))))
    )
      newest.set(row.hash, { row, at });
  });
  const read = query.includes('argMax(') ? [...newest.values()].map(({ row }) => row) : rows;
  return [...new Set(read.filter(live).map((row) => row.hash))].map((hash) => ({ hash }));
}

const { logToAxiom } = await import('~/server/logging/client');
const { addBlockedImage, bulkAddBlockedImages, bulkRemoveBlockedImages } = await import(
  '../image.service'
);

// A real 64-bit pHash: past 2^53, and one whose rounded form is visibly different so a
// revert prints the wrong value beside the right one rather than timing out.
const HASH = BigInt('-4276845791567733103');
const ROUNDED = String(Number(HASH)); // '-4276845791567733000'

describe('blocked-image hashes keep all 64 bits (ClickUp 868kta7p0)', () => {
  beforeEach(() => {
    capturedInserts.length = 0;
    capturedQueries.length = 0;
    queryResult = [];
    csamQueryResult = [];
  });

  it('addBlockedImage writes the exact hash', async () => {
    await addBlockedImage({ hash: HASH, reason: 'TOS' as any });

    expect(capturedInserts).toHaveLength(1);
    expect(String(capturedInserts[0].values[0].hash)).toBe(HASH.toString());
  });

  it('bulkAddBlockedImages writes the exact hash', async () => {
    await bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'TOS' as any }] });

    expect(capturedInserts).toHaveLength(1);
    expect(String(capturedInserts[0].values[0].hash)).toBe(HASH.toString());
  });

  it('bulkRemoveBlockedImages selects the hash as text and re-writes it exactly', async () => {
    // The client sets output_format_json_quote_64bit_integers: 0, so an unquoted Int64
    // comes back already rounded — the disable row must be built from text.
    queryResult = [{ hash: HASH.toString(), reason: 'TOS' }];

    await bulkRemoveBlockedImages([HASH]);

    expect(capturedQueries[0]).toContain('toString(hash)');
    expect(capturedQueries[0]).toContain(HASH.toString());
    expect(capturedInserts).toHaveLength(1);
    expect(capturedInserts[0].values[0]).toMatchObject({ hash: HASH.toString(), disabled: true });
  });

  it('the rounded form these guards exclude really is a different value', () => {
    expect(ROUNDED).not.toBe(HASH.toString());
  });
});

describe('a hash with a CSAM entry keeps it', () => {
  const OTHER = BigInt('1234567890123');
  const csamEntryOn = (hash: bigint) => (csamQueryResult = [{ hash: hash.toString() }]);

  beforeEach(() => {
    capturedInserts.length = 0;
    capturedQueries.length = 0;
    queryResult = [];
    csamQueryResult = [];
    csamLookupFails = false;
    clientAbsent = false;
    tableRows = undefined;
    vi.mocked(logToAxiom).mockClear();
  });

  // Deliberately a SQL-text assertion, ruled: the lookup takes each hash's newest row with argMax
  // and needs no FINAL and no query setting (the app's ClickHouse user may not be allowed one,
  // which would fail every lookup). Keep it unless that ruling changes.
  it('reads the newest row per hash with argMax, with no FINAL or query setting', async () => {
    await bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'TOS' as any }] });

    const lookup = capturedQueries.find((query) => query.includes("= 'CSAM'"));
    expect(lookup).toContain(
      "argMax(tuple(reason, disabled), tuple(created_at, reason = 'CSAM' AND disabled = false))"
    );
    expect(lookup).not.toMatch(/\bFINAL\b|\bSETTINGS\b/);
  });

  it('a hash whose newest row is a live CSAM entry keeps it (control)', async () => {
    tableRows = [
      { hash: HASH.toString(), reason: 'TOS', disabled: false },
      { hash: HASH.toString(), reason: 'CSAM', disabled: false },
    ];

    await bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'TOS' as any }] });

    expect(capturedInserts).toEqual([]);
  });

  it('a same-second tie between a live CSAM row and a disabled row keeps the CSAM entry', async () => {
    tableRows = [
      { hash: HASH.toString(), reason: 'CSAM', disabled: false, at: 100 },
      { hash: HASH.toString(), reason: 'CSAM', disabled: true, at: 100 },
    ];

    await bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'TOS' as any }] });

    expect(capturedInserts).toEqual([]);
  });

  it('a CSAM row a newer row disabled is not live, so a TOS block lands', async () => {
    tableRows = [
      { hash: HASH.toString(), reason: 'CSAM', disabled: false },
      { hash: HASH.toString(), reason: 'CSAM', disabled: true },
    ];

    await bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'TOS' as any }] });

    expect(capturedInserts.map(({ values }) => values)).toEqual([
      [{ hash: HASH.toString(), reason: 'TOS' }],
    ]);
  });

  it('an unblock disables none of its rows and still disables an unrelated hash', async () => {
    csamEntryOn(HASH);
    queryResult = [
      { hash: HASH.toString(), reason: 'TOS' },
      { hash: OTHER.toString(), reason: 'TOS' },
    ];

    await bulkRemoveBlockedImages([HASH, OTHER]);

    expect(capturedInserts).toHaveLength(1);
    expect(capturedInserts[0].values).toEqual([
      { hash: OTHER.toString(), reason: 'TOS', disabled: true },
    ]);
  });

  it('a TOS block is not written over it, while one on another hash lands', async () => {
    csamEntryOn(HASH);

    await bulkAddBlockedImages({
      data: [
        { hash: HASH, reason: 'TOS' as any },
        { hash: OTHER, reason: 'TOS' as any },
      ],
    });

    expect(capturedInserts).toHaveLength(1);
    expect(capturedInserts[0].values).toEqual([{ hash: OTHER.toString(), reason: 'TOS' }]);
  });

  it('addBlockedImage does not write a TOS row over it', async () => {
    csamEntryOn(HASH);

    await addBlockedImage({ hash: HASH, reason: 'TOS' as any });

    expect(capturedInserts).toHaveLength(0);
  });

  it('a CSAM block still lands on it', async () => {
    csamEntryOn(HASH);

    await bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'CSAM' as any }] });

    expect(capturedInserts[0]?.values).toEqual([{ hash: HASH.toString(), reason: 'CSAM' }]);
  });

  it('a failed lookup refuses the unblock: nothing is disabled and the refusal is logged', async () => {
    csamLookupFails = true;
    queryResult = [{ hash: OTHER.toString(), reason: 'TOS' }];

    await expect(
      bulkRemoveBlockedImages([OTHER], { step: 'unblock', imageIds: [9], actorUserId: 2 })
    ).resolves.toBeUndefined();
    expect(capturedInserts).toHaveLength(0);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'blocklist-disable-refused',
        payload: expect.objectContaining({
          step: 'unblock',
          imageIds: [9],
          actorUserId: 2,
          hashes: [OTHER.toString()],
        }),
      })
    );
  });

  it('a failed lookup leaves the TOS block unwritten and logged, after the CSAM row lands', async () => {
    csamLookupFails = true;

    await expect(
      bulkAddBlockedImages({
        data: [
          { hash: HASH, reason: 'CSAM' as any },
          { hash: OTHER, reason: 'TOS' as any },
        ],
        context: { step: 'block', imageIds: [9], actorUserId: 2 },
      })
    ).resolves.toBeUndefined();
    expect(capturedInserts.map((i) => i.values)).toEqual([
      [{ hash: HASH.toString(), reason: 'CSAM' }],
    ]);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'blocklist-insert-skipped',
        payload: expect.objectContaining({
          step: 'block',
          imageIds: [9],
          actorUserId: 2,
          hashes: [OTHER.toString()],
          reasons: ['TOS'],
        }),
      })
    );
  });

  it('a CSAM block throws without a client instead of passing as a no-op', async () => {
    clientAbsent = true;

    await expect(
      bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'CSAM' as any }] })
    ).rejects.toThrow('no ClickHouse client');
  });

  it('a TOS row in the same batch as a CSAM row for its hash is not written', async () => {
    await bulkAddBlockedImages({
      data: [
        { hash: HASH, reason: 'CSAM' as any },
        { hash: HASH, reason: 'TOS' as any },
      ],
    });

    expect(capturedInserts.map((i) => i.values)).toEqual([
      [{ hash: HASH.toString(), reason: 'CSAM' }],
    ]);
  });

  it('a filed CSAM block lands over a live TOS entry, without waiting on the check', async () => {
    queryResult = [{ hash: HASH.toString(), reason: 'TOS' }];
    csamLookupFails = true;

    await bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'CSAM' as any }] });

    expect(capturedInserts.map((i) => i.values)).toEqual([
      [{ hash: HASH.toString(), reason: 'CSAM' }],
    ]);
    expect(capturedQueries).toEqual([]);
  });
});

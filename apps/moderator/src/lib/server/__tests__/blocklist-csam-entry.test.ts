import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * blocked_images keeps the newest row per hash when it merges, so any later row over a hash with a
 * CSAM entry replaces that entry. Neither a block of another reason nor an unblock may write one.
 */

const ch = vi.hoisted(() => ({
  inserts: [] as { table: string; values: unknown[] }[],
  queries: [] as string[],
  liveRows: [] as { hash: string; reason: string }[],
  csamHashes: [] as string[],
  lookupFails: false,
  /** The live-row read (not the CSAM-entry lookup) fails, quoting its query. */
  liveQueryFails: false,
  /** Every insert fails, quoting its rows. */
  insertFails: false,
  // Rows oldest first; `at` is created_at in seconds (default: list order). An argMax-per-hash
  // query reads only each hash's newest row, and with the live-CSAM tie-break a same-second live
  // CSAM row wins the tie; without it the later-listed row does. A plain filter reads every row.
  tableRows: undefined as
    | { hash: string; reason: string; disabled: boolean; at?: number }[]
    | undefined,
}));

// A CSAM entry is also copied to Postgres (blocklist-held-media-source.pglite.test.ts covers it);
// here that write goes nowhere.
vi.mock('$lib/server/db', async () => {
  const { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
    await import('kysely');
  const db = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (i) => new PostgresIntrospector(i),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { dbRead: db, dbWrite: db };
});
vi.mock('$lib/server/notifications', () => ({ getNotifications: () => ({}) }));
const logToAxiom = vi.hoisted(() => vi.fn());
vi.mock('../axiom', () => ({ logToAxiom, logAxiomError: vi.fn() }));
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    query: async ({ query }: { query: string }) => {
      ch.queries.push(query);
      if (!query.includes("= 'CSAM'")) {
        if (ch.liveQueryFails) throw new Error(`Code: 62. Syntax error in: ${query}`);
        return { json: async () => ch.liveRows };
      }
      if (ch.lookupFails) throw new Error('Socket hang up');
      if (ch.tableRows) {
        type Row = NonNullable<typeof ch.tableRows>[number];
        const live = (row: Row) => row.reason === 'CSAM' && !row.disabled;
        const tieBreak = query.includes("tuple(created_at, reason = 'CSAM' AND disabled = false)");
        const newest = new Map<string, { row: Row; at: number }>();
        ch.tableRows.forEach((row, i) => {
          const at = row.at ?? i;
          const held = newest.get(row.hash);
          if (
            !held ||
            at > held.at ||
            (at === held.at && (!tieBreak || Number(live(row)) >= Number(live(held.row))))
          )
            newest.set(row.hash, { row, at });
        });
        const rows = query.includes('argMax(')
          ? [...newest.values()].map(({ row }) => row)
          : ch.tableRows;
        return {
          json: async () =>
            [...new Set(rows.filter(live).map((row) => row.hash))].map((hash) => ({ hash })),
        };
      }
      return { json: async () => ch.csamHashes.map((hash) => ({ hash })) };
    },
    insert: async ({ table, values }: { table: string; values: unknown[] }) => {
      if (ch.insertFails) throw new Error(`Cannot parse input: ${JSON.stringify(values)}`);
      ch.inserts.push({ table, values });
    },
  }),
}));

const { addImagesToBlocklist, removeImagesFromBlocklist } = await import(
  '../image-moderation-effects'
);

const CSAM_HASH = '-4276845791567733103';
const OTHER = '1234567890123';
const tosImage = (pHash: string) => ({ pHash, needsReview: null, blockedFor: 'moderated' });

beforeEach(() => {
  ch.inserts = [];
  ch.queries = [];
  ch.liveRows = [];
  ch.csamHashes = [CSAM_HASH];
  ch.lookupFails = false;
  ch.liveQueryFails = false;
  ch.insertFails = false;
  ch.tableRows = undefined;
  logToAxiom.mockClear();
});

// Deliberately a SQL-text assertion: the lookup takes each hash's newest row with argMax and
// needs no FINAL and no query setting (the app's ClickHouse user may not be allowed one, which
// would fail every lookup).
it('reads the newest row per hash with argMax, with no FINAL or query setting', async () => {
  await addImagesToBlocklist([tosImage(CSAM_HASH)]);

  const lookup = ch.queries.find((query) => query.includes("= 'CSAM'"));
  expect(lookup).toContain(
    "argMax(tuple(reason, disabled), tuple(created_at, reason = 'CSAM' AND disabled = false))"
  );
  expect(lookup).not.toMatch(/\bFINAL\b|\bSETTINGS\b/);
});

it('a hash whose newest row is a live CSAM entry keeps it (control)', async () => {
  ch.tableRows = [
    { hash: CSAM_HASH, reason: 'TOS', disabled: false },
    { hash: CSAM_HASH, reason: 'CSAM', disabled: false },
  ];

  await addImagesToBlocklist([tosImage(CSAM_HASH)]);

  expect(ch.inserts).toEqual([]);
});

it('a same-second tie between a live CSAM row and a disabled row keeps the CSAM entry', async () => {
  ch.tableRows = [
    { hash: CSAM_HASH, reason: 'CSAM', disabled: false, at: 100 },
    { hash: CSAM_HASH, reason: 'CSAM', disabled: true, at: 100 },
  ];

  await addImagesToBlocklist([tosImage(CSAM_HASH)]);

  expect(ch.inserts).toEqual([]);
});

it('a CSAM row a newer row disabled is not live, so another block lands', async () => {
  ch.tableRows = [
    { hash: CSAM_HASH, reason: 'CSAM', disabled: false },
    { hash: CSAM_HASH, reason: 'CSAM', disabled: true },
  ];

  await addImagesToBlocklist([tosImage(CSAM_HASH)]);

  expect(ch.inserts.map(({ values }) => values)).toEqual([
    [{ hash: CSAM_HASH, reason: expect.any(String) }],
  ]);
});

describe('a hash with a CSAM entry keeps it', () => {
  it('an unblock disables none of its rows and still disables an unrelated hash', async () => {
    ch.liveRows = [
      { hash: CSAM_HASH, reason: 'TOS' },
      { hash: OTHER, reason: 'TOS' },
    ];

    await removeImagesFromBlocklist([CSAM_HASH, OTHER]);

    expect(ch.inserts).toEqual([
      { table: 'blocked_images', values: [{ hash: OTHER, reason: 'TOS', disabled: true }] },
    ]);
  });

  it('a block of another reason is not written over it, while one on another hash lands', async () => {
    await addImagesToBlocklist([tosImage(CSAM_HASH), tosImage(OTHER)]);

    expect(ch.inserts).toHaveLength(1);
    expect(ch.inserts[0].values).toEqual([{ hash: OTHER, reason: expect.any(String) }]);
  });

  it('a CSAM block still lands on it', async () => {
    await addImagesToBlocklist([{ ...tosImage(CSAM_HASH), csam: true }]);

    expect(ch.inserts[0]?.values).toEqual([{ hash: CSAM_HASH, reason: 'CSAM' }]);
  });

  it('a failed lookup refuses the unblock: nothing is disabled and the refusal is logged', async () => {
    ch.lookupFails = true;
    ch.liveRows = [{ hash: OTHER, reason: 'TOS' }];

    await expect(
      removeImagesFromBlocklist([OTHER], { step: 'unblock', imageId: 9, actorUserId: 2 })
    ).resolves.toBeUndefined();
    expect(ch.inserts).toEqual([]);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'blocklist-disable-refused',
        payload: expect.objectContaining({
          step: 'unblock',
          imageId: 9,
          actorUserId: 2,
          hashCount: 1,
        }),
      })
    );
  });

  it('a failed live-row read refuses the unblock and logs no hash', async () => {
    ch.liveQueryFails = true;

    await removeImagesFromBlocklist([OTHER], { step: 'unblock', imageId: 9, actorUserId: 2 });

    expect(ch.inserts).toEqual([]);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'blocklist-disable-refused' })
    );
    expect(JSON.stringify(logToAxiom.mock.calls)).not.toContain(OTHER);
  });

  it('a failed disable write throws no hash', async () => {
    ch.liveRows = [{ hash: OTHER, reason: 'TOS' }];
    ch.insertFails = true;

    const thrown = await removeImagesFromBlocklist([OTHER]).then(
      () => expect.unreachable('the disable reported success'),
      (e: unknown) => e as Error
    );

    expect(JSON.stringify([thrown.message, thrown.cause])).not.toContain(OTHER);
  });

  it('a failed lookup leaves the other block unwritten and logged, after the CSAM row lands', async () => {
    ch.lookupFails = true;

    await expect(
      addImagesToBlocklist([{ ...tosImage(CSAM_HASH), csam: true }, tosImage(OTHER)], {
        step: 'block',
        imageId: 9,
        actorUserId: 2,
      })
    ).resolves.toBeUndefined();
    expect(ch.inserts.map((i) => i.values)).toEqual([[{ hash: CSAM_HASH, reason: 'CSAM' }]]);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'blocklist-insert-skipped',
        payload: expect.objectContaining({
          step: 'block',
          imageId: 9,
          actorUserId: 2,
          hashCount: 1,
        }),
      })
    );
  });

  it('a row in the same batch as a CSAM row for its hash is not written', async () => {
    ch.csamHashes = [];

    await addImagesToBlocklist([{ ...tosImage(OTHER), csam: true }, tosImage(OTHER)]);

    expect(ch.inserts.map((i) => i.values)).toEqual([[{ hash: OTHER, reason: 'CSAM' }]]);
  });
});

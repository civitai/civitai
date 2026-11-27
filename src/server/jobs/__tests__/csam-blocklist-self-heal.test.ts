import { PGlite } from '@electric-sql/pglite';
import { loggableQuery } from '@civitai/db';
import { NEWEST_BLOCKLIST_ROW_SQL } from '@civitai/shared/held-media';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Flipt from '~/server/flipt/client';
import type { HealCounts, HealDeps } from '~/server/jobs/csam-blocklist-self-heal';

/**
 * The CSAM blocklist self-heal: which hashes it repairs, which it must never touch, and the SQL
 * that picks them, run against real Postgres. Ids and hashes are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const boundary = vi.hoisted(() => ({
  flagOn: false,
  chQueries: [] as string[],
  chRows: [] as { hash: string; reason: string; disabled: unknown }[],
  inserts: [] as { values: unknown[]; clickhouse_settings?: unknown }[],
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: async () => boundary.flagOn,
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: async (query: string) => {
      boundary.chQueries.push(query);
      return boundary.chRows;
    },
    insert: async (args: { values: unknown[]; clickhouse_settings?: unknown }) =>
      void boundary.inserts.push(args),
  },
}));

const {
  healCsamBlocklist,
  runCsamBlocklistSelfHeal,
  COPY_ERA_START,
  HEAL_CAP,
  PG_CSAM_AMONG_SQL,
  REPORTED_CANDIDATES_SQL,
  STILL_BLOCKED_SQL,
  SWEEP_COUNT_SQL,
} = await import('~/server/jobs/csam-blocklist-self-heal');

type Newest = { reason: string; disabled: boolean };

/**
 * One blocklist and Postgres copy, held in memory; every image listed and still removed.
 * `blocklist` holds what NEWEST_ROWS_SQL returns: only hashes that have ever had a CSAM row.
 */
const RECENT = new Date('2026-11-20T00:00:00Z');
const PRE_COPY = new Date('2026-11-01T00:00:00Z');

function world(
  rows: { id: number; pHash: string; reportedAt?: Date }[],
  blocklist: Record<string, Newest> = {}
) {
  const pg = new Set<string>();
  const still = new Set(rows.map((r) => r.id));
  const added: string[][] = [];
  const copied: string[][] = [];
  const logged: HealCounts[] = [];
  const deps: HealDeps = {
    readCandidates: async () => rows.map((row) => ({ reportedAt: RECENT, ...row })),
    readSweepCount: async () => 0,
    readNewest: async (hashes) =>
      hashes.filter((h) => blocklist[h]).map((hash) => ({ hash, ...blocklist[hash] })),
    readPgCsam: async (hashes) => hashes.filter((h) => pg.has(h)),
    rereadPrimary: async (ids) => rows.filter((r) => ids.includes(r.id) && still.has(r.id)),
    addEntries: async (hashes) => void added.push(hashes),
    copyToPg: async (hashes) => void copied.push(hashes),
    log: (counts) => void logged.push(counts),
  };
  return { deps, pg, still, added, copied, logged };
}

describe('healCsamBlocklist', () => {
  const rows = [
    { id: 1, pHash: '11' }, // no blocklist row at all
    { id: 2, pHash: '22' }, // live CSAM entry with its Postgres copy
    { id: 3, pHash: '33' }, // live CSAM entry, no Postgres copy
    { id: 4, pHash: '44' }, // newest row disabled: an unblocklist
    { id: 5, pHash: '55' }, // newest row a live TOS entry
  ];
  const blocklist = {
    '22': { reason: 'CSAM', disabled: false },
    '33': { reason: 'CSAM', disabled: false },
    '44': { reason: 'CSAM', disabled: true },
    '55': { reason: 'TOS', disabled: false },
  };

  it('adds the missing entry, copies the uncopied one, and counts the rest', async () => {
    const w = world(rows, blocklist);
    w.pg.add('22');

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([['11']]);
    expect(w.copied).toEqual([['33']]);
    expect(counts).toEqual({
      writes: true,
      candidates: 5,
      notCsamEver: 1,
      notCsamEverPreCopy: 0,
      csamMergedAway: 0,
      pgGap: 1,
      disabled: 1,
      otherReason: 1,
      sweep: 0,
      healed: 2,
      capped: false,
    });
    expect(w.logged).toEqual([counts]);
  });

  // Decision: a disabled newest row is an unblocklist. Re-adding it would undo a moderator's call.
  it('never re-adds a hash whose newest row is disabled', async () => {
    const w = world([{ id: 4, pHash: '44' }], blocklist);

    await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([]);
    expect(w.copied).toEqual([]);
  });

  // Decision: a newer row of another reason is counted, never written over.
  it('never writes over a newer row of another reason on a hash that had a CSAM entry', async () => {
    const w = world([{ id: 5, pHash: '55' }], blocklist);

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([]);
    expect(counts.otherReason).toBe(1);
  });

  it('writes nothing with the flag off, and still logs its counts', async () => {
    const w = world(rows, blocklist);

    const counts = await healCsamBlocklist({ writes: false }, w.deps);

    expect([w.added, w.copied]).toEqual([[], []]);
    expect(w.logged).toEqual([
      expect.objectContaining({ writes: false, notCsamEver: 1, healed: 0 }),
    ]);
    expect(counts.pgGap).toBe(2);
  });

  it('writes nothing for an image unblocked between the read and the write', async () => {
    const w = world([{ id: 1, pHash: '11' }]);
    w.still.delete(1);

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([]);
    expect(counts.healed).toBe(0);
  });

  // Decision: a hash absent from the read that has a Postgres copy once had a CSAM entry, lost to a
  // merge under a newer row. That newer row may be an unblocklist, so it is never written.
  it('never writes a hash whose CSAM entry a merge replaced', async () => {
    const w = world([{ id: 1, pHash: '11' }]);
    w.pg.add('11');

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([]);
    expect(counts).toMatchObject({ csamMergedAway: 1, notCsamEver: 0, healed: 0 });
  });

  // Ruling: before the Postgres copies existed, a never-listed hash may be an unblocklist a merge
  // hid, so only images first reported after COPY_ERA_START are healed from that class.
  it('never heals a never-listed hash first reported before the copy era', async () => {
    const w = world([
      { id: 2, pHash: '11', reportedAt: RECENT },
      { id: 1, pHash: '11', reportedAt: PRE_COPY },
    ]);

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([]);
    expect(counts).toMatchObject({ notCsamEver: 0, notCsamEverPreCopy: 1, healed: 0 });
  });

  it('heals a never-listed hash first reported exactly at the start of the copy era', async () => {
    const w = world([{ id: 1, pHash: '11', reportedAt: COPY_ERA_START }]);

    expect(await healCsamBlocklist({ writes: true }, w.deps)).toMatchObject({ healed: 1 });
  });

  // Decision: copies are only guaranteed once both apps fully served the copy writer (#9502): the
  // moderator app by 2026-11-18T22:01Z, the main app by 2026-11-19T00:00Z. Moving this earlier lets
  // the job overwrite an unblocklist it cannot see.
  it('starts the copy era no earlier than both copy-writing releases were fully serving', () => {
    expect(COPY_ERA_START.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-11-19T00:00:00Z'));
  });

  it('never heals one first reported a moment before the copy era', async () => {
    const before = new Date(COPY_ERA_START.getTime() - 1000);
    const w = world([{ id: 1, pHash: '11', reportedAt: before }]);

    expect(await healCsamBlocklist({ writes: true }, w.deps)).toMatchObject({
      healed: 0,
      notCsamEverPreCopy: 1,
    });
  });

  it('does not write an entry for a hash whose CSAM row landed after the classification', async () => {
    const w = world([{ id: 1, pHash: '11' }]);
    const classify = w.deps.readNewest;
    let reads = 0;
    w.deps.readNewest = async (hashes) =>
      ++reads === 1
        ? classify(hashes)
        : hashes.map((hash) => ({ hash, reason: 'CSAM', disabled: true }));

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([]);
    expect(counts.healed).toBe(0);
  });

  it('does not copy an entry disabled after the classification', async () => {
    const w = world([{ id: 3, pHash: '33' }], { '33': { reason: 'CSAM', disabled: false } });
    const classify = w.deps.readNewest;
    let reads = 0;
    w.deps.readNewest = async (hashes) =>
      ++reads === 1
        ? classify(hashes)
        : hashes.map((hash) => ({ hash, reason: 'CSAM', disabled: true }));

    await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.copied).toEqual([]);
  });

  it('heals at most HEAL_CAP hashes a run and says it was capped', async () => {
    const many = Array.from({ length: HEAL_CAP + 1 }, (_, i) => ({ id: i + 1, pHash: `${i + 1}` }));
    const w = world(many);

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added.flat()).toHaveLength(HEAL_CAP);
    expect(counts).toMatchObject({ healed: HEAL_CAP, capped: true });
  });
});

describe('the candidate SQL, on real Postgres', () => {
  let pg: PGlite;
  const query = async <T>(sql: string, params: unknown[] = []) =>
    (await pg.query<T>(sql, params)).rows;
  const candidates = () =>
    query<{ id: number; pHash: string; reportedAt: Date }>(REPORTED_CANDIDATES_SQL);

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, ingestion text, "blockedFor" text, "pHash" bigint);
      CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb, "createdAt" timestamp(3));
      CREATE TABLE "BlockedImage" (hash bigint PRIMARY KEY, reason text);
    `);
  });

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE "Image", "CsamReport", "BlockedImage";
      INSERT INTO "Image" VALUES
        (1, 7, 'Blocked', 'CSAM', -4276845791567733103), -- listed, removed for CSAM
        (2, 7, 'Blocked', 'CSAM', 202),                  -- the account's other image: sweep
        (3, 7, 'Scanned', NULL, 203),                    -- listed, block overturned
        (4, 7, 'Blocked', 'moderated', 204),             -- listed, re-labelled
        (5, 7, 'Blocked', 'CSAM', 205),                  -- listed as an object
        (6, 7, 'Blocked', 'CSAM', NULL);                 -- listed, no hash yet
      INSERT INTO "CsamReport" ("userId", images, "createdAt") VALUES
        (7, '[1, 3, 4, 6, "abc", 9999999999999999999]', '2026-11-20'),
        (7, '[{"id": 5}]', '2026-11-20'),
        (7, '[5]', '2026-11-01');
    `);
  });

  it('reads only listed images still removed for CSAM, at full precision', async () => {
    expect((await candidates()).sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, pHash: '-4276845791567733103', reportedAt: new Date('2026-11-20T00:00:00Z') },
      // Its earliest report, not its latest.
      { id: 5, pHash: '205', reportedAt: new Date('2026-11-01T00:00:00Z') },
    ]);
    expect(await query(SWEEP_COUNT_SQL)).toEqual([{ sweep: 1 }]);
  });

  it('selection case 1', async () => {
    await pg.exec(`
      INSERT INTO "Image" VALUES (10, 7, 'Error', 'CSAM', 210);
      INSERT INTO "CsamReport" ("userId", images, "createdAt") VALUES (7, '[10]', '2026-11-20');
    `);
    expect((await candidates()).map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 5, 10]);
    expect(await query(STILL_BLOCKED_SQL, [[10]])).toEqual([{ id: 10, pHash: '210' }]);
  });

  it('reads a CSAM block anywhere in a comma list of block reasons', async () => {
    await pg.exec(`
      INSERT INTO "Image" VALUES (11, 7, 'Blocked', 'TOS,csam', 211), (12, 7, 'Blocked', 'TOS,Moderated', 212);
      INSERT INTO "CsamReport" ("userId", images, "createdAt") VALUES (7, '[11, 12]', '2026-11-20');
    `);
    expect((await candidates()).map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 5, 11]);
    expect(await query(STILL_BLOCKED_SQL, [[11, 12]])).toEqual([{ id: 11, pHash: '211' }]);
  });

  it('re-reads on the write only the ids still removed for CSAM', async () => {
    expect(await query(STILL_BLOCKED_SQL, [[1, 3, 4, 6]])).toEqual([
      { id: 1, pHash: '-4276845791567733103' },
    ]);
  });

  it('finds the Postgres copies among the given hashes', async () => {
    await pg.exec(`INSERT INTO "BlockedImage" VALUES (205, 'CSAM'), (206, 'TOS')`);

    expect(await query(PG_CSAM_AMONG_SQL, [['205', '206', '1']])).toEqual([{ hash: '205' }]);
  });

  // The block whose image had no hash yet logged csam-blocklist-no-hash and wrote no entry. Once the
  // hash is on the row, the next run must pick it up.
  it('heals a listed CSAM removal whose hash appeared after its block', async () => {
    await pg.exec(`UPDATE "Image" SET "pHash" = NULL WHERE id = 1`);
    const added: string[][] = [];
    const deps: HealDeps = {
      readCandidates: () => candidates(),
      readSweepCount: async () => 0,
      readNewest: async () => [],
      readPgCsam: async () => [],
      rereadPrimary: (ids) => query(STILL_BLOCKED_SQL, [ids]),
      addEntries: async (hashes) => void added.push(hashes),
      copyToPg: async () => undefined,
      log: () => undefined,
    };
    await healCsamBlocklist({ writes: true }, deps);
    expect(added.flat()).not.toContain('101');

    await pg.exec(`UPDATE "Image" SET "pHash" = 101 WHERE id = 1`);
    await healCsamBlocklist({ writes: true }, deps);

    expect(added.at(-1)).toContain('101');
  });
});

describe('the job as scheduled, against its boundaries', () => {
  const HASH = '-4276845791567733103';
  beforeEach(() => {
    boundary.flagOn = false;
    boundary.chQueries = [];
    boundary.chRows = [];
    boundary.inserts = [];
    dbMock.dbRead.$queryRawUnsafe.mockImplementation((async (sql: string) =>
      sql === REPORTED_CANDIDATES_SQL
        ? [{ id: 1, pHash: HASH, reportedAt: RECENT }]
        : sql === SWEEP_COUNT_SQL
        ? [{ sweep: 3 }]
        : []) as never);
    dbMock.dbWrite.$queryRawUnsafe.mockReset();
    dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([{ id: 1, pHash: HASH }] as never);
    dbMock.dbWrite.$executeRawUnsafe.mockReset();
    dbMock.dbWrite.$executeRawUnsafe.mockResolvedValue(1 as never);
  });

  it('with the flag off, reads and counts but neither re-reads nor writes', async () => {
    const counts = await runCsamBlocklistSelfHeal();

    expect(counts).toMatchObject({
      writes: false,
      candidates: 1,
      notCsamEver: 1,
      sweep: 3,
      healed: 0,
    });
    expect(dbMock.dbWrite.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(boundary.inserts).toEqual([]);
  });

  it('with the flag on, re-reads on the primary and writes the entry synchronously', async () => {
    boundary.flagOn = true;

    const counts = await runCsamBlocklistSelfHeal();

    expect(dbMock.dbWrite.$queryRawUnsafe).toHaveBeenCalledWith(STILL_BLOCKED_SQL, [1]);
    expect(boundary.inserts).toEqual([
      {
        table: 'blocked_images',
        values: [{ hash: HASH, reason: 'CSAM' }],
        format: 'JSONEachRow',
        clickhouse_settings: { async_insert: 0 },
      },
    ]);
    expect(counts.healed).toBe(1);
  });

  it("classifies with the readers' tie-break and reads a 0/1 disabled column", async () => {
    boundary.chRows = [{ hash: HASH, reason: 'CSAM', disabled: 1 }];
    expect(await runCsamBlocklistSelfHeal()).toMatchObject({ disabled: 1, notCsamEver: 0 });

    boundary.chRows = [{ hash: HASH, reason: 'CSAM', disabled: 0 }];
    expect(await runCsamBlocklistSelfHeal()).toMatchObject({ disabled: 0, notCsamEver: 0 });

    expect(boundary.chQueries[0]).toContain(NEWEST_BLOCKLIST_ROW_SQL);
    expect(boundary.chQueries[0]).not.toContain(HASH);
  });

  it('with the flag on, writes only the Postgres copy of a live entry that lacks one', async () => {
    boundary.flagOn = true;
    boundary.chRows = [{ hash: HASH, reason: 'CSAM', disabled: false }];

    const counts = await runCsamBlocklistSelfHeal();

    expect(counts).toMatchObject({ pgGap: 1, healed: 1 });
    expect(boundary.inserts).toEqual([]);
    expect(dbMock.dbWrite.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`INSERT INTO "BlockedImage" (hash, reason) VALUES (${HASH}, 'CSAM')`)
    );
  });

  // Ruling A: a reported image's hash with only non-CSAM rows is absent from the restricted read,
  // and gets the CSAM entry its block would have written.
  it('heals a reported hash that has only rows of other reasons', async () => {
    boundary.flagOn = true;
    boundary.chRows = [];

    const counts = await runCsamBlocklistSelfHeal();

    expect(counts).toMatchObject({ notCsamEver: 1, otherReason: 0, healed: 1 });
    expect(boundary.inserts).toHaveLength(1);
  });

  // Decision: no hash value travels to ClickHouse, not even as a bound parameter, so none can land in
  // its query log or a request log. Don't "optimise" this into a WHERE hash IN (...) filter.
  it('sends no hash value to ClickHouse, on the classification or the re-check', async () => {
    boundary.flagOn = true;
    boundary.chRows = [{ hash: '42', reason: 'TOS', disabled: false }];

    const counts = await runCsamBlocklistSelfHeal();

    expect(counts).toMatchObject({ notCsamEver: 1, healed: 1 });
    expect(boundary.chQueries).toHaveLength(2);
    for (const query of boundary.chQueries) {
      expect(query).not.toContain(HASH);
      // Restricted on the server, so only hashes that ever had a CSAM row come back.
      expect(query).toContain(
        "WHERE hash IN (SELECT hash FROM blocked_images WHERE reason = 'CSAM')"
      );
    }
    // The heal insert carries the hash as row data in the body, never in its statement.
    const [insert] = boundary.inserts as { table: string; format: string; values: unknown[] }[];
    expect(insert).toMatchObject({ table: 'blocked_images', format: 'JSONEachRow' });
    expect(insert.values).toEqual([{ hash: HASH, reason: 'CSAM' }]);
    expect(JSON.stringify({ ...insert, values: undefined })).not.toContain(HASH);
  });

  it('keeps the hashes it looks up in Postgres out of the slow-query log', () => {
    expect(
      loggableQuery({ query: PG_CSAM_AMONG_SQL, params: JSON.stringify([[HASH]]) })
    ).not.toContain(HASH);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealCounts, HealDeps } from '~/server/jobs/csam-blocklist-self-heal';

/**
 * The CSAM blocklist self-heal: which hashes it repairs, which it must never touch, and the SQL
 * that picks them, run against real Postgres. Ids and hashes are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const {
  healCsamBlocklist,
  HEAL_CAP,
  PG_CSAM_AMONG_SQL,
  REPORTED_CANDIDATES_SQL,
  STILL_BLOCKED_SQL,
  SWEEP_COUNT_SQL,
} = await import('~/server/jobs/csam-blocklist-self-heal');

type Newest = { reason: string; disabled: boolean };

/** One blocklist and Postgres copy, held in memory; every image listed and still removed. */
function world(rows: { id: number; pHash: string }[], blocklist: Record<string, Newest> = {}) {
  const pg = new Set<string>();
  const still = new Set(rows.map((r) => r.id));
  const added: string[][] = [];
  const copied: string[][] = [];
  const logged: HealCounts[] = [];
  const deps: HealDeps = {
    readCandidates: async () => rows,
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
      missing: 1,
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

  // Decision (pending a policy ruling): a newer TOS row is counted, never written over.
  it('never writes over a newer row of another reason', async () => {
    const w = world([{ id: 5, pHash: '55' }], blocklist);

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([]);
    expect(counts.otherReason).toBe(1);
  });

  it('writes nothing with the flag off, and still logs its counts', async () => {
    const w = world(rows, blocklist);

    const counts = await healCsamBlocklist({ writes: false }, w.deps);

    expect([w.added, w.copied]).toEqual([[], []]);
    expect(w.logged).toEqual([expect.objectContaining({ writes: false, missing: 1, healed: 0 })]);
    expect(counts.pgGap).toBe(2);
  });

  it('writes nothing for an image unblocked between the read and the write', async () => {
    const w = world([{ id: 1, pHash: '11' }]);
    w.still.delete(1);

    const counts = await healCsamBlocklist({ writes: true }, w.deps);

    expect(w.added).toEqual([]);
    expect(counts.healed).toBe(0);
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
  const candidates = () => query<{ id: number; pHash: string }>(REPORTED_CANDIDATES_SQL);

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, ingestion text, "blockedFor" text, "pHash" bigint);
      CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb);
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
        (5, 7, 'Blocked', 'CSAM', 205);                  -- listed as an object
      INSERT INTO "CsamReport" ("userId", images) VALUES
        (7, '[1, 3, 4]'), (7, '[{"id": 5}]');
    `);
  });

  it('reads only listed images still removed for CSAM, at full precision', async () => {
    expect((await candidates()).sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, pHash: '-4276845791567733103' },
      { id: 5, pHash: '205' },
    ]);
    expect(await query(SWEEP_COUNT_SQL)).toEqual([{ sweep: 1 }]);
  });

  it('re-reads on the write only the ids still removed for CSAM', async () => {
    expect(await query(STILL_BLOCKED_SQL, [[1, 3, 4]])).toEqual([
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
    await pg.exec(`UPDATE "Image" SET "pHash" = NULL WHERE id = 5`);
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
    expect(added.flat()).not.toContain('205');

    await pg.exec(`UPDATE "Image" SET "pHash" = 205 WHERE id = 5`);
    await healCsamBlocklist({ writes: true }, deps);

    expect(added.at(-1)).toContain('205');
  });
});

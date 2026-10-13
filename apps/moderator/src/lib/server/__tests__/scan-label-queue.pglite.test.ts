import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { LEASE_MS } from '$lib/scan-labels';

/**
 * The scan label queue against the real migration, applied to an in-process Postgres.
 *
 * PGlite is one connection, so claims here run one after another: these tests pin the slot
 * arithmetic (votes + other moderators' live leases), not the row lock that keeps two truly
 * simultaneous claimers apart.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { claimNext, castVote, getCounters, getOpenFlaggerVersions } = await import(
  '../scan-label.service'
);

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(
    HERE,
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261022130000_scan_label_queue/migration.sql'
  ),
  'utf8'
);

const NOW = new Date('2026-10-13T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

let pg: PGlite;

beforeEach(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL DEFAULT 'u', "type" TEXT NOT NULL DEFAULT 'image',
      "name" TEXT, "width" INTEGER, "height" INTEGER
    );
  `);
  await pg.exec(MIGRATION);
  dbHandle.current = new Kysely<DB>({ dialect: pgliteDialect(pg) });
});

async function seedItem(
  imageId: number,
  {
    votes = 0,
    blockVotes = 0,
    flaggedAt = '2026-10-13T08:00:00Z',
    version = 'scan@1',
  }: { votes?: number; blockVotes?: number; flaggedAt?: string; version?: string } = {}
): Promise<number> {
  await pg.query(`INSERT INTO "Image" ("id", "url") VALUES ($1, $2)`, [imageId, `key-${imageId}`]);
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "ScanLabelItem" ("imageId", "firstFlaggedAt", "votes", "blockVotes")
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [imageId, flaggedAt, votes, blockVotes]
  );
  const itemId = rows[0].id;
  await pg.query(
    `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt")
     VALUES ($1, 'orchestrator-scan', $2, $3, $4)`,
    [itemId, version, `wf-${imageId}`, flaggedAt]
  );
  // Prior votes come from moderators 900+, so they never collide with the test's own voters.
  for (let i = 0; i < votes; i++)
    await pg.query(
      `INSERT INTO "ScanLabelVote" ("itemId", "userId", "block") VALUES ($1, $2, $3)`,
      [itemId, 900 + i, i < blockVotes]
    );
  return itemId;
}

const item = async (itemId: number) =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "ScanLabelItem" WHERE id = $1`, [itemId]))
    .rows[0];

describe('claimNext order', () => {
  it('serves partly-voted items first, then the newest flag', async () => {
    const fresh = await seedItem(1, { flaggedAt: '2026-10-13T09:00:00Z' });
    const older = await seedItem(2, { flaggedAt: '2026-10-13T07:00:00Z' });
    const two = await seedItem(3, { votes: 2, blockVotes: 1, flaggedAt: '2026-10-12T00:00:00Z' });
    const one = await seedItem(4, { votes: 1, flaggedAt: '2026-10-12T00:00:00Z' });

    const served: number[] = [];
    for (let userId = 1; userId <= 7; userId++)
      served.push((await claimNext(userId, {}, NOW))!.itemId);

    expect(served).toEqual([two, one, one, fresh, fresh, fresh, older]);
  });

  it('gives a moderator their live lease back instead of taking a second one', async () => {
    const a = await seedItem(1);
    const b = await seedItem(2);
    expect((await claimNext(1, {}, NOW))!.itemId).toBe(a);
    // b is now partly voted, so a fresh claim would rank it first.
    await castVote({ itemId: b, userId: 2, block: false, msOnItem: 1 }, NOW);
    expect((await claimNext(1, {}, later(1000)))!.itemId).toBe(a);
    const { rows } = await pg.query(`SELECT * FROM "ScanLabelClaim" WHERE "userId" = 1`);
    expect(rows).toHaveLength(1);
  });

  it('releases a held lease that the new filter excludes', async () => {
    const d12 = await seedItem(1, { flaggedAt: '2026-10-12T10:00:00Z' });
    const d13 = await seedItem(2, { flaggedAt: '2026-10-13T10:00:00Z' });
    expect((await claimNext(1, {}, NOW))!.itemId).toBe(d13);
    expect((await claimNext(1, { day: '2026-10-12' }, later(1000)))!.itemId).toBe(d12);
    const { rows } = await pg.query<{ itemId: number }>(
      `SELECT "itemId" FROM "ScanLabelClaim" WHERE "userId" = 1`
    );
    expect(rows).toEqual([{ itemId: d12 }]);
  });

  it('never serves an item the moderator already voted on', async () => {
    const a = await seedItem(1, { votes: 1 });
    const b = await seedItem(2);
    expect((await claimNext(900, {}, NOW))!.itemId).toBe(b);
    expect(a).not.toBe(b);
  });

  it('filters by flagged day and by flagger version', async () => {
    const d12 = await seedItem(1, { flaggedAt: '2026-10-12T23:59:00Z', version: 'scan@1' });
    const d13 = await seedItem(2, { flaggedAt: '2026-10-13T00:00:00Z', version: 'scan@2' });
    expect((await claimNext(1, { day: '2026-10-12' }, NOW))!.itemId).toBe(d12);
    expect((await claimNext(2, { flaggerVersion: 'scan@2' }, NOW))!.itemId).toBe(d13);
    expect(await claimNext(3, { day: '2026-10-12', flaggerVersion: 'scan@2' }, NOW)).toBeNull();
    expect(await getOpenFlaggerVersions()).toEqual(['scan@2', 'scan@1']);
  });
});

describe('vote slots', () => {
  it('two claimers never share the last slot', async () => {
    const last = await seedItem(1, { votes: 2, blockVotes: 1 });
    expect((await claimNext(1, {}, NOW))!.itemId).toBe(last);
    expect(await claimNext(2, {}, later(1000))).toBeNull();
  });

  it('frees the slot once the lease expires', async () => {
    const last = await seedItem(1, { votes: 2 });
    await claimNext(1, {}, NOW);
    expect((await claimNext(2, {}, later(LEASE_MS + 1)))!.itemId).toBe(last);
  });

  it('refuses a vote on an expired lease when the others hold every slot', async () => {
    const it1 = await seedItem(1, { votes: 1 });
    await claimNext(1, {}, NOW);
    await claimNext(2, {}, later(LEASE_MS + 1));
    await claimNext(3, {}, later(LEASE_MS + 1));
    const r = await castVote(
      { itemId: it1, userId: 1, block: true, msOnItem: 10 },
      later(LEASE_MS + 2)
    );
    expect(r).toEqual({ ok: false, reason: 'full' });
    expect((await item(it1)).votes).toBe(1);
  });

  it('accepts a vote on an expired lease while a slot is still free', async () => {
    const it1 = await seedItem(1);
    await claimNext(1, {}, NOW);
    const r = await castVote(
      { itemId: it1, userId: 1, block: false, msOnItem: 10 },
      later(LEASE_MS + 1)
    );
    expect(r.ok).toBe(true);
  });

  it('counts one vote per moderator per item', async () => {
    const it1 = await seedItem(1);
    await claimNext(1, {}, NOW);
    expect((await castVote({ itemId: it1, userId: 1, block: true, msOnItem: 5 }, NOW)).ok).toBe(
      true
    );
    expect(await castVote({ itemId: it1, userId: 1, block: true, msOnItem: 5 }, later(10))).toEqual(
      {
        ok: false,
        reason: 'already-voted',
      }
    );
    expect(await item(it1)).toMatchObject({ votes: 1, blockVotes: 1, status: 'open' });
  });

  it('refuses a fourth vote', async () => {
    const it1 = await seedItem(1, { votes: 3, blockVotes: 0 });
    await pg.query(`UPDATE "ScanLabelItem" SET status = 'decided' WHERE id = $1`, [it1]);
    expect(await castVote({ itemId: it1, userId: 1, block: true, msOnItem: 1 }, NOW)).toEqual({
      ok: false,
      reason: 'not-open',
    });
  });

  it('releases the voter’s lease', async () => {
    const it1 = await seedItem(1);
    await claimNext(1, {}, NOW);
    await castVote({ itemId: it1, userId: 1, block: false, msOnItem: 1 }, NOW);
    const { rows } = await pg.query(`SELECT * FROM "ScanLabelClaim"`);
    expect(rows).toHaveLength(0);
  });
});

describe('outcome', () => {
  const voteAs = (itemId: number, userId: number, block: boolean) =>
    castVote({ itemId, userId, block, msOnItem: 1 }, NOW);

  it('signals the block majority on the second block vote only, and keeps voting to three', async () => {
    const it1 = await seedItem(1);
    const first = await voteAs(it1, 1, true);
    const second = await voteAs(it1, 2, true);
    const third = await voteAs(it1, 3, true);
    expect([first, second, third].map((r) => r.ok && r.reachedBlockMajority)).toEqual([
      false,
      true,
      false,
    ]);
    expect(await item(it1)).toMatchObject({
      votes: 3,
      blockVotes: 3,
      status: 'decided',
      outcome: 'block',
      unanimous: true,
    });
  });

  it('a split decided by the third vote signals then', async () => {
    const it1 = await seedItem(1);
    await voteAs(it1, 1, true);
    await voteAs(it1, 2, false);
    const third = await voteAs(it1, 3, true);
    expect(third).toMatchObject({ ok: true, reachedBlockMajority: true, decided: true });
    expect(await item(it1)).toMatchObject({ outcome: 'block', unanimous: false });
  });

  it('a clear majority never signals a block', async () => {
    const it1 = await seedItem(1);
    const results = [
      await voteAs(it1, 1, false),
      await voteAs(it1, 2, true),
      await voteAs(it1, 3, false),
    ];
    expect(results.some((r) => r.ok && r.reachedBlockMajority)).toBe(false);
    expect(await item(it1)).toMatchObject({
      outcome: 'clear',
      unanimous: false,
      status: 'decided',
    });
  });
});

describe('counters', () => {
  it('counts my votes today against my quota', async () => {
    const a = await seedItem(1);
    const b = await seedItem(2);
    await castVote(
      { itemId: a, userId: 1, block: false, msOnItem: 1 },
      new Date('2026-10-12T23:00:00Z')
    );
    await castVote({ itemId: b, userId: 1, block: false, msOnItem: 1 }, NOW);
    await pg.query(`INSERT INTO "ScanLabelQuota" ("userId", "dailyVotes") VALUES (1, 80)`);
    expect(await getCounters(1, {}, NOW)).toEqual({
      openInFilter: 2,
      myVotesToday: 1,
      myQuota: 80,
      decidedToday: 0,
    });
    expect((await getCounters(2, {}, NOW)).myQuota).toBe(50);
  });
});

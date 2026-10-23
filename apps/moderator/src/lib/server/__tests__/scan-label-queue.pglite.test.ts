import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
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

const {
  claimNext,
  castVote,
  getCounters,
  getOpenFlaggerVersions,
  getVotedItemOwner,
  isControlFlaggerVersion,
  sourceOrder,
} = await import('../scan-label.service');

const BLOCK = { block: true, reason: 'real-person', reasonComment: null } as const;
const KEEP = { block: false } as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '20261022130000_scan_label_queue',
  '20261022140000_scan_label_outcomes',
  '20261023130000_scan_label_reasons_copy',
].map((name) =>
  readFileSync(
    join(
      HERE,
      `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  )
);

const NOW = new Date('2026-10-13T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(`
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL DEFAULT 'u', "type" TEXT NOT NULL DEFAULT 'image',
      "name" TEXT, "width" INTEGER, "height" INTEGER, "pHash" BIGINT,
      "userId" INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
  `);
  for (const sql of MIGRATIONS) await pg.exec(sql);
  dbHandle.current = new Kysely<DB>({ dialect: pgliteDialect(pg) });
});

async function seedItem(
  imageId: number,
  {
    votes = 0,
    blockVotes = 0,
    flaggedAt = '2026-10-13T08:00:00Z',
    version = 'scan@1',
    sources = ['orchestrator-scan'],
  }: {
    votes?: number;
    blockVotes?: number;
    flaggedAt?: string;
    version?: string;
    sources?: readonly ('orchestrator-scan' | 'xguard-prompt' | 'control-sample')[];
  } = {}
): Promise<number> {
  await pg.query(`INSERT INTO "Image" ("id", "url") VALUES ($1, $2)`, [imageId, `key-${imageId}`]);
  const lane = sources.includes('control-sample') ? 'control' : 'flagged';
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "ScanLabelItem" ("imageId", "lane", "firstFlaggedAt", "votes", "blockVotes")
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [imageId, lane, flaggedAt, votes, blockVotes]
  );
  const itemId = rows[0].id;
  for (const source of sources)
    await pg.query(
      `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [itemId, source, version, `wf-${imageId}-${source}`, flaggedAt]
    );
  // Prior votes come from moderators 900+, so they never collide with the test's own voters.
  for (let i = 0; i < votes; i++)
    await pg.query(
      `INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason")
       VALUES ($1, $2, $3, CASE WHEN $3 THEN 'real-person' END)`,
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
    await castVote({ itemId: b, userId: 2, choice: KEEP, msOnItem: 1 }, NOW);
    expect((await claimNext(1, {}, later(1000)))!.itemId).toBe(a);
    const { rows } = await pg.query(`SELECT * FROM "ScanLabelClaim" WHERE "userId" = 1`);
    expect(rows).toHaveLength(1);
  });

  it('keeps a held card across a filter change, then applies the filter', async () => {
    const d12 = await seedItem(1, { flaggedAt: '2026-10-12T10:00:00Z' });
    await seedItem(2, { flaggedAt: '2026-10-13T10:00:00Z' });
    const d14 = await seedItem(3, { flaggedAt: '2026-10-14T10:00:00Z' });
    expect((await claimNext(1, {}, NOW))!.itemId).toBe(d14);
    expect((await claimNext(1, { day: '2026-10-12' }, later(1000)))!.itemId).toBe(d14);
    const { rows } = await pg.query<{ itemId: number }>(
      `SELECT "itemId" FROM "ScanLabelClaim" WHERE "userId" = 1`
    );
    expect(rows).toEqual([{ itemId: d14 }]);
    await castVote({ itemId: d14, userId: 1, choice: KEEP, msOnItem: 1 }, later(2000));
    // Unfiltered, the next card would be the 13th's.
    expect((await claimNext(1, { day: '2026-10-12' }, later(3000)))!.itemId).toBe(d12);
  });

  it('moves on from a held card that is no longer open', async () => {
    const a = await seedItem(1, { flaggedAt: '2026-10-13T10:00:00Z' });
    const b = await seedItem(2, { flaggedAt: '2026-10-13T09:00:00Z' });
    expect((await claimNext(1, {}, NOW))!.itemId).toBe(a);
    await pg.query(`UPDATE "ScanLabelItem" SET status = 'void' WHERE id = $1`, [a]);
    expect((await claimNext(1, {}, later(1000)))!.itemId).toBe(b);
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

  describe('control samples stay blind', () => {
    const CONTROL_VERSION = 'control-sample@2026-10-17';
    beforeEach(async () => {
      await seedItem(1, { version: 'scan@1' });
      await seedItem(2, { version: CONTROL_VERSION, sources: ['control-sample'] });
    });

    it('never lists the control version as a filter', async () => {
      expect(await getOpenFlaggerVersions()).toEqual(['scan@1']);
    });

    it('serves and counts no control item when the control version is the filter', async () => {
      expect(await claimNext(1, { flaggerVersion: CONTROL_VERSION }, NOW)).toBeNull();
      expect((await getCounters(1, { flaggerVersion: CONTROL_VERSION }, NOW)).openInFilter).toBe(0);
    });

    it('still reaches a control item by its scanner flag', async () => {
      // A control item that a scan later flags too keeps its control lane.
      await pg.query(
        `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt")
         SELECT id, 'orchestrator-scan', 'scan@2', 'wf-2-scan', '2026-10-13T08:00:00Z'
         FROM "ScanLabelItem" WHERE "imageId" = 2`
      );
      expect((await getOpenFlaggerVersions()).sort()).toEqual(['scan@1', 'scan@2']);
      expect((await claimNext(1, { flaggerVersion: 'scan@2' }, NOW))!.imageId).toBe(2);
      // The item is in the control lane, so only the flag's own source says scan@2 is a real version.
      expect(await isControlFlaggerVersion('scan@2')).toBe(false);
      expect(await isControlFlaggerVersion(CONTROL_VERSION)).toBe(true);
    });

    it('keeps a held card across any filter, whatever its lane', async () => {
      // In every filter below, so it is what a released lease would be replaced by.
      const other = await seedItem(3, { version: 'scan@2', flaggedAt: '2026-10-12T08:00:00Z' });
      const lanes = { flagged: () => 0.1, control: () => 0.95 };
      const filters = [
        { flaggerVersion: 'scan@2' },
        { day: '2026-10-12' },
        { day: '2026-10-12', flaggerVersion: 'scan@2' },
      ];
      let userId = 0;
      for (const votes of [0, 1]) {
        await pg.query(`UPDATE "ScanLabelItem" SET votes = $1 WHERE id <> $2`, [votes, other]);
        for (const filter of filters)
          for (const [lane, rng] of Object.entries(lanes)) {
            userId++;
            // Each moderator starts after the previous leases ran out.
            const at = later(userId * 2 * LEASE_MS);
            const held = (await claimNext(userId, {}, at, rng))!.itemId;
            expect((await item(held)).lane).toBe(lane);
            const kept = await claimNext(userId, filter, new Date(at.getTime() + 1000));
            expect(kept!.itemId).toBe(held);
            const { rows } = await pg.query<{ itemId: number }>(
              `SELECT "itemId" FROM "ScanLabelClaim" WHERE "userId" = $1`,
              [userId]
            );
            expect(rows).toEqual([{ itemId: held }]);
          }
      }
      expect(userId).toBe(12);
    });

    it('recognises the control version, and only it', async () => {
      expect(await isControlFlaggerVersion(CONTROL_VERSION)).toBe(true);
      expect(await isControlFlaggerVersion('scan@1')).toBe(false);
    });
  });
});

// Hundreds of claims each; PGlite is slow under a loaded machine.
describe('claimNext source mix', { timeout: 60_000 }, () => {
  const UPLOAD = { sources: ['orchestrator-scan'] } as const;
  const PROMPT = { sources: ['xguard-prompt'] } as const;
  const CONTROL = { sources: ['control-sample'] } as const;

  /** Each hundredth of [0, 1) exactly once per 100 draws, interleaved. */
  const everyHundredth = () => {
    let k = 0;
    return () => (((k++ * 37) % 100) + 0.5) / 100;
  };
  /** mulberry32: a small seeded PRNG, so the counts below are fixed. */
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  async function seedMany(counts: { upload?: number; prompt?: number; control?: number }) {
    const sourceOf = new Map<number, string>();
    let imageId = 1;
    for (const [source, opts] of [
      ['upload', UPLOAD],
      ['prompt', PROMPT],
      ['control', CONTROL],
    ] as const)
      for (let n = 0; n < (counts[source] ?? 0); n++)
        sourceOf.set(await seedItem(imageId++, opts), source);
    return sourceOf;
  }

  async function pull(sourceOf: Map<number, string>, n: number, rng: () => number) {
    const served: Record<string, number> = {};
    for (let userId = 1; userId <= n; userId++) {
      const card = await claimNext(userId, {}, NOW, rng);
      const source = card ? sourceOf.get(card.itemId)! : 'none';
      served[source] = (served[source] ?? 0) + 1;
    }
    return served;
  }

  it('serves exactly the mix over every hundred draws', async () => {
    const sourceOf = await seedMany({ upload: 20, prompt: 20, control: 5 });
    expect(await pull(sourceOf, 100, everyHundredth())).toEqual({
      upload: 45,
      prompt: 45,
      control: 10,
    });
  });

  it('the seeded draw converges on the mix', () => {
    const rng = seeded(7);
    const drawn: Record<string, number> = {};
    for (let n = 0; n < 100_000; n++) {
      const [first] = sourceOrder(rng);
      drawn[first] = (drawn[first] ?? 0) + 1;
    }
    expect(drawn).toEqual({ upload: 44_987, prompt: 44_972, control: 10_041 });
  });

  it('serves the drawn source on every claim of a seeded run', async () => {
    const sourceOf = await seedMany({ upload: 60, prompt: 60, control: 20 });
    const replay = seeded(7);
    const expected: Record<string, number> = {};
    for (let n = 0; n < 300; n++) {
      const [first] = sourceOrder(replay);
      expected[first] = (expected[first] ?? 0) + 1;
    }
    expect(expected).toEqual({ upload: 122, prompt: 141, control: 37 });
    expect(await pull(sourceOf, 300, seeded(7))).toEqual(expected);
  });

  it('passes an empty source’s draws to the heaviest source left', async () => {
    const sourceOf = await seedMany({ upload: 20, prompt: 20 });
    expect(await pull(sourceOf, 100, everyHundredth())).toEqual({ upload: 55, prompt: 45 });
  });

  it('never passes an empty scan source’s draws to the control lane while the other has items', async () => {
    const sourceOf = await seedMany({ prompt: 30, control: 5 });
    expect(await pull(sourceOf, 100, everyHundredth())).toEqual({ prompt: 90, control: 10 });
  });

  it('serves whatever is left when only one source has items', async () => {
    const sourceOf = await seedMany({ prompt: 10 });
    expect(await pull(sourceOf, 30, everyHundredth())).toEqual({ prompt: 30 });
  });

  it('falls back when the drawn source holds only items the voter already voted on', async () => {
    const voted = await seedItem(1, { ...UPLOAD, votes: 1 });
    const prompt = await seedItem(2, PROMPT);
    const card = await claimNext(900, {}, NOW, () => 0);
    expect(card!.itemId).toBe(prompt);
    expect(card!.itemId).not.toBe(voted);
  });

  it('files an item with both scan flags under upload, and a control item under control only', async () => {
    const prompt = await seedItem(1, { ...PROMPT, flaggedAt: '2026-10-13T07:00:00Z' });
    const both = await seedItem(2, {
      sources: ['xguard-prompt', 'orchestrator-scan'],
      flaggedAt: '2026-10-13T08:00:00Z',
    });
    // A scanner can flag an image after it was sampled; the item stays in the control lane.
    const control = await seedItem(3, {
      sources: ['control-sample', 'orchestrator-scan'],
      flaggedAt: '2026-10-13T09:00:00Z',
    });
    // 0.1, 0.5 and 0.95 fall in the upload, prompt and control bands of QUEUE_MIX.
    expect((await claimNext(1, {}, NOW, () => 0.1))!.itemId).toBe(both);
    expect((await claimNext(2, {}, NOW, () => 0.5))!.itemId).toBe(prompt);
    expect((await claimNext(3, {}, NOW, () => 0.95))!.itemId).toBe(control);
  });

  it('serves a filtered view in queue order, without drawing', async () => {
    const upload = await seedItem(1, { ...UPLOAD, flaggedAt: '2026-10-13T07:00:00Z' });
    const prompt = await seedItem(2, { ...PROMPT, flaggedAt: '2026-10-13T08:00:00Z' });
    const noDraw = () => {
      throw new Error('a filtered claim drew a source');
    };
    expect((await claimNext(1, { day: '2026-10-13' }, NOW, noDraw))!.itemId).toBe(prompt);
    expect((await claimNext(2, { flaggerVersion: 'scan@1' }, NOW, noDraw))!.itemId).toBe(prompt);
    expect(upload).not.toBe(prompt);
  });

  it('draws once per new claim, not when handing back a held lease', async () => {
    await seedMany({ upload: 2, prompt: 2 });
    let draws = 0;
    const counted = () => (draws++, 0.1);
    await claimNext(1, {}, NOW, counted);
    await claimNext(1, {}, later(1000), counted);
    expect(draws).toBe(1);
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
      { itemId: it1, userId: 1, choice: BLOCK, msOnItem: 10 },
      later(LEASE_MS + 2)
    );
    expect(r).toEqual({ ok: false, reason: 'full' });
    expect((await item(it1)).votes).toBe(1);
  });

  it('accepts a vote on an expired lease while a slot is still free', async () => {
    const it1 = await seedItem(1);
    await claimNext(1, {}, NOW);
    const r = await castVote(
      { itemId: it1, userId: 1, choice: KEEP, msOnItem: 10 },
      later(LEASE_MS + 1)
    );
    expect(r.ok).toBe(true);
  });

  it('counts one vote per moderator per item', async () => {
    const it1 = await seedItem(1);
    await claimNext(1, {}, NOW);
    expect((await castVote({ itemId: it1, userId: 1, choice: BLOCK, msOnItem: 5 }, NOW)).ok).toBe(
      true
    );
    expect(
      await castVote({ itemId: it1, userId: 1, choice: BLOCK, msOnItem: 5 }, later(10))
    ).toEqual({
      ok: false,
      reason: 'already-voted',
    });
    expect(await item(it1)).toMatchObject({ votes: 1, blockVotes: 1, status: 'open' });
  });

  it('refuses a fourth vote', async () => {
    const it1 = await seedItem(1, { votes: 3, blockVotes: 0 });
    await pg.query(`UPDATE "ScanLabelItem" SET status = 'decided' WHERE id = $1`, [it1]);
    expect(await castVote({ itemId: it1, userId: 1, choice: BLOCK, msOnItem: 1 }, NOW)).toEqual({
      ok: false,
      reason: 'not-open',
    });
  });

  it('releases the voter’s lease', async () => {
    const it1 = await seedItem(1);
    await claimNext(1, {}, NOW);
    await castVote({ itemId: it1, userId: 1, choice: KEEP, msOnItem: 1 }, NOW);
    const { rows } = await pg.query(`SELECT * FROM "ScanLabelClaim"`);
    expect(rows).toHaveLength(0);
  });
});

describe('outcome', () => {
  const voteAs = (itemId: number, userId: number, block: boolean) =>
    castVote({ itemId, userId, choice: block ? BLOCK : KEEP, msOnItem: 1 }, NOW);

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

describe('owner reveal', () => {
  const OWNER = 500;
  const ownedItem = async (imageId: number, owner = OWNER) => {
    const itemId = await seedItem(imageId);
    await pg.query(`UPDATE "Image" SET "userId" = $1 WHERE id = $2`, [owner, imageId]);
    return itemId;
  };
  beforeEach(async () => {
    await pg.query(`INSERT INTO "User" ("id", "username") VALUES (1, 'voter'), ($1, 'uploader')`, [
      OWNER,
    ]);
  });

  it('serves the card with no owner in it', async () => {
    await ownedItem(1);
    const card = await claimNext(1, {}, NOW);
    expect(Object.keys(card!).sort()).toEqual(
      ['itemId', 'imageId', 'url', 'type', 'name', 'width', 'height', 'leaseExpiresAt'].sort()
    );
  });

  it('names the image owner, not the moderator who voted', async () => {
    const it1 = await ownedItem(7);
    await claimNext(1, {}, NOW);
    await castVote({ itemId: it1, userId: 1, choice: KEEP, msOnItem: 1 }, NOW);
    expect(await getVotedItemOwner(it1, 1)).toEqual({
      imageId: 7,
      ownerId: OWNER,
      ownerUsername: 'uploader',
    });
  });

  it('keeps the id of an owner whose account row is gone', async () => {
    const it1 = await ownedItem(7, 501);
    await castVote({ itemId: it1, userId: 1, choice: KEEP, msOnItem: 1 }, NOW);
    expect(await getVotedItemOwner(it1, 1)).toEqual({
      imageId: 7,
      ownerId: 501,
      ownerUsername: null,
    });
  });

  it('reveals nothing to a moderator who has not voted on the item', async () => {
    const it1 = await ownedItem(7);
    await claimNext(2, {}, NOW);
    await castVote({ itemId: it1, userId: 1, choice: KEEP, msOnItem: 1 }, NOW);
    expect(await getVotedItemOwner(it1, 2)).toBeNull();
  });
});

describe('counters', () => {
  it('counts my votes today against my quota', async () => {
    const a = await seedItem(1);
    const b = await seedItem(2);
    await castVote(
      { itemId: a, userId: 1, choice: KEEP, msOnItem: 1 },
      new Date('2026-10-12T23:00:00Z')
    );
    await castVote({ itemId: b, userId: 1, choice: KEEP, msOnItem: 1 }, NOW);
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

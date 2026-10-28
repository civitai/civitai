import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import {
  castVote,
  closeWithoutOutcome,
  ensureVotePartitions,
  escalateExpired,
  getFeed,
  type QueueDeps,
} from './queue.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => undefined);
const deps = (): QueueDeps => ({ applyConsensus, now: () => NOW });

async function player(userId: number, rankType: string, exp = 0) {
  await pg.query(`INSERT INTO "NewOrderPlayer" ("userId","rankType","exp") VALUES ($1,$2,$3)`, [
    userId,
    rankType,
    exp,
  ]);
}

async function image(id: number, nsfwLevel = 0) {
  await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel") VALUES ($1,$2,$3)`, [
    id,
    `key-${id}`,
    nsfwLevel,
  ]);
}

async function item(
  imageId: number,
  o: {
    minRank?: string;
    priority?: number;
    question?: string;
    hidden?: boolean;
    expires?: Date;
  } = {}
) {
  const res = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","priority","isHiddenCheck","expiresAt")
     VALUES ($1,$2,'test',$3,$4,$5,$6) RETURNING id`,
    [
      o.question ?? Q,
      imageId,
      o.minRank ?? 'Knight',
      o.priority ?? 2,
      o.hidden ?? false,
      o.expires ?? null,
    ]
  );
  return res.rows[0].id;
}

const itemRow = async (id: number) =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "KnightsQueueItem" WHERE id=$1`, [id]))
    .rows[0];
const verdicts = async (id: number) =>
  (
    await pg.query<{ playerId: number; verdict: string; stage: string }>(
      `SELECT "playerId", verdict, stage FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
      [id]
    )
  ).rows;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
  await pg.exec(`INSERT INTO "KnightsQuestion" ("key","kind","prompt","options")
    VALUES ('knights.test.bool','bool','Is there a hat?','[{"value":"yes","label":"Yes"},{"value":"no","label":"No"}]')`);
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  applyConsensus.mockClear();
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image" RESTART IDENTITY`
  );
});

async function fiveKnights(first = 1) {
  for (let i = 0; i < 5; i++) await player(first + i, 'Knight');
}

async function vote(userId: number, itemId: number, answer: string) {
  return castVote(db, { userId, itemId, answer }, deps());
}

describe('getFeed', () => {
  it('returns open Knight items the player has not voted, and never the rating', async () => {
    await player(1, 'Knight');
    await image(10, 8);
    await image(11, 8);
    const a = await item(10);
    const b = await item(11);
    await vote(1, a, '8');

    const feed = await getFeed(db, 1);
    expect(feed?.items.map((i) => i.id)).toEqual([b]);
    expect(JSON.stringify(feed)).not.toMatch(/"nsfwLevel"\s*:/);
  });

  it('puts escalated items first for Templars and keeps Knights off them', async () => {
    await player(1, 'Knight');
    await player(2, 'Templar');
    await image(10);
    await image(11);
    const knightItem = await item(10, { priority: 1 });
    const escalated = await item(11, { minRank: 'Templar', priority: 3 });

    expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([knightItem]);
    expect((await getFeed(db, 2))?.items.map((i) => i.id)).toEqual([escalated, knightItem]);
  });

  it('orders by priority then age, and skips hidden checks and Acolytes', async () => {
    await player(1, 'Knight');
    await player(2, 'Acolyte');
    for (const id of [10, 11, 12, 13]) await image(id);
    const low = await item(10, { priority: 3 });
    const high = await item(11, { priority: 1 });
    await item(12, { hidden: true });
    const mid = await item(13, { priority: 2 });

    expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([high, mid, low]);
    expect(await getFeed(db, 2)).toBeNull();
  });

  it('serves one question at a time', async () => {
    await player(1, 'Knight');
    await image(10);
    await image(11);
    const rating = await item(10, { priority: 2 });
    await item(11, { priority: 1, question: 'knights.test.bool' });

    const feed = await getFeed(db, 1);
    expect(feed?.question.key).toBe('knights.test.bool');
    expect(feed?.items.map((i) => i.id)).not.toContain(rating);
  });
});

describe('castVote rejections', () => {
  it('rejects Acolytes, repeat votes, unknown answers and too-low ranks', async () => {
    await player(1, 'Acolyte');
    await player(2, 'Knight');
    await image(10);
    const high = await item(10);
    const escalated = await item(10, { minRank: 'Templar' });

    expect(await vote(1, high, '4')).toMatchObject({ status: 'rejected', reason: 'not-eligible' });
    expect(await vote(2, high, '999')).toMatchObject({ status: 'rejected', reason: 'bad-answer' });
    expect(await vote(2, escalated, '4')).toMatchObject({
      status: 'rejected',
      reason: 'not-eligible',
    });
    expect(await vote(2, high, '4')).toMatchObject({ status: 'recorded' });
    expect(await vote(2, high, '8')).toMatchObject({ status: 'rejected', reason: 'already-voted' });
  });
});

describe('resolution', () => {
  it('resolves at five agreeing votes, grades every vote and applies the rating once', async () => {
    await fiveKnights();
    await image(10, 4);
    const id = await item(10);

    for (const u of [1, 2, 3, 4]) expect((await vote(u, id, '4')).status).toBe('recorded');
    expect(applyConsensus).not.toHaveBeenCalled();
    expect((await vote(5, id, '4')).status).toBe('resolved');

    expect(applyConsensus).toHaveBeenCalledTimes(1);
    expect(applyConsensus).toHaveBeenCalledWith({
      questionKey: Q,
      imageId: 10,
      value: '4',
      actorId: 5,
    });
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved', resolvedValue: '4' });
    expect((await verdicts(id)).every((v) => v.verdict === 'correct')).toBe(true);

    expect(await vote(1, id, '4')).toMatchObject({ status: 'rejected' });
    expect(applyConsensus).toHaveBeenCalledTimes(1);
  });

  it('marks dissenters failed', async () => {
    await fiveKnights();
    await image(10, 4);
    const id = await item(10);
    for (const u of [1, 2, 3]) await vote(u, id, '4');
    await vote(4, id, '8');
    await vote(5, id, '4');
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual([
      'correct',
      'correct',
      'correct',
      'failed',
      'correct',
    ]);
  });

  it('keeps a split open until ten votes, then escalates to Templars with votes still pending', async () => {
    await fiveKnights(1);
    await fiveKnights(6);
    await image(10, 4);
    const id = await item(10);
    const answers = ['1', '2', '4', '8', '16', '1', '2', '4', '8', '16'];
    for (let i = 0; i < 9; i++) expect((await vote(i + 1, id, answers[i])).status).toBe('recorded');
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Knight' });

    expect((await vote(10, id, answers[9])).status).toBe('escalated');
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar' });
    expect((await itemRow(id)).expiresAt).toEqual(new Date('2026-12-18T12:00:00Z'));
    expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
    expect(applyConsensus).not.toHaveBeenCalled();
  });

  it('grades the Knight votes by the Templar outcome', async () => {
    await fiveKnights(1);
    await fiveKnights(6);
    for (let u = 20; u < 25; u++) await player(u, 'Templar');
    await image(10, 4);
    const id = await item(10);
    const answers = ['1', '2', '4', '8', '16', '1', '2', '4', '8', '16'];
    for (let i = 0; i < 10; i++) await vote(i + 1, id, answers[i]);

    for (let u = 20; u < 24; u++) await vote(u, id, '4');
    expect((await vote(24, id, '4')).status).toBe('resolved');

    const graded = await verdicts(id);
    expect(graded.filter((v) => v.verdict === 'correct').length).toBe(2 + 5);
    expect(graded.filter((v) => v.verdict === 'failed').length).toBe(8);
    expect(applyConsensus).toHaveBeenCalledTimes(1);
  });

  it('hands a Templar split to the Inquisitors without applying anything', async () => {
    for (let u = 20; u < 30; u++) await player(u, 'Templar');
    await image(10, 4);
    const id = await item(10, { minRank: 'Templar' });
    const answers = ['1', '2', '4', '8', '16', '1', '2', '4', '8', '16'];
    for (let i = 0; i < 10; i++) await vote(20 + i, id, answers[i]);

    expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', minRank: 'Inquisitor' });
    expect((await itemRow(id)).expiresAt).toBeNull();
    expect(applyConsensus).not.toHaveBeenCalled();
    expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
  });

  it('sends a rating more than one level below the current one to the Inquisitors', async () => {
    await fiveKnights();
    await image(10, 16);
    const id = await item(10);
    for (const u of [1, 2, 3, 4, 5]) await vote(u, id, '4');

    expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', resolvedValue: null });
    expect(applyConsensus).not.toHaveBeenCalled();
    expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
  });

  it('allows a one-level down-rating', async () => {
    await fiveKnights();
    await image(10, 8);
    const id = await item(10);
    for (const u of [1, 2, 3, 4, 5]) await vote(u, id, '4');
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved' });
  });

  it('rolls the final vote back when the rating cannot be applied', async () => {
    await fiveKnights();
    await image(10, 4);
    const id = await item(10);
    for (const u of [1, 2, 3, 4]) await vote(u, id, '4');

    applyConsensus.mockRejectedValueOnce(new Error('main app down'));
    await expect(vote(5, id, '4')).rejects.toThrow('main app down');
    expect(await itemRow(id)).toMatchObject({ status: 'Open' });
    expect((await verdicts(id)).length).toBe(4);

    expect((await vote(5, id, '4')).status).toBe('resolved');
  });

  it('weights votes by rank and smites', async () => {
    await player(1, 'Knight');
    await player(2, 'Templar');
    await player(3, 'Knight');
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (3),(3)`);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId","cleansedAt") VALUES (3, now())`);
    await image(10);
    const id = await item(10);
    for (const u of [1, 2, 3]) await vote(u, id, '4');
    const weights = (
      await pg.query<{ weight: number }>(`SELECT weight FROM "KnightsVote" ORDER BY "playerId"`)
    ).rows.map((r) => r.weight);
    expect(weights).toEqual([0.68, 1.18, 0.35]);
  });
});

describe('escalateExpired', () => {
  it('moves expired open items up one rank and never deletes them', async () => {
    await image(10);
    await image(11);
    await image(12);
    const stale = await item(10, { expires: new Date('2026-12-15T11:00:00Z') });
    const staleTemplar = await item(11, {
      minRank: 'Templar',
      expires: new Date('2026-12-15T11:00:00Z'),
    });
    const fresh = await item(12, { expires: new Date('2026-12-16T11:00:00Z') });

    const res = await escalateExpired(db, { now: NOW });
    expect(res).toEqual({ escalated: 1, toInquisitor: 1 });
    expect(await itemRow(stale)).toMatchObject({ status: 'Open', minRank: 'Templar' });
    expect(await itemRow(staleTemplar)).toMatchObject({
      status: 'Inquisitor',
      minRank: 'Inquisitor',
    });
    expect(await itemRow(fresh)).toMatchObject({ status: 'Open', minRank: 'Knight' });
    expect(
      (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "KnightsQueueItem"`)).rows[0].n
    ).toBe(3);
  });
});

describe('closeWithoutOutcome', () => {
  it('marks pending votes inconclusive and closes the item', async () => {
    await fiveKnights();
    await image(10);
    const id = await item(10);
    await vote(1, id, '4');
    await vote(2, id, '8');

    await closeWithoutOutcome(db, id, NOW);
    expect(await itemRow(id)).toMatchObject({ status: 'Closed', resolvedValue: null });
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual(['inconclusive', 'inconclusive']);
  });
});

describe('ensureVotePartitions', () => {
  it('creates missing month partitions ahead of time and can run twice', async () => {
    const count = async () =>
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = '"KnightsVote"'::regclass`
        )
      ).rows[0].n;
    const before = await count();
    await ensureVotePartitions(db, { now: new Date('2030-03-10T00:00:00Z'), monthsAhead: 2 });
    await ensureVotePartitions(db, { now: new Date('2030-03-10T00:00:00Z'), monthsAhead: 2 });
    expect(await count()).toBe(before + 3);

    await player(1, 'Knight');
    await image(10);
    const id = await item(10);
    const res = await castVote(
      db,
      { userId: 1, itemId: id, answer: '4' },
      { applyConsensus, now: () => new Date('2030-04-02T00:00:00Z') }
    );
    expect(res.status).toBe('recorded');
  });
});

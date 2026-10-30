import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { PROGRESSION } from '../progression/config';
import { ledgerOf } from '../progression/progression';
import { ensureVotePartitions } from '../queue/queue.service';
import { importYesNo, type YesNoRow } from './import';
import { castYesNoVote } from './vote';

const NOW = new Date('2026-12-21T12:00:00Z');
const GOLD = 100;

let pg: PGlite;
let db: Kysely<DB>;
const mirror = vi.fn(async () => undefined);
const deps = (voteLimits?: { windowSeconds: number; max: number }[]) => ({
  now: () => NOW,
  voteLimits,
  mirrorXp: mirror,
});

const row = (id: string, o: Partial<YesNoRow> = {}): YesNoRow => ({
  externalId: id,
  imageId: 10,
  axis: 'violence',
  audience: 'players',
  prompt: `Question ${id}?`,
  yesEffect: 'R4',
  noEffect: 'R3',
  meta: {},
  ...o,
});

async function seed(rows: YesNoRow[], images = [10]) {
  for (const image of images) await seedImage(pg, image);
  await importYesNo(db, rows);
  return Object.fromEntries(
    (
      await pg.query<{ id: number; externalId: string }>(
        `SELECT id, "externalId" FROM "KnightsQueueItem"`
      )
    ).rows.map((r) => [r.externalId, r.id])
  );
}

const vote = (userId: number, itemId: number, answer: string, extra = {}) =>
  castYesNoVote(db, { userId, itemId, answer, ...extra }, deps());
const item = async (id: number) =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "KnightsQueueItem" WHERE id=$1`, [id]))
    .rows[0];
const votes = async (itemId: number) =>
  (
    await pg.query<Record<string, unknown>>(
      `SELECT "playerId", answer, verdict, gold, xp, "settledAt", "questionKey", stage, weight FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
      [itemId]
    )
  ).rows;
const player = async (id: number) =>
  (
    await pg.query<{ exp: number; goldPending: number; goldEarned: number }>(
      `SELECT exp, "goldPending", "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [id]
    )
  ).rows[0];
async function knights(n: number) {
  for (let i = 1; i <= n; i++) await seedPlayer(pg, i);
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  mirror.mockClear();
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","KnightsPlayerDay","Image","Post" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
  );
});

describe('an answer', () => {
  it('lands in the ledger under the item, pays flat XP at once and holds the gold as pending', async () => {
    const ids = await seed([row('a')]);
    await knights(1);

    expect(await vote(1, ids.a, 'yes')).toEqual({ status: 'recorded' });

    expect(await votes(ids.a)).toMatchObject([
      {
        playerId: 1,
        answer: 'yes',
        verdict: 'pending',
        gold: GOLD,
        xp: PROGRESSION.voteXp,
        settledAt: null,
        questionKey: 'knights.yesno.violence',
        stage: 'Knight',
      },
    ]);
    expect(await player(1)).toEqual({ exp: PROGRESSION.voteXp, goldPending: GOLD, goldEarned: 0 });
    expect(await item(ids.a)).toMatchObject({ status: 'Open', voteCount: 1 });
    expect(mirror).toHaveBeenCalledWith([{ playerId: 1, xp: PROGRESSION.voteXp }]);
  });

  it('is refused for what the other votes refuse: repeats, unknown answers, ranks, reset, pace', async () => {
    const ids = await seed([row('a')]);
    await knights(1);
    await seedPlayer(pg, 2, 'Acolyte');
    await seedPlayer(pg, 3);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (3),(3),(3)`);

    expect(await vote(1, ids.a, '4')).toEqual({ status: 'rejected', reason: 'bad-answer' });
    expect(await vote(2, ids.a, 'yes')).toEqual({ status: 'rejected', reason: 'not-eligible' });
    expect(await vote(3, ids.a, 'yes')).toEqual({ status: 'rejected', reason: 'reset-pending' });
    expect(await vote(99, ids.a, 'yes')).toEqual({ status: 'rejected', reason: 'no-player' });
    expect(await vote(1, ids.a, 'yes')).toEqual({ status: 'recorded' });
    expect(await vote(1, ids.a, 'no')).toEqual({ status: 'rejected', reason: 'already-voted' });

    const paced = await castYesNoVote(
      db,
      { userId: 1, itemId: ids.a, answer: 'yes' },
      deps([{ windowSeconds: 60, max: 1 }])
    );
    expect(paced).toMatchObject({ status: 'limited' });
    expect(await votes(ids.a)).toHaveLength(1);
  });

  it('is refused for a question that is not the players to answer or whose image is not servable', async () => {
    const ids = await seed(
      [
        row('policy', { audience: 'moderators' }),
        row('hidden', { imageId: 11 }),
        row('ok', { imageId: 12 }),
      ],
      [10, 12]
    );
    await seedImage(pg, 11, { publishedAt: null });
    await knights(1);

    expect(await vote(1, ids.policy, 'yes')).toEqual({ status: 'rejected', reason: 'unavailable' });
    expect(await vote(1, ids.hidden, 'yes')).toEqual({ status: 'rejected', reason: 'unavailable' });
    expect(await vote(1, ids.ok, 'yes')).toEqual({ status: 'recorded' });
    expect(await vote(1, 9999, 'yes')).toEqual({ status: 'rejected', reason: 'not-open' });
  });

  it('is not asked twice: the same words about the same image under another id count as answered', async () => {
    const ids = await seed([
      row('a', { prompt: 'Same words?' }),
      row('b', { prompt: 'Same words?' }),
      row('c'),
    ]);
    await knights(1);
    expect(await vote(1, ids.a, 'yes')).toEqual({ status: 'recorded' });
    expect(await vote(1, ids.b, 'yes')).toEqual({ status: 'rejected', reason: 'already-voted' });
    expect(await vote(1, ids.c, 'yes')).toEqual({ status: 'recorded' });
  });
});

describe('consensus', () => {
  it('closes the question at the consensus size and pays gold only to those who matched the majority', async () => {
    const ids = await seed([row('a')]);
    await knights(5);
    for (const [user, answer] of [
      [1, 'yes'],
      [2, 'yes'],
      [3, 'no'],
      [4, 'yes'],
    ] as const) {
      await vote(user, ids.a, answer);
      expect(await item(ids.a)).toMatchObject({ status: 'Open' });
    }
    await vote(5, ids.a, 'no');

    expect(await item(ids.a)).toMatchObject({
      status: 'Consensus',
      resolvedValue: 'yes',
      voteCount: 5,
    });
    expect(await votes(ids.a)).toMatchObject([
      { playerId: 1, verdict: 'matched', gold: GOLD },
      { playerId: 2, verdict: 'matched', gold: GOLD },
      { playerId: 3, verdict: 'unmatched', gold: 0 },
      { playerId: 4, verdict: 'matched', gold: GOLD },
      { playerId: 5, verdict: 'unmatched', gold: 0 },
    ]);
    for (const v of await votes(ids.a)) expect(v.settledAt).not.toBeNull();

    // XP stays the flat per-answer amount; only a matched answer moves its gold from pending to earned.
    expect(await player(1)).toEqual({ exp: PROGRESSION.voteXp, goldPending: 0, goldEarned: GOLD });
    expect(await player(3)).toEqual({ exp: PROGRESSION.voteXp, goldPending: 0, goldEarned: 0 });
  });

  it('refuses further answers once closed', async () => {
    const ids = await seed([row('a')]);
    await knights(6);
    for (let user = 1; user <= 5; user++) await vote(user, ids.a, 'yes');
    expect(await vote(6, ids.a, 'yes')).toEqual({ status: 'rejected', reason: 'not-open' });
    expect(await votes(ids.a)).toHaveLength(5);
  });

  it('is not graded against a truth: no accuracy, no bulk XP, no rank movement', async () => {
    const ids = await seed([row('a')]);
    await knights(5);
    for (let user = 1; user <= 5; user++) await vote(user, ids.a, user <= 3 ? 'yes' : 'no');

    expect(await ledgerOf(db, 1)).toEqual({ correct: 0, graded: 0 });
    expect(await ledgerOf(db, 5)).toEqual({ correct: 0, graded: 0 });
    const players = await pg.query<{ rankType: string; fervor: number; exp: number }>(
      `SELECT "rankType", fervor, exp FROM "NewOrderPlayer"`
    );
    for (const p of players.rows) {
      expect(p).toMatchObject({ rankType: 'Knight', fervor: 0, exp: PROGRESSION.voteXp });
    }
    expect((await pg.query(`SELECT 1 FROM "NewOrderSmite"`)).rows).toHaveLength(0);
  });

  it('keeps asking through a tie, and at the cap gives the question up and pays no gold', async () => {
    const ids = await seed([row('a'), row('b', { axis: 'language', imageId: 11 })], [10, 11]);
    await pg.query(`UPDATE "KnightsQueueItem" SET "votesNeeded" = 4`);
    await pg.query(
      `UPDATE "KnightsQuestion" SET "maxVotes" = 4 WHERE key = 'knights.yesno.language'`
    );
    await knights(5);

    for (const [user, answer] of [
      [1, 'yes'],
      [2, 'no'],
      [3, 'yes'],
      [4, 'no'],
    ] as const) {
      await vote(user, ids.a, answer);
      await vote(user, ids.b, answer);
    }
    // 2-2 on the cap of 4: given up. 2-2 below the cap: still open.
    expect(await item(ids.b)).toMatchObject({ status: 'Closed', reason: 'no-consensus' });
    const closed = await votes(ids.b);
    expect(closed.every((v) => v.verdict === 'inconclusive' && v.gold === 0 && v.settledAt)).toBe(
      true
    );
    expect(await player(1)).toMatchObject({ goldPending: GOLD, goldEarned: 0 });

    expect(await item(ids.a)).toMatchObject({ status: 'Open', voteCount: 4 });
    await vote(5, ids.a, 'yes');
    expect(await item(ids.a)).toMatchObject({ status: 'Consensus', resolvedValue: 'yes' });
  });
});

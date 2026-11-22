import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { counterValue } from '../../../test/metrics';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { PROGRESSION } from '../progression/config';
import { ledgerOf, settleAndMirror, settleFinalItems } from '../progression/progression';
import { ensureVotePartitions, lockPlayerVoting } from '../queue/queue.service';
import { judgesNeeded } from './items';
import { importYesNo, type YesNoRow } from './import';
import { castYesNoVote } from './vote';
import { pickYesNo } from './feed';

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
    const before = await counterValue('knights_votes_total', { kind: 'yesno' });

    expect(await vote(1, ids.a, 'yes')).toEqual({ status: 'recorded' });
    expect(await counterValue('knights_votes_total', { kind: 'yesno' })).toBe(before + 1);

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

  it('is refused for a question on a Private post', async () => {
    const ids = await seed([row('p')]);
    await pg.query(`UPDATE "Post" SET availability = 'Private' WHERE id = 10`);
    await knights(1);
    expect(await vote(1, ids.p, 'yes')).toEqual({ status: 'rejected', reason: 'unavailable' });
    expect(await votes(ids.p)).toHaveLength(0);
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

describe('a held player', () => {
  const hold = (...ids: number[]) =>
    pg.query(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = now() WHERE "userId" = ANY($1)`, [
      ids,
    ]);

  it('is recorded at weight 0 and never decides the question, however many held answers agree', async () => {
    const ids = await seed([row('a')]);
    await knights(7);
    await hold(1, 2, 3, 4, 5, 6, 7);
    for (let u = 1; u <= 7; u++) await vote(u, ids.a, 'yes');
    expect(await item(ids.a)).toMatchObject({ status: 'Open' });
    expect((await votes(ids.a)).every((v) => v.weight === 0)).toBe(true);
  });

  it('decides as the real answers alone would, and is graded and paid XP', async () => {
    const ids = await seed([row('a')]);
    await knights(8);
    await hold(6, 7, 8);
    await vote(6, ids.a, 'no');
    await vote(7, ids.a, 'no');
    await vote(8, ids.a, 'yes');
    for (const u of [1, 2, 3]) {
      await vote(u, ids.a, 'yes');
      expect(await item(ids.a)).toMatchObject({ status: 'Open' });
    }
    await vote(4, ids.a, 'yes');

    expect(await item(ids.a)).toMatchObject({ status: 'Consensus', resolvedValue: 'yes' });
    expect(await votes(ids.a)).toMatchObject([
      { playerId: 1, verdict: 'correct' },
      { playerId: 2, verdict: 'correct' },
      { playerId: 3, verdict: 'correct' },
      { playerId: 4, verdict: 'correct' },
      { playerId: 6, verdict: 'failed', weight: 0 },
      { playerId: 7, verdict: 'failed', weight: 0 },
      { playerId: 8, verdict: 'correct', weight: 0 },
    ]);
    expect((await player(8)).exp).toBe(PROGRESSION.voteXp + PROGRESSION.correctXp);
  });
});

describe('consensus', () => {
  it('closes the question once one answer holds 75% and grades the answers like a rating: the majority right, the rest wrong', async () => {
    const ids = await seed([row('a')]);
    await knights(5);
    // 3-1 at four answers is not unanimous, so the stage keeps asking; 4-1 is 80%.
    for (const [user, answer] of [
      [1, 'yes'],
      [2, 'yes'],
      [3, 'no'],
      [4, 'yes'],
    ] as const) {
      await vote(user, ids.a, answer);
      expect(await item(ids.a)).toMatchObject({ status: 'Open' });
    }
    await vote(5, ids.a, 'yes');

    expect(await item(ids.a)).toMatchObject({
      status: 'Consensus',
      resolvedValue: 'yes',
      voteCount: 5,
    });
    expect(await votes(ids.a)).toMatchObject([
      { playerId: 1, verdict: 'correct', gold: GOLD },
      { playerId: 2, verdict: 'correct', gold: GOLD },
      { playerId: 3, verdict: 'failed', gold: 0 },
      { playerId: 4, verdict: 'correct', gold: GOLD },
      { playerId: 5, verdict: 'correct', gold: GOLD },
    ]);
    for (const v of await votes(ids.a)) expect(v.settledAt).not.toBeNull();

    // Right: the vote XP plus the bulk XP, and the gold moves from pending to earned. Wrong: the vote XP only, the gold dropped.
    expect(await player(1)).toEqual({
      exp: PROGRESSION.voteXp + PROGRESSION.correctXp,
      goldPending: 0,
      goldEarned: GOLD,
    });
    expect(await player(3)).toEqual({ exp: PROGRESSION.voteXp, goldPending: 0, goldEarned: 0 });
  });

  it('refuses further answers once closed', async () => {
    const ids = await seed([row('a')]);
    await knights(5);
    for (let user = 1; user <= 4; user++) await vote(user, ids.a, 'yes');
    expect(await vote(5, ids.a, 'yes')).toEqual({ status: 'rejected', reason: 'not-open' });
    expect(await votes(ids.a)).toHaveLength(4);
  });

  it('counts in the accuracy ledger, and issues no smites', async () => {
    const ids = await seed([row('a')]);
    await knights(5);
    for (let user = 1; user <= 5; user++) await vote(user, ids.a, user === 4 ? 'no' : 'yes');

    expect(await ledgerOf(db, 1)).toEqual({ correct: 1, graded: 1 });
    expect(await ledgerOf(db, 4)).toEqual({ correct: 0, graded: 1 });
    expect((await pg.query(`SELECT 1 FROM "NewOrderSmite"`)).rows).toHaveLength(0);
  });

  it('settles once: a second settlement and the tick sweep pay nothing more', async () => {
    const ids = await seed([row('a')]);
    await knights(4);
    for (let user = 1; user <= 4; user++) await vote(user, ids.a, 'yes');
    const before = await player(1);

    expect(await settleFinalItems(db, { now: NOW })).toMatchObject({ votes: 0, failed: 0 });
    expect((await settleAndMirror(db, ids.a, NOW)).votes).toBe(0);
    expect(await player(1)).toEqual(before);
  });

  it('keeps asking while the agreement is weak, and at ten answers without 75% gives the question up and pays no gold', async () => {
    const ids = await seed([row('a'), row('b', { axis: 'language', imageId: 11 })], [10, 11]);
    await knights(10);
    // b: 6-2 after eight answers is 75%, the first point it settles. a: never 75%, 6-4 at the cap.
    const b = ['yes', 'yes', 'no', 'yes', 'no', 'yes', 'yes', 'yes'];
    const a = ['yes', 'no', 'yes', 'no', 'yes', 'no', 'yes', 'no', 'yes', 'yes'];
    for (const [i, answer] of b.entries()) {
      expect(await item(ids.b)).toMatchObject({ status: 'Open' });
      await vote(i + 1, ids.b, answer);
    }
    expect(await item(ids.b)).toMatchObject({ status: 'Consensus', resolvedValue: 'yes' });

    for (const [i, answer] of a.entries()) {
      expect(await item(ids.a)).toMatchObject({ status: 'Open' });
      await vote(i + 1, ids.a, answer);
    }
    expect(await item(ids.a)).toMatchObject({ status: 'Closed', reason: 'no-consensus' });
    const closed = await votes(ids.a);
    expect(closed).toHaveLength(10);
    expect(closed.every((v) => v.verdict === 'inconclusive' && v.gold === 0 && v.settledAt)).toBe(
      true
    );
  });
});

describe('the axis question row', () => {
  it('does not change how many answers decide a question: the stage rule does', async () => {
    const ids = await seed([row('a')]);
    await pg.query(
      `UPDATE "KnightsQuestion" SET "votesToResolve" = 2, "maxVotes" = 2 WHERE key = 'knights.yesno.violence'`
    );
    await knights(4);
    for (let user = 1; user <= 3; user++) await vote(user, ids.a, 'yes');
    expect(await item(ids.a)).toMatchObject({ status: 'Open' });
    await vote(4, ids.a, 'yes');
    expect(await item(ids.a)).toMatchObject({ status: 'Consensus', resolvedValue: 'yes' });
  });

  it('still gives the fewest answers to resolve across the axes, and the default with none', async () => {
    expect(await judgesNeeded(db)).toBe(5);
    await seed([row('a'), row('b', { axis: 'language' })]);
    await pg.query(
      `UPDATE "KnightsQuestion" SET "votesToResolve" = 7 WHERE key = 'knights.yesno.violence'`
    );
    await pg.query(
      `UPDATE "KnightsQuestion" SET "votesToResolve" = 4 WHERE key = 'knights.yesno.language'`
    );
    expect(await judgesNeeded(db)).toBe(4);
  });
});

describe('a career reset between the answer and the close', () => {
  it('pays nothing into the new career for answers given before it, and leaves its pending gold alone', async () => {
    const ids = await seed([row('a'), row('b', { imageId: 11 })], [10, 11]);
    await knights(5);
    await vote(1, ids.a, 'yes');

    // What a reset does: moves startAt past the old answer and forfeits the old career's pending gold.
    await pg.query(
      `UPDATE "NewOrderPlayer" SET "startAt" = $1::timestamp, "goldPending" = 0 WHERE "userId" = 1`,
      ['2026-12-21 12:00:30']
    );
    expect(
      await castYesNoVote(
        db,
        { userId: 1, itemId: ids.b, answer: 'yes' },
        { now: () => new Date('2026-12-21T12:01:00Z') }
      )
    ).toEqual({
      status: 'recorded',
    });
    expect((await player(1)).goldPending).toBe(GOLD);

    for (let user = 2; user <= 4; user++) {
      await castYesNoVote(
        db,
        { userId: user, itemId: ids.a, answer: 'yes' },
        { now: () => new Date('2026-12-21T12:02:00Z') }
      );
    }

    expect(await item(ids.a)).toMatchObject({ status: 'Consensus' });
    const old = (await votes(ids.a)).find((v) => v.playerId === 1);
    expect(old).toMatchObject({ verdict: 'correct', gold: 0 });
    expect(old?.settledAt).not.toBeNull();
    // The new career's own pending answer is untouched, and nothing was earned from the old one.
    expect(await player(1)).toMatchObject({
      goldPending: GOLD,
      goldEarned: 0,
      exp: 2 * PROGRESSION.voteXp,
    });
    expect(await player(2)).toMatchObject({ goldPending: 0, goldEarned: GOLD });
  });
});

describe('one player at a time', () => {
  it('takes the per-player vote lock for every answer, paced or not', async () => {
    await knights(1);
    const held = await db.transaction().execute(async (trx) => {
      await lockPlayerVoting(trx, 1);
      const { rows } = await trx.executeQuery<{ n: string }>(
        (
          await import('kysely')
        )
          .sql`SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 7301 AND objid = 1`.compile(
          trx
        )
      );
      return Number(rows[0].n);
    });
    expect(held).toBe(1);
  });
});

describe('escalation', () => {
  async function setup() {
    return seed([row('a'), row('z', { imageId: 20 })], [10, 20]);
  }
  // A rank is staffed once one of its players has voted recently: they answer the warm-up question.
  async function staff(ids: Record<string, number>, userId: number, rank: string) {
    await seedPlayer(pg, userId, rank);
    expect(await vote(userId, ids.z, 'yes')).toEqual({ status: 'recorded' });
  }
  // Alternating answers never reach 75%, so the stage runs to its cap: 10 at Knight, 6 at Templar, 4 at Paladin.
  const split = async (itemId: number, users: number[]) => {
    for (const [i, user] of users.entries())
      expect(await vote(user, itemId, i % 2 === 0 ? 'yes' : 'no')).toEqual({ status: 'recorded' });
  };
  const KNIGHTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const offer = (userId: number, rank: string) =>
    pickYesNo(db, { userId, rank, secret: 's', share: 1, stretch: 10, force: true });

  it('moves a Knight-stage question that ends ten answers without 75% up to the Templars', async () => {
    const ids = await setup();
    await knights(11);
    await staff(ids, 20, 'Templar');
    await split(ids.a, KNIGHTS);

    const moved = await item(ids.a);
    expect(moved).toMatchObject({ status: 'Open', minRank: 'Templar', reason: null });
    expect(moved.escalatedAt).toEqual(NOW);
    // Yes/no questions carry no stage deadline, at any stage.
    expect(moved.expiresAt).toBeNull();
    expect((await votes(ids.a)).every((v) => v.verdict === 'pending' && v.stage === 'Knight')).toBe(
      true
    );

    // A Knight can no longer be served or answer it; a Templar can.
    expect((await offer(11, 'Knight'))?.itemId).not.toBe(ids.a);
    expect(await vote(11, ids.a, 'yes')).toEqual({ status: 'rejected', reason: 'not-eligible' });
    expect((await offer(20, 'Templar'))?.itemId).toBe(ids.a);
  });

  it('decides at the Templar stage on Templar answers alone, and grades the Knight answers by the outcome', async () => {
    const ids = await setup();
    await knights(10);
    for (const t of [20, 21, 22]) await staff(ids, t, 'Templar');
    await split(ids.a, KNIGHTS);
    expect(await item(ids.a)).toMatchObject({ status: 'Open', minRank: 'Templar' });

    await vote(20, ids.a, 'no');
    await vote(21, ids.a, 'no');
    // Two Templar answers: the ten Knight answers do not count toward this stage.
    expect(await item(ids.a)).toMatchObject({ status: 'Open' });
    await vote(22, ids.a, 'no');
    expect(await item(ids.a)).toMatchObject({ status: 'Consensus', resolvedValue: 'no' });

    const graded = await votes(ids.a);
    const verdictOf = (id: number) => graded.find((v) => v.playerId === id)?.verdict;
    expect(KNIGHTS.map(verdictOf)).toEqual(
      KNIGHTS.map((_, i) => (i % 2 === 0 ? 'failed' : 'correct'))
    );
    expect([20, 21, 22].map(verdictOf)).toEqual(['correct', 'correct', 'correct']);
  });

  it('closes as no-consensus when the last staffed stage is exhausted, and never hands it to the Inquisitors', async () => {
    const ids = await setup();
    for (const p of [30, 31, 32, 33]) await staff(ids, p, 'Paladin');
    await pg.query(`UPDATE "KnightsQueueItem" SET "minRank" = 'Paladin' WHERE id = $1`, [ids.a]);
    await split(ids.a, [30, 31, 32, 33]);
    expect(await item(ids.a)).toMatchObject({
      status: 'Closed',
      reason: 'no-consensus',
      minRank: 'Paladin',
    });
  });

  it('closes a Templar-stage question as no-consensus while no Paladin is staffed', async () => {
    const ids = await setup();
    await staff(ids, 20, 'Templar');
    for (const t of [21, 22, 23, 24, 25]) await seedPlayer(pg, t, 'Templar');
    await pg.query(`UPDATE "KnightsQueueItem" SET "minRank" = 'Templar' WHERE id = $1`, [ids.a]);
    await split(ids.a, [20, 21, 22, 23, 24, 25]);
    expect(await item(ids.a)).toMatchObject({
      status: 'Closed',
      reason: 'no-consensus',
      minRank: 'Templar',
    });
  });

  it('closes as before when no rank above the Knights is staffed', async () => {
    const ids = await setup();
    await knights(10);
    await split(ids.a, KNIGHTS);
    expect(await item(ids.a)).toMatchObject({
      status: 'Closed',
      reason: 'no-consensus',
      minRank: 'Knight',
    });
  });
});

describe("a yes/no question on the player's own image", () => {
  it('is never offered to the player who posted it, and their answer is refused', async () => {
    const ids = await seed([row('a')]);
    await knights(2);
    await pg.query(`UPDATE "Image" SET "userId"=1 WHERE id=10`);
    const offer = (userId: number) =>
      pickYesNo(db, { userId, rank: 'Knight', secret: 's', share: 1, stretch: 10, force: true });

    expect(await offer(1)).toBeNull();
    expect((await offer(2))?.itemId).toBe(ids.a);

    expect(await vote(1, ids.a, 'yes')).toEqual({ status: 'rejected', reason: 'own-image' });
    expect(await votes(ids.a)).toEqual([]);
  });
});

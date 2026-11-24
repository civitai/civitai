import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { DEFAULT_HIDDEN_CHECKS } from './config';
import { answerHiddenCheck, hiddenItemId, pickHiddenCheck } from './hidden.service';
import { settleHiddenChecks } from './settle';

vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const SECRET = 'test-secret';
const settings = { ...DEFAULT_HIDDEN_CHECKS, settleDelayMinutes: 0 };
const resetPlayer = vi.fn(async () => undefined);

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsQueueItem","KnightsPlayerDay","KnightsPlayer","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
});

async function reference(imageId: number, status: string, answer = '4') {
  await seedImage(pg, imageId, { nsfwLevel: Number(answer) });
  const row = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey","status") VALUES ($1,'hiddenCheck',$2,'agreement',$3,$4) RETURNING id`,
    [imageId, answer, Q, status]
  );
  return row.rows[0].id;
}

const pick = (userId: number, probationShare?: number) =>
  pickHiddenCheck(db, {
    userId,
    rank: 'Knight',
    secret: SECRET,
    questionKey: Q,
    rate: 1,
    probationShare,
  });

const answerGraded = (userId: number, referenceId: number, value: string) =>
  answerHiddenCheck(
    db,
    { userId, referenceId, answer: value },
    { now: () => NOW, grade: { settings, resetPlayer } }
  );

const voteOf = async (userId: number) =>
  (
    await pg.query<Record<string, unknown>>(
      `SELECT "itemId",verdict,consequence,gold,"settledAt" FROM "KnightsVote" WHERE "playerId"=$1`,
      [userId]
    )
  ).rows;

describe('serving probation checks', () => {
  it('never serves a probation check at a share of 0, even with no active check left', async () => {
    await seedPlayer(pg, 1);
    await reference(10, 'probation');
    expect(await pick(1)).toBeNull();
    expect(await pick(1, 0)).toBeNull();
    expect(await pick(1, 1)).not.toBeNull();
  });

  it(
    'draws the pool by the share and falls back to the other when the first has none',
    { timeout: 30_000 },
    async () => {
      const probation = await reference(10, 'probation');
      const active = await reference(11, 'active');
      const served = new Map<number, number>();
      for (let user = 1; user <= 60; user++) {
        await seedPlayer(pg, user);
        const id = (await pick(user, 0.5))?.referenceId as number;
        served.set(id, (served.get(id) ?? 0) + 1);
      }
      expect(served.get(probation)).toBeGreaterThan(15);
      expect(served.get(active)).toBeGreaterThan(15);

      expect((await pick(1, 1))?.referenceId).toBe(probation);
      await pg.query(`UPDATE "KnightsReferenceImage" SET status='retired' WHERE id=$1`, [
        probation,
      ]);
      expect((await pick(1, 1))?.referenceId).toBe(active);
    }
  );

  it('never serves a probation check to a player who voted on its image in the queue', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await reference(10, 'probation');
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES (77,1,$1,$2,10,'Knight','4',1)`,
      [NOW.toISOString(), Q]
    );
    expect(await pick(1, 1)).toBeNull();
    expect(await pick(2, 1)).not.toBeNull();
  });
});

describe('serving probation as the fallback', () => {
  it(
    'serves a probation check when active checks come first but none is left',
    { timeout: 30_000 },
    async () => {
      const probation = await reference(10, 'probation');
      for (let user = 1; user <= 20; user++) {
        await seedPlayer(pg, user);
        expect((await pick(user, 0.01))?.referenceId).toBe(probation);
      }
    }
  );
});

describe('answering a probation check', () => {
  const gold = async (userId: number) =>
    (
      await pg.query<{ goldPending: number; goldEarned: number }>(
        `SELECT "goldPending","goldEarned" FROM "NewOrderPlayer" WHERE "userId"=$1`,
        [userId]
      )
    ).rows[0];

  it('releases the pending gold an ungraded answer recorded, and pays none', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    // Control: an active check's answer holds pending gold until it is graded.
    const active = await reference(11, 'active');
    await answerHiddenCheck(
      db,
      { userId: 2, referenceId: active, answer: '4' },
      { now: () => NOW }
    );
    expect((await gold(2)).goldPending).toBeGreaterThan(0);

    const ref = await reference(10, 'probation');
    await answerHiddenCheck(db, { userId: 1, referenceId: ref, answer: '4' }, { now: () => NOW });
    expect(await gold(1)).toEqual({ goldPending: 0, goldEarned: 0 });
  });

  it('grades nobody: a wrong answer is settled inconclusive at once, with no warning, smite or miss', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, 'probation', '16');

    expect(await answerGraded(1, ref, '1')).toEqual({
      status: 'recorded',
      check: { verdict: 'inconclusive', consequence: null, smites: 0, reset: false },
    });
    expect(await voteOf(1)).toEqual([
      expect.objectContaining({
        itemId: hiddenItemId(ref),
        verdict: 'inconclusive',
        consequence: null,
        gold: 0,
        settledAt: expect.any(Date),
      }),
    ]);
    expect((await pg.query(`SELECT 1 FROM "NewOrderSmite"`)).rows).toHaveLength(0);
    expect(
      (await pg.query(`SELECT answers, failures FROM "KnightsReferenceImage" WHERE id=$1`, [ref]))
        .rows
    ).toEqual([{ answers: 0, failures: 0 }]);
  });

  it('is not graded later either, once the check is promoted', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, 'probation', '16');
    await answerHiddenCheck(db, { userId: 1, referenceId: ref, answer: '1' }, { now: () => NOW });
    await pg.query(`UPDATE "KnightsReferenceImage" SET status='active' WHERE id=$1`, [ref]);

    await settleHiddenChecks(db, {
      now: new Date(NOW.getTime() + 3_600_000),
      settings,
      resetPlayer,
    });
    expect(await voteOf(1)).toEqual([
      expect.objectContaining({ verdict: 'inconclusive', consequence: null }),
    ]);
  });

  it('refuses a check that is neither active nor probation', async () => {
    await seedPlayer(pg, 1);
    for (const [imageId, status] of [
      [10, 'pending'],
      [11, 'retired'],
    ] as const) {
      const ref = await reference(imageId, status);
      expect(await answerGraded(1, ref, '4')).toEqual({
        status: 'rejected',
        reason: 'unavailable',
      });
    }
    expect(await voteOf(1)).toEqual([]);
  });
});

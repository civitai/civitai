import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { counterValue } from '../../../test/metrics';
import { createQueueDb } from '../../../test/pglite-kysely';
import { lockImage, seedImage } from '../../../test/seed';
import {
  applyPendingResolutions,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import {
  castReviewVote,
  nextReview,
  openReview,
  sendToInquisitor,
  sweepMissingReviews,
} from './review.service';

vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const MOD_A = 900;
const MOD_B = 901;
const MOD_C = 902;

let pg: PGlite;
let db: Kysely<DB>;

/** Writes the Knights lock the way the main app does, so the image reads as Knights-applied. */
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async ({ imageId, value }) => {
  await lockImage(pg, imageId, { reason: KNIGHTS_VOTE_NSFW_LEVEL_REASON, level: Number(value) });
  return { outcome: 'applied' };
});
const deps = (): QueueDeps => ({ applyConsensus, now: () => NOW });
const voteDeps = { now: () => NOW, poolCap: 500 };

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  applyConsensus.mockClear();
  await pg.exec(
    `TRUNCATE "KnightsInquisitorVote","KnightsInquisitorReview","KnightsReferenceImage","KnightsVote","KnightsQueueItem","NewOrderPlayer","Image","Post","ImageReport","Report" RESTART IDENTITY CASCADE`
  );
});

/** A rating item the players settled at `value`, still to be written back. */
async function settled(
  imageId: number,
  { value = '4', level = 4, owner = null as number | null, questionKey = Q, hidden = false } = {}
) {
  await seedImage(pg, imageId, { nsfwLevel: level, userId: owner });
  const r = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status","resolvedValue","resolvedAt","resolvedBy","resolvedFromLevel","isHiddenCheck")
     VALUES ($1,$2,'scan-sample','Knight',3,'Resolved',$3,$4,1,$5,$6) RETURNING id`,
    [questionKey, imageId, value, NOW, level, hidden]
  );
  return r.rows[0].id;
}
/** A settled item already written back, with its review open. */
async function reviewed(imageId: number, opts: Parameters<typeof settled>[1] = {}) {
  const itemId = await settled(imageId, opts);
  await applyPendingResolutions(db, deps());
  return (await reviewOf(itemId))!.id;
}
const reviewOf = async (itemId: number) =>
  (
    await pg.query<{
      id: number;
      status: string;
      consensusValue: string;
      confirmedValue: string | null;
      closedAt: Date | null;
    }>(
      `SELECT id,status,"consensusValue","confirmedValue","closedAt" FROM "KnightsInquisitorReview" WHERE "queueItemId"=$1`,
      [itemId]
    )
  ).rows[0];
const reviewRow = async (id: number) =>
  (
    await pg.query<{ status: string; confirmedValue: string | null; closedAt: Date | null }>(
      `SELECT status,"confirmedValue","closedAt" FROM "KnightsInquisitorReview" WHERE id=$1`,
      [id]
    )
  ).rows[0];
const votesOn = async (reviewId: number) =>
  (
    await pg.query<{ moderatorId: number; answer: string }>(
      `SELECT "moderatorId",answer FROM "KnightsInquisitorVote" WHERE "reviewId"=$1 ORDER BY "moderatorId"`,
      [reviewId]
    )
  ).rows;
const pool = async () =>
  (
    await pg.query<{ imageId: number; pool: string; source: string; answer: string }>(
      `SELECT "imageId",pool,source,answer FROM "KnightsReferenceImage" ORDER BY "imageId"`
    )
  ).rows;
const vote = (reviewId: number, moderatorId: number, answer: string) =>
  castReviewVote(db, { reviewId, moderatorId, answer }, voteDeps);

describe('opening reviews', () => {
  it('opens one review when a rating item is written back, at the settled value, and only once', async () => {
    const itemId = await settled(1, { value: '8', level: 4 });
    await applyPendingResolutions(db, deps());
    expect(await reviewOf(itemId)).toMatchObject({ status: 'open', consensusValue: '8' });
    expect(await openReview(db, itemId, NOW)).toBe(false);
    expect(
      (await pg.query(`SELECT count(*)::int n FROM "KnightsInquisitorReview"`)).rows[0]
    ).toEqual({ n: 1 });
  });

  it('opens none for a yes/no item, a hidden check, or an item that was rerouted instead of written', async () => {
    await pg.query(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.yesno.x','bool','?','[]')`
    );
    const yesNo = await settled(1, { questionKey: 'knights.yesno.x', value: 'yes' });
    const hidden = await settled(2, { hidden: true });
    const moved = await settled(3, { level: 4 });
    await pg.query(`UPDATE "Image" SET "nsfwLevel"=16 WHERE id=3`);
    await applyPendingResolutions(db, deps());
    for (const id of [yesNo, hidden, moved]) expect(await reviewOf(id)).toBeUndefined();
  });

  it('keeps the write-back when opening the review fails, and the sweep opens it later', async () => {
    const itemId = await settled(1);
    await pg.query(
      `ALTER TABLE "KnightsInquisitorReview" ADD CONSTRAINT block_insert CHECK ("imageId" < 0) NOT VALID`
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await applyPendingResolutions(db, deps())).toMatchObject({ applied: 1 });
    await pg.query(`ALTER TABLE "KnightsInquisitorReview" DROP CONSTRAINT block_insert`);
    expect(
      (
        await pg.query(
          `SELECT "appliedAt" IS NOT NULL AS applied FROM "KnightsQueueItem" WHERE id=$1`,
          [itemId]
        )
      ).rows[0]
    ).toEqual({ applied: true });
    expect(await reviewOf(itemId)).toBeUndefined();

    expect(await sweepMissingReviews(db, { now: NOW })).toBe(1);
    expect(await reviewOf(itemId)).toMatchObject({ status: 'open' });
    expect(await sweepMissingReviews(db, { now: NOW })).toBe(0);
  });

  it('leaves an item applied before the sweep window alone', async () => {
    const itemId = await settled(1);
    await pg.query(`UPDATE "KnightsQueueItem" SET "appliedAt"=$1, status='Resolved' WHERE id=$2`, [
      new Date(NOW.getTime() - 30 * 86_400_000),
      itemId,
    ]);
    expect(await sweepMissingReviews(db, { now: NOW })).toBe(0);
  });
});

describe('serving reviews to moderators', () => {
  it('serves reviews with one vote before reviews with none, then oldest first, never one the mod voted on', async () => {
    const first = await reviewed(1);
    const second = await reviewed(2);
    const voted = await reviewed(3);
    await vote(voted, MOD_B, '4');
    await vote(first, MOD_A, '4');

    expect((await nextReview(db, { moderatorId: MOD_C }))?.reviewId).toBe(first);
    expect((await nextReview(db, { moderatorId: MOD_A }))?.reviewId).toBe(voted);
    expect((await nextReview(db, { moderatorId: MOD_B }))?.reviewId).toBe(first);
    await vote(first, MOD_B, '4');
    expect((await nextReview(db, { moderatorId: MOD_B }))?.reviewId).toBe(second);
  });

  it('never serves a moderator a review of their own image', async () => {
    await reviewed(1, { owner: MOD_A });
    expect(await nextReview(db, { moderatorId: MOD_A })).toBeNull();
    expect(await nextReview(db, { moderatorId: MOD_B })).not.toBeNull();
  });
});

describe('voting', () => {
  it('records a first vote and keeps the review open; the same mod cannot vote twice', async () => {
    const id = await reviewed(1);
    expect(await vote(id, MOD_A, '4')).toEqual({ status: 'recorded' });
    expect(await vote(id, MOD_A, '8')).toEqual({ status: 'rejected', reason: 'already-voted' });
    expect(await votesOn(id)).toEqual([{ moderatorId: MOD_A, answer: '4' }]);
    expect((await reviewRow(id)).status).toBe('open');
  });

  it('refuses a level outside the rating options, Blocked included, and a vote on their own image', async () => {
    const id = await reviewed(1, { owner: MOD_A });
    expect(await vote(id, MOD_B, '32')).toEqual({ status: 'rejected', reason: 'bad-answer' });
    expect(await vote(id, MOD_B, '3')).toEqual({ status: 'rejected', reason: 'bad-answer' });
    expect(await vote(id, MOD_A, '4')).toEqual({ status: 'rejected', reason: 'own-image' });
    expect(await votesOn(id)).toEqual([]);
  });

  it('confirms on a second agreeing vote at the image level and adds the image to the pool, in one go', async () => {
    const id = await reviewed(1);
    const before = await counterValue('knights_inquisitor_reviews_closed_total', {
      outcome: 'confirmed',
    });
    await vote(id, MOD_A, '4');
    expect(await vote(id, MOD_B, '4')).toEqual({ status: 'confirmed' });
    expect(await reviewRow(id)).toMatchObject({
      status: 'confirmed',
      confirmedValue: '4',
      closedAt: expect.any(Date),
    });
    expect(await pool()).toEqual([
      { imageId: 1, pool: 'skillCheck', source: 'inquisitor', answer: '4' },
    ]);
    expect(
      await counterValue('knights_inquisitor_reviews_closed_total', { outcome: 'confirmed' })
    ).toBe(before + 1);
  });

  it('rolls the closing vote back when the pool insert fails', async () => {
    const id = await reviewed(1);
    await vote(id, MOD_A, '4');
    await pg.query(
      `ALTER TABLE "KnightsReferenceImage" ADD CONSTRAINT block_insert CHECK ("imageId" < 0) NOT VALID`
    );
    await expect(vote(id, MOD_B, '4')).rejects.toThrow();
    await pg.query(`ALTER TABLE "KnightsReferenceImage" DROP CONSTRAINT block_insert`);
    expect(await votesOn(id)).toEqual([{ moderatorId: MOD_A, answer: '4' }]);
    expect((await reviewRow(id)).status).toBe('open');
  });

  it('splits on a second vote that disagrees: no check, the image untouched, both votes kept', async () => {
    const id = await reviewed(1);
    await vote(id, MOD_A, '4');
    expect(await vote(id, MOD_B, '8')).toEqual({ status: 'split' });
    expect(await reviewRow(id)).toMatchObject({ status: 'split', confirmedValue: null });
    expect(await pool()).toEqual([]);
    expect((await pg.query(`SELECT "nsfwLevel" FROM "Image" WHERE id=1`)).rows[0]).toEqual({
      nsfwLevel: 4,
    });
    expect(await votesOn(id)).toHaveLength(2);
  });

  it('refuses a third vote on a closed review and writes nothing', async () => {
    const id = await reviewed(1);
    await vote(id, MOD_A, '4');
    await vote(id, MOD_B, '8');
    expect(await vote(id, MOD_C, '4')).toEqual({ status: 'rejected', reason: 'not-open' });
    expect(await votesOn(id)).toHaveLength(2);
  });

  it('refuses an agreeing pair at another level until the override can be written', async () => {
    const id = await reviewed(1);
    await vote(id, MOD_A, '8');
    expect(await vote(id, MOD_B, '8')).toEqual({
      status: 'rejected',
      reason: 'override-unavailable',
    });
    expect(await votesOn(id)).toEqual([{ moderatorId: MOD_A, answer: '8' }]);
    expect((await reviewRow(id)).status).toBe('open');
  });

  it('lets exactly one of two racing second votes close the review', async () => {
    const { pg: pg2, db: serial } = await createQueueDb({ serialize: true });
    await seedImage(pg2, 1);
    await pg2.query(
      `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status","resolvedValue","resolvedAt","resolvedBy","appliedAt") VALUES ($1,1,'t','Knight',3,'Resolved','4',$2,1,$2)`,
      [Q, NOW]
    );
    await lockImage(pg2, 1, { reason: KNIGHTS_VOTE_NSFW_LEVEL_REASON, level: 4 });
    await pg2.query(
      `INSERT INTO "KnightsInquisitorReview" ("queueItemId","imageId","questionKey","consensusValue") VALUES (1,1,$1,'4')`,
      [Q]
    );
    await castReviewVote(serial, { reviewId: 1, moderatorId: MOD_A, answer: '4' }, voteDeps);
    const results = await Promise.all(
      [MOD_B, MOD_C].map((m) =>
        castReviewVote(serial, { reviewId: 1, moderatorId: m, answer: '4' }, voteDeps)
      )
    );
    expect(results.map((r) => r.status).sort()).toEqual(['confirmed', 'rejected']);
    expect(
      (await pg2.query(`SELECT count(*)::int n FROM "KnightsInquisitorVote"`)).rows[0]
    ).toEqual({ n: 2 });
    await pg2.close();
  }, 30_000);

  it('never writes a ledger vote, XP, gold or a player row for a moderator', async () => {
    const id = await reviewed(1);
    await vote(id, MOD_A, '4');
    await vote(id, MOD_B, '4');
    expect((await pg.query(`SELECT count(*)::int n FROM "KnightsVote"`)).rows[0]).toEqual({ n: 0 });
    expect((await pg.query(`SELECT count(*)::int n FROM "NewOrderPlayer"`)).rows[0]).toEqual({
      n: 0,
    });
  });
});

describe('excluding reviews', () => {
  const causes: [string, () => Promise<unknown>][] = [
    ['a moderator ruled on the image', () => lockImage(pg, 1, { reason: 'Moderator', level: 4 })],
    ['the image was blocked', () => pg.query(`UPDATE "Image" SET ingestion='Blocked' WHERE id=1`)],
    [
      'the image moved off the consensus',
      () => lockImage(pg, 1, { reason: KNIGHTS_VOTE_NSFW_LEVEL_REASON, level: 8 }),
    ],
    [
      'the image is under a pending report',
      async () => {
        await pg.query(`INSERT INTO "Report" ("id","status") VALUES (60,'Pending')`);
        await pg.query(`INSERT INTO "ImageReport" ("reportId","imageId") VALUES (60,1)`);
      },
    ],
  ];

  it.each(causes)('excludes at serve when %s, and serves the next one', async (_label, cause) => {
    const id = await reviewed(1);
    const next = await reviewed(2);
    await cause();
    expect((await nextReview(db, { moderatorId: MOD_A }))?.reviewId).toBe(next);
    expect((await reviewRow(id)).status).toBe('excluded');
  });

  it.each(causes)('excludes at vote when %s and records no vote', async (_label, cause) => {
    const id = await reviewed(1);
    await cause();
    expect(await vote(id, MOD_A, '4')).toEqual({ status: 'excluded' });
    expect(await votesOn(id)).toEqual([]);
    expect((await reviewRow(id)).status).toBe('excluded');
  });
});

describe('sending a review to the Inquisitors', () => {
  it('opens a new Inquisitor item, excludes the review, and leaves the settled item and its votes as they were', async () => {
    const itemId = await settled(1);
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","gold","xp","settledAt")
       VALUES ($1,5,$2,$3,1,'Knight','4',1,'correct',3,10,$2)`,
      [itemId, NOW, Q]
    );
    await applyPendingResolutions(db, deps());
    const reviewId = (await reviewOf(itemId))!.id;
    const snapshot = async () => [
      (await pg.query(`SELECT * FROM "KnightsQueueItem" WHERE id=$1`, [itemId])).rows,
      (await pg.query(`SELECT * FROM "KnightsVote"`)).rows,
    ];
    const before = await snapshot();

    expect(
      await sendToInquisitor(db, { reviewId, moderatorId: MOD_A }, { now: () => NOW })
    ).toEqual({
      status: 'sent',
    });

    expect(await snapshot()).toEqual(before);
    expect((await reviewRow(reviewId)).status).toBe('excluded');
    const created = await pg.query(
      `SELECT status,"minRank","escalationReason",meta->>'escalatedFromLevel' AS "from" FROM "KnightsQueueItem" WHERE id<>$1`,
      [itemId]
    );
    expect(created.rows).toEqual([
      { status: 'Inquisitor', minRank: 'Inquisitor', escalationReason: 'blocked', from: '4' },
    ]);
  });

  it('refuses a review that is no longer open', async () => {
    const id = await reviewed(1);
    await vote(id, MOD_A, '4');
    await vote(id, MOD_B, '8');
    expect(
      await sendToInquisitor(db, { reviewId: id, moderatorId: MOD_C }, { now: () => NOW })
    ).toEqual({
      status: 'rejected',
      reason: 'not-open',
    });
  });
});

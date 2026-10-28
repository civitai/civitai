import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import { PROGRESSION } from './config';
import { listJudgments } from './judgments';

const NOW = new Date('2026-12-15T12:00:00Z');
let pg: PGlite;
let db: Kysely<DB>;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => ({ outcome: 'applied' }));
const depsAt = (now: Date): QueueDeps => ({ applyConsensus, now: () => now });

async function judge(imageId: number, at: Date, userId = 1) {
  await seedImage(pg, imageId);
  const id = await enqueueItem(
    db,
    { questionKey: 'knights.image.nsfwLevel', imageId, source: 'test', expiresAt: null },
    NOW
  );
  await castVote(db, { userId, itemId: id, answer: '4' }, depsAt(at));
  return id;
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY`
  );
  await pg.exec(
    `INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES (1,'Knight'),(2,'Knight')`
  );
});

describe('listJudgments', () => {
  it('lists only my votes, newest first, with the answer label and what each paid', async () => {
    const older = await judge(10, new Date('2026-12-15T10:00:00Z'));
    const newer = await judge(11, new Date('2026-12-15T11:00:00Z'));
    await judge(12, new Date('2026-12-15T11:30:00Z'), 2);

    const { judgments, hasMore } = await listJudgments(db, 1, { page: 1 });

    expect(hasMore).toBe(false);
    expect(judgments.map((j) => j.itemId)).toEqual([newer, older]);
    expect(judgments[0]).toMatchObject({
      imageKey: 'key-11',
      status: 'pending',
      xp: PROGRESSION.voteXp,
      gold: PROGRESSION.baseGold,
    });
    expect(judgments[0].answerLabel).not.toBe('4');
  });

  it('pages and reports whether older votes remain', async () => {
    for (let i = 0; i < 3; i++) await judge(10 + i, new Date(`2026-12-15T1${i}:00:00Z`));

    const first = await listJudgments(db, 1, { page: 1, pageSize: 2 });
    const second = await listJudgments(db, 1, { page: 2, pageSize: 2 });

    expect(first.judgments).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.judgments).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it('hides the thumbnail of an image that is no longer servable and maps the verdicts', async () => {
    const id = await judge(10, NOW);
    await pg.exec(`UPDATE "Image" SET "blockedFor"='x'`);
    await pg.exec(
      `UPDATE "KnightsVote" SET verdict='failed', "settledAt"=now() WHERE "itemId"=${id}`
    );

    const [row] = (await listJudgments(db, 1, { page: 1 })).judgments;

    expect(row.imageKey).toBeNull();
    expect(row.status).toBe('wrong');
  });

  it('shows a vote as pending until it is settled, even once graded', async () => {
    const id = await judge(10, NOW);
    await pg.exec(`UPDATE "KnightsVote" SET verdict='correct' WHERE "itemId"=${id}`);
    expect((await listJudgments(db, 1, { page: 1 })).judgments[0].status).toBe('pending');

    await pg.exec(`UPDATE "KnightsVote" SET "settledAt"=now() WHERE "itemId"=${id}`);
    expect((await listJudgments(db, 1, { page: 1 })).judgments[0].status).toBe('correct');
  });
});

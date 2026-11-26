import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { moderatorStats, reviewSidebar } from './context';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const MOD = 900;
const OTHER = 901;

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsInquisitorVote","KnightsInquisitorReview","KnightsVote","KnightsQueueItem","Image","Post","User","TagsOnImageDetails","Tag" RESTART IDENTITY CASCADE`
  );
});

async function review(imageId: number, status = 'open', consensus = '4') {
  await seedImage(pg, imageId, { nsfwLevel: Number(consensus), userId: 77 });
  const item = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status","resolvedValue","appliedAt") VALUES ($1,$2,'t','Templar',3,'Resolved',$3,$4) RETURNING id`,
    [Q, imageId, consensus, NOW]
  );
  const r = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsInquisitorReview" ("queueItemId","imageId","questionKey","consensusValue","status") VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [item.rows[0].id, imageId, Q, consensus, status]
  );
  return { reviewId: r.rows[0].id, itemId: item.rows[0].id };
}
const playerVote = (itemId: number, playerId: number, answer: string, stage: string, weight = 1) =>
  pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight") VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
    [itemId, playerId, NOW, Q, stage, answer, weight]
  );
const modVote = (reviewId: number, moderatorId: number, answer: string, at = NOW) =>
  pg.query(
    `INSERT INTO "KnightsInquisitorVote" ("reviewId","moderatorId","answer","createdAt") VALUES ($1,$2,$3,$4)`,
    [reviewId, moderatorId, answer, at]
  );

describe('reviewSidebar', () => {
  it('shows the consensus and current level, the counted votes by answer and stage, and links to the image', async () => {
    const { itemId } = await review(1);
    await pg.query(`INSERT INTO "User" ("id","username") VALUES (77,'maker')`);
    await pg.query(`UPDATE "Image" SET meta='{"prompt":"a castle at dusk"}' WHERE id=1`);
    await playerVote(itemId, 1, '4', 'Knight');
    await playerVote(itemId, 2, '4', 'Templar', 2);
    await playerVote(itemId, 3, '8', 'Knight');
    await playerVote(itemId, 4, '8', 'Knight', 0);
    await pg.query(`INSERT INTO "Tag" ("id","name") VALUES (1,'castle'),(2,'dusk'),(3,'hidden')`);
    await pg.query(
      `INSERT INTO "TagsOnImageDetails" ("imageId","tagId","disabled","confidence") VALUES (1,1,false,90),(1,2,false,70),(1,3,true,99)`
    );

    const sidebar = await reviewSidebar(db, {
      queueItemId: itemId,
      imageId: 1,
      consensusValue: '4',
      currentLevel: 4,
    });

    expect(sidebar).toMatchObject({
      consensus: 'R',
      current: 'R',
      prompt: 'a castle at dusk',
      tags: ['castle', 'dusk'],
      creator: { username: 'maker', url: expect.stringMatching(/\/user\/maker$/) },
      imageUrl: 'https://civitai.red/images/1',
      postUrl: expect.stringMatching(/\/posts\/1$/),
    });
    expect(sidebar.votes).toEqual([
      {
        answer: '4',
        label: 'R',
        votes: 2,
        weight: 3,
        stages: [
          { stage: 'Knight', votes: 1 },
          { stage: 'Templar', votes: 1 },
        ],
      },
      { answer: '8', label: 'X', votes: 1, weight: 1, stages: [{ stage: 'Knight', votes: 1 }] },
    ]);
  });
});

describe('moderatorStats', () => {
  it("counts this mod's votes this week, the reviews still waiting on them, and how often they agreed with the other mod", async () => {
    const a = await review(1, 'confirmed');
    const b = await review(2, 'split');
    const c = await review(3, 'open');
    const d = await review(4, 'open');
    await review(5, 'excluded');
    await modVote(a.reviewId, MOD, '4');
    await modVote(a.reviewId, OTHER, '4');
    await modVote(b.reviewId, MOD, '4');
    await modVote(b.reviewId, OTHER, '8');
    await modVote(c.reviewId, MOD, '4', new Date(NOW.getTime() - 10 * 86_400_000));
    await modVote(d.reviewId, OTHER, '4');

    expect(await moderatorStats(db, { moderatorId: MOD, now: NOW })).toEqual({
      votesThisWeek: 2,
      waiting: 1,
      waitingMore: false,
      agreementRate: 0.5,
    });
    expect(await moderatorStats(db, { moderatorId: 999, now: NOW })).toEqual({
      votesThisWeek: 0,
      waiting: 2,
      waitingMore: false,
      agreementRate: null,
    });
  });
});

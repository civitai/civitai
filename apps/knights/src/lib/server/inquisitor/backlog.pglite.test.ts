import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { createQueueDb } from '../../../test/pglite-kysely';
import { lockImage, seedImage } from '../../../test/seed';
import {
  closeIneligibleReviews,
  expireBeyondCap,
  expireCandidates,
  ineligibleSweepCandidates,
  nextReview,
  sweepMissingReviews,
} from './review.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsInquisitorVote","KnightsInquisitorReview","KnightsQueueItem","Image","Post" RESTART IDENTITY CASCADE`
  );
});

/** An item written back `appliedMinutesAgo`, its image Knights-locked at R, and (unless `review` is false) its open review. */
async function item(
  id: number,
  { appliedMinutesAgo = 10, review = true }: { appliedMinutesAgo?: number; review?: boolean } = {}
) {
  await seedImage(pg, id);
  await lockImage(pg, id, { reason: KNIGHTS_VOTE_NSFW_LEVEL_REASON, level: 4 });
  await pg.query(
    `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","status","resolvedValue","appliedAt") VALUES ($1,$2,$1,'t','Knight',3,'Resolved','4',$3)`,
    [id, Q, minutesAgo(appliedMinutesAgo)]
  );
  if (review)
    await pg.query(
      `INSERT INTO "KnightsInquisitorReview" ("id","queueItemId","imageId","questionKey","consensusValue","createdAt") VALUES ($1,$1,$1,$2,'4',$3)`,
      [id, Q, minutesAgo(appliedMinutesAgo)]
    );
}
const statuses = async () =>
  Object.fromEntries(
    (
      await pg.query<{ id: number; status: string }>(
        `SELECT id, status FROM "KnightsInquisitorReview" ORDER BY id`
      )
    ).rows.map((r) => [r.id, r.status])
  );

describe('the open backlog cap', () => {
  it('expires the oldest unvoted reviews beyond the cap, never a voted one, at most its limit per run', async () => {
    for (const id of [1, 2, 3, 4, 5]) await item(id, { appliedMinutesAgo: 100 - id });
    await pg.query(
      `INSERT INTO "KnightsInquisitorVote" ("reviewId","moderatorId","answer") VALUES (1,9,'4')`
    );

    expect(await expireBeyondCap(db, { now: NOW, maxOpen: 2, limit: 1 })).toBe(1);
    expect(await statuses()).toMatchObject({
      1: 'open',
      2: 'expired',
      3: 'open',
      4: 'open',
      5: 'open',
    });

    expect(await expireBeyondCap(db, { now: NOW, maxOpen: 2 })).toBe(2);
    expect(await statuses()).toEqual({
      1: 'open',
      2: 'expired',
      3: 'expired',
      4: 'expired',
      5: 'open',
    });
    expect(await expireBeyondCap(db, { now: NOW, maxOpen: 2 })).toBe(0);
  });

  it('never expires a review that gets a vote after the candidates are picked', async () => {
    for (const id of [1, 2, 3]) await item(id, { appliedMinutesAgo: 100 - id });
    let voted = false;
    // A vote lands right after the candidate read, before the update.
    const racing = db.withPlugin({
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        const rows = args.result.rows as Record<string, unknown>[];
        if (!voted && rows.length > 0 && Object.keys(rows[0]).join() === 'id') {
          voted = true;
          await pg.query(
            `INSERT INTO "KnightsInquisitorVote" ("reviewId","moderatorId","answer") VALUES ($1,9,'4')`,
            [rows[0].id]
          );
        }
        return args.result;
      },
    });
    expect(await expireBeyondCap(racing, { now: NOW, maxOpen: 1 })).toBe(1);
    expect(await statuses()).toEqual({ 1: 'open', 2: 'expired', 3: 'open' });
  });

  it('takes its candidates with SKIP LOCKED, so a review a vote holds is passed over', () => {
    expect(expireCandidates(db, 10).compile().sql).toMatch(/for update skip locked/i);
  });
});

describe('serving order', () => {
  it('serves a review with a vote first, then the newest unvoted', async () => {
    for (const id of [1, 2, 3]) await item(id, { appliedMinutesAgo: 100 - id });
    expect(await nextReview(db, { moderatorId: 7, now: NOW })).toMatchObject({ reviewId: 3 });
    await pg.query(
      `INSERT INTO "KnightsInquisitorVote" ("reviewId","moderatorId","answer") VALUES (1,9,'4')`
    );
    expect(await nextReview(db, { moderatorId: 7, now: NOW })).toMatchObject({ reviewId: 1 });
  });
});

describe('the entry sweep', () => {
  it('opens reviews only for items written back within its window, newest first, at most its limit', async () => {
    await item(1, { appliedMinutesAgo: 30, review: false });
    await item(2, { appliedMinutesAgo: 20, review: false });
    await item(3, { appliedMinutesAgo: 10, review: false });
    await item(4, { appliedMinutesAgo: 5 * 60, review: false });

    expect(await sweepMissingReviews(db, { now: NOW, limit: 2 })).toBe(2);
    const opened = (
      await pg.query<{ queueItemId: number }>(
        `SELECT "queueItemId" FROM "KnightsInquisitorReview" ORDER BY 1`
      )
    ).rows.map((r) => r.queueItemId);
    expect(opened).toEqual([2, 3]);
    expect(await sweepMissingReviews(db, { now: NOW })).toBe(1);
    expect(await sweepMissingReviews(db, { now: NOW })).toBe(0);
  });
});

describe('the close sweep', () => {
  it('checks at most its batch per run, closes the permanent holds among them, and rotates by when it last checked', async () => {
    for (const id of [1, 2, 3, 4]) await item(id);
    await pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id IN (2, 4)`);

    expect(await closeIneligibleReviews(db, { now: NOW, batch: 2 })).toBe(1);
    expect(await statuses()).toEqual({ 1: 'open', 2: 'excluded', 3: 'open', 4: 'open' });
    const checked = await pg.query(
      `SELECT id FROM "KnightsInquisitorReview" WHERE "checkedAt" IS NOT NULL ORDER BY id`
    );
    // The eligible one is stamped; the closed one needs no stamp.
    expect(checked.rows).toEqual([{ id: 1 }]);

    // The next run takes the ones never checked.
    expect(
      await closeIneligibleReviews(db, { now: new Date(NOW.getTime() + 60_000), batch: 2 })
    ).toBe(1);
    expect(await statuses()).toEqual({ 1: 'open', 2: 'excluded', 3: 'open', 4: 'excluded' });
  });

  it('skips a review a moderator is claiming, rather than waiting on it', async () => {
    await item(1);
    await pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id=1`);
    await pg.query(
      `UPDATE "KnightsInquisitorReview" SET "claimedBy"=9,"claimExpiresAt"=$1 WHERE id=1`,
      [new Date(NOW.getTime() + 60_000)]
    );
    expect(await closeIneligibleReviews(db, { now: NOW })).toBe(0);
    expect(await statuses()).toEqual({ 1: 'open' });
  });

  it('takes its candidates with SKIP LOCKED, so a row locked by a vote is skipped, not waited on', () => {
    const compiled = ineligibleSweepCandidates(db, { now: NOW, batch: 200 }).compile();
    expect(compiled.sql).toMatch(/for update skip locked/i);
    expect(compiled.sql).toMatch(/order by "checkedAt" asc nulls first/i);
  });
});

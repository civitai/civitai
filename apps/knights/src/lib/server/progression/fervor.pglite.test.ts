import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedGradedVotes, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { PROGRESSION } from './config';
import { fervorLedgerOf } from './fervor';
import { ledgerOf } from './progression';

const NOW = new Date('2026-12-15T12:00:00Z');
const RECENT = '2026-12-14 00:00:00';
const STALE = '2026-12-01 00:00:00';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsVote","NewOrderPlayer" RESTART IDENTITY CASCADE`);
});

describe('fervorLedgerOf', () => {
  it('counts every vote cast in the window, past the accuracy window', async () => {
    await seedPlayer(pg, 1);
    const correct = PROGRESSION.accuracyWindow + 100;
    await seedGradedVotes(pg, 1, { correct, failed: 20, at: RECENT });

    expect(await fervorLedgerOf(db, 1, NOW)).toEqual({ correct, graded: correct + 20 });
    expect((await ledgerOf(db, 1)).graded).toBe(PROGRESSION.accuracyWindow);
  });

  it('goes by when a vote was cast: one cast 8 days ago but settled yesterday is out', async () => {
    await seedPlayer(pg, 1);
    await seedGradedVotes(pg, 1, { correct: 3, at: '2026-12-07 00:00:00' });
    await pg.exec(`UPDATE "KnightsVote" SET "settledAt"='2026-12-14 00:00:00'`);
    await seedGradedVotes(pg, 1, { correct: 2, at: '2026-12-08 12:00:00' });

    expect(await fervorLedgerOf(db, 1, NOW)).toEqual({ correct: 2, graded: 2 });
  });

  it('leaves out unsettled votes, inconclusive votes and votes cast before a career reset', async () => {
    await seedPlayer(pg, 1, 'Knight', { startAt: '2026-12-14 12:00:00' });
    await seedGradedVotes(pg, 1, { correct: 4, at: RECENT });
    await seedGradedVotes(pg, 1, { correct: 3, at: '2026-12-15 00:00:00' });
    await pg.exec(
      `UPDATE "KnightsVote" SET "verdict"='inconclusive' WHERE "itemId" = (SELECT min("itemId") FROM "KnightsVote" WHERE "createdAt" >= '2026-12-15')`
    );
    await pg.exec(
      `UPDATE "KnightsVote" SET "settledAt"=NULL WHERE "itemId" = (SELECT max("itemId") FROM "KnightsVote" WHERE "createdAt" >= '2026-12-15')`
    );

    expect(await fervorLedgerOf(db, 1, NOW)).toEqual({ correct: 1, graded: 1 });
  });

  it('does not decay the accuracy ledger: old votes still count there', async () => {
    await seedPlayer(pg, 1);
    await seedGradedVotes(pg, 1, { correct: 3, at: STALE });

    expect(await ledgerOf(db, 1)).toEqual({ correct: 3, graded: 3 });
    expect(await fervorLedgerOf(db, 1, NOW)).toEqual({ correct: 0, graded: 0 });
  });
});

describe('the per-player read', () => {
  it('uses the (playerId, createdAt) index and skips months before the window', async () => {
    await seedPlayer(pg, 1);
    await seedGradedVotes(pg, 1, { correct: 2, at: RECENT });
    // On a two-row table the (playerId, imageId) index ties with this one on the player; take it out so the plan shows this index.
    await pg.exec('DROP INDEX "KnightsVote_playerId_imageId_idx"');
    await pg.exec('SET enable_seqscan = off');
    const plan = (
      await pg.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT count(*) FROM "KnightsVote" v WHERE v."playerId" = 1 AND v."createdAt" >= '2026-12-08'
         AND v."settledAt" IS NOT NULL AND v."verdict" IN ('correct','failed')`
      )
    ).rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    await pg.exec('RESET enable_seqscan');

    expect(plan).toMatch(/KnightsVote_2026_12_playerId_createdAt_idx/);
    expect(plan).not.toMatch(/KnightsVote_2026_11/);
  });
});

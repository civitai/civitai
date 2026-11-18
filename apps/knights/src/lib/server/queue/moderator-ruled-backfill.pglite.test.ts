import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { lockImage, seedImage, seedSettledVote } from '../../../test/seed';
import { enqueueItem, ensureVotePartitions } from './queue.service';

const NOW = new Date('2026-12-15T12:00:00Z');
const script = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../scripts/backfill-moderator-ruled-verdict/${name}`, import.meta.url)
    ),
    'utf8'
  );

let pg: PGlite;
let db: Kysely<DB>;

async function closedItem(
  imageId: number,
  o: {
    reason: string;
    resolvedValue: string | null;
    votes: [string, string][];
    lock?: { reason: string; level: number };
  }
) {
  await seedImage(pg, imageId);
  if (o.lock) await lockImage(pg, imageId, o.lock);
  const id = await enqueueItem(
    db,
    { questionKey: 'knights.image.nsfwLevel', imageId, source: 'test', expiresAt: null },
    NOW
  );
  await pg.query(
    `UPDATE "KnightsQueueItem" SET status='Closed', reason=$2, "resolvedValue"=$3 WHERE id=$1`,
    [id, o.reason, o.resolvedValue]
  );
  for (const [index, [answer, verdict]] of o.votes.entries()) {
    await seedSettledVote(pg, { itemId: id, playerId: index + 1, imageId, answer, verdict });
  }
  return id;
}

const resolvedValues = async () =>
  (
    await pg.query<{ id: number; resolvedValue: string | null }>(
      `SELECT id, "resolvedValue" FROM "KnightsQueueItem" ORDER BY id`
    )
  ).rows;

async function dryRun() {
  const [result] = await pg.exec(script('dry-run.sql'));
  return result.rows[0];
}

async function apply() {
  const results = await pg.exec(script('apply.sql'));
  await pg.exec('COMMIT');
  return results[results.length - 1].affectedRows;
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});

describe('backfill-moderator-ruled-verdict', () => {
  it('classifies rows with the same CTE in the dry run and the apply', () => {
    const sharedCte = (name: string) => {
      const text = script(name);
      const start = text.indexOf('-- shared CTE:');
      const end = text.indexOf('-- end of shared CTE');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    expect(sharedCte('apply.sql')).toBe(sharedCte('dry-run.sql'));
  });

  it('sets the graded level on contradicted rows only, and a second run changes nothing', async () => {
    const tier1 = await closedItem(10, {
      reason: 'moderator-ruled',
      resolvedValue: '2',
      votes: [
        ['2', 'failed'],
        ['2', 'failed'],
        ['1', 'correct'],
      ],
    });
    const consistent = await closedItem(11, {
      reason: 'moderator-ruled',
      resolvedValue: '4',
      votes: [
        ['4', 'correct'],
        ['8', 'failed'],
      ],
    });
    const tier2 = await closedItem(12, {
      reason: 'moderator-ruled',
      resolvedValue: '2',
      votes: [
        ['2', 'failed'],
        ['4', 'failed'],
      ],
      lock: { reason: 'Moderator rating review', level: 1 },
    });
    const levelMatchesAVote = await closedItem(13, {
      reason: 'moderator-ruled',
      resolvedValue: '2',
      votes: [
        ['2', 'failed'],
        ['4', 'failed'],
      ],
      lock: { reason: 'Moderator rating review', level: 4 },
    });
    const earlierModeratorLevel = await closedItem(17, {
      reason: 'moderator-ruled',
      resolvedValue: '8',
      votes: [
        ['2', 'failed'],
        ['4', 'failed'],
      ],
      lock: { reason: 'Moderator rating review', level: 1 },
    });
    const knightsLocked = await closedItem(14, {
      reason: 'moderator-ruled',
      resolvedValue: '2',
      votes: [['2', 'failed']],
      lock: { reason: 'Knights Vote', level: 1 },
    });
    const ungraded = await closedItem(15, {
      reason: 'moderator-ruled',
      resolvedValue: '2',
      votes: [['2', 'inconclusive']],
      lock: { reason: 'Moderator rating review', level: 1 },
    });
    const expired = await closedItem(16, {
      reason: 'expired',
      resolvedValue: null,
      votes: [['2', 'correct']],
    });
    const before = await resolvedValues();
    expect(before.map((row) => row.id)).toEqual([
      tier1,
      consistent,
      tier2,
      levelMatchesAVote,
      earlierModeratorLevel,
      knightsLocked,
      ungraded,
      expired,
    ]);
    const leftAlone = {
      left_several_correct_answers: 0,
      left_ungraded_votes: 1,
      left_image_not_ruled: 1,
      left_level_matches_a_vote: 1,
      left_already_moderator_level: 1,
      left_contradicted: 2,
    };

    expect(await dryRun()).toEqual({
      tier1_to_fix: 1,
      tier2_to_fix: 1,
      consistent: 1,
      ...leftAlone,
      sample: [
        { id: tier1, imageId: 10, resolvedValue: '2', truth: '1', tier: 'tier1' },
        { id: tier2, imageId: 12, resolvedValue: '2', truth: '1', tier: 'tier2' },
      ],
    });

    expect(await apply()).toBe(2);
    expect(await resolvedValues()).toEqual(
      before.map((row) =>
        row.id === tier1 || row.id === tier2 ? { ...row, resolvedValue: '1' } : row
      )
    );

    expect(await dryRun()).toEqual({
      tier1_to_fix: 0,
      tier2_to_fix: 0,
      consistent: 3,
      ...leftAlone,
      sample: [],
    });
    expect(await apply()).toBe(0);
  });
});

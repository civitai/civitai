import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
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
  o: { reason: string; resolvedValue: string | null; votes: [string, string][] }
) {
  await seedImage(pg, imageId);
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
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict")
       VALUES ($1,$2,$3,'knights.image.nsfwLevel',$4,'Knight',$5,1,$6)`,
      [id, index + 1, NOW, imageId, answer, verdict]
    );
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
  const [counts, sample] = await pg.exec(script('dry-run.sql'));
  return { counts: counts.rows[0], sample: sample.rows };
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
  it('sets the graded level on contradicted rows only, and a second run changes nothing', async () => {
    const wrong = await closedItem(10, {
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
    const noCorrectVote = await closedItem(12, {
      reason: 'moderator-ruled',
      resolvedValue: '2',
      votes: [
        ['2', 'failed'],
        ['4', 'failed'],
      ],
    });
    const expired = await closedItem(13, {
      reason: 'expired',
      resolvedValue: null,
      votes: [['2', 'correct']],
    });
    const before = await resolvedValues();

    expect(await dryRun()).toMatchObject({
      counts: {
        to_fix: 1,
        consistent: 1,
        no_correct_vote: 1,
        no_correct_vote_contradicted: 1,
        several_correct_answers: 0,
      },
      sample: [{ id: wrong, resolvedValue: '2', truth: '1' }],
    });

    expect(await apply()).toBe(1);
    expect(await resolvedValues()).toEqual(
      before.map((row) => (row.id === wrong ? { ...row, resolvedValue: '1' } : row))
    );
    expect(before.map((row) => row.id)).toEqual([wrong, consistent, noCorrectVote, expired]);

    expect(await dryRun()).toMatchObject({ counts: { to_fix: 0, consistent: 2 }, sample: [] });
    expect(await apply()).toBe(0);
  });
});

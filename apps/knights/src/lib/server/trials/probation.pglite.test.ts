import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { reviewProbation } from './probation.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","Image","Post" RESTART IDENTITY CASCADE`
  );
});

let nextPlayer = 100;
async function vote(itemId: number, imageId: number, answer: string, playerId = nextPlayer++) {
  await pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
     VALUES ($1,$2,$3,$4,$5,'Knight',$6,1)`,
    [itemId, playerId, NOW.toISOString(), Q, imageId, answer]
  );
  return playerId;
}

/** A hidden check on `imageId` (answer 4), answered with `answers` by new players. */
async function check(
  imageId: number,
  { status = 'probation', source = 'agreement', pool = 'hiddenCheck' } = {},
  answers: string[] = []
) {
  await seedImage(pg, imageId, { nsfwLevel: 4 });
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey","status") VALUES ($1,$2,'4',$3,$4,$5) RETURNING id`,
    [imageId, pool, source, Q, status]
  );
  const id = rows[0].id;
  const players: number[] = [];
  for (const answer of answers) players.push(await vote(-id, imageId, answer));
  return { id, players };
}

const statusOf = async (id: number) =>
  (
    await pg.query<{ status: string }>(`SELECT status FROM "KnightsReferenceImage" WHERE id=$1`, [
      id,
    ])
  ).rows[0].status;

const agree = (n: number, disagree: number) => [
  ...Array(n).fill('4'),
  ...Array(disagree).fill('8'),
];

describe('reviewProbation', () => {
  it('promotes a probation check most of its 5+ players answered exactly, and retires one they did not', async () => {
    const kept = await check(10, {}, agree(3, 2));
    const close = await check(11, {}, [...agree(2, 1), '2', '2']);
    const short = await check(12, {}, agree(4, 0));
    const tie = await check(13, {}, agree(3, 3));

    expect(await reviewProbation(db, { now: NOW })).toEqual({ promoted: 1, retired: 2 });
    expect(await statusOf(kept.id)).toBe('active');
    expect(await statusOf(close.id)).toBe('retired');
    expect(await statusOf(short.id)).toBe('probation');
    expect(await statusOf(tie.id)).toBe('retired');
  });

  it('retires an active harvested or agreement check its 5+ players mostly disagree with, never a core one', async () => {
    const harvested = await check(10, { status: 'active', source: 'harvested' }, agree(2, 3));
    const agreement = await check(11, { status: 'active', source: 'agreement' }, agree(1, 4));
    const core = await check(12, { status: 'active', source: 'core' }, agree(0, 5));
    const fine = await check(13, { status: 'active', source: 'harvested' }, agree(3, 2));
    const few = await check(14, { status: 'active', source: 'harvested' }, agree(0, 4));
    const trials = await check(15, { status: 'probation', pool: 'trials' }, agree(5, 0));

    expect(await reviewProbation(db, { now: NOW })).toEqual({ promoted: 0, retired: 2 });
    expect(await statusOf(harvested.id)).toBe('retired');
    expect(await statusOf(agreement.id)).toBe('retired');
    expect(await statusOf(core.id)).toBe('active');
    expect(await statusOf(fine.id)).toBe('active');
    expect(await statusOf(few.id)).toBe('active');
    expect(await statusOf(trials.id)).toBe('probation');
  });

  it('does not count the votes of players who also voted on the image in the queue', async () => {
    // 4 of 7 agree, but 2 of the 4 made the verdict the check came from: 2 of 5 is no majority.
    const { id, players } = await check(10, {}, agree(4, 3));
    await vote(55, 10, '4', players[0]);
    await vote(55, 10, '4', players[1]);
    // Only queue voters agreeing, the rest too few: never promoted on its own verdict.
    const own = await check(11, {}, agree(5, 0));
    for (const p of own.players.slice(0, 2)) await vote(56, 11, '4', p);

    expect(await reviewProbation(db, { now: NOW })).toEqual({ promoted: 0, retired: 1 });
    expect(await statusOf(id)).toBe('retired');
    expect(await statusOf(own.id)).toBe('probation');
  });
});

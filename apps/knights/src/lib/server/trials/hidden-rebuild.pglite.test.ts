import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import {
  checkedRetireSql,
  inlineSql,
  offlineDb,
  planHiddenRebuild,
  retireIdsQuery,
  retirableIdsQuery,
  retireUnagreedHiddenChecks,
} from './hidden-rebuild.service';

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

type RefOpts = {
  pool?: string;
  source?: string;
  status?: string;
  reason?: string;
  /** Who cast each answer (default: a different player each). */
  players?: number[];
  /** The stored counters (default: from `answers`). */
  counters?: { answers: number; failures: number };
};

/** A reference answered by players: `answers` lists each player's answer. */
async function reference(imageId: number, answer: string, answers: string[], o: RefOpts = {}) {
  await seedImage(pg, imageId, { nsfwLevel: Number(answer) });
  if (o.reason) {
    await pg.query(
      `UPDATE "Image" SET metadata=jsonb_build_object('nsfwLevelReason',$2::text) WHERE id=$1`,
      [imageId, o.reason]
    );
  }
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status","questionKey","answers","failures")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      imageId,
      o.pool ?? 'hiddenCheck',
      answer,
      o.source ?? 'harvested',
      o.status ?? 'active',
      Q,
      o.counters?.answers ?? answers.length,
      o.counters?.failures ?? answers.filter((a) => a !== answer).length,
    ]
  );
  const id = rows[0].id;
  for (const [i, value] of answers.entries()) {
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES ($1,$2,$3,$4,$5,'Knight',$6,1)`,
      [
        -id,
        o.players?.[i] ?? 100 + i,
        new Date(NOW.getTime() + i * 1000).toISOString(),
        Q,
        imageId,
        value,
      ]
    );
  }
  return id;
}

const rows = async () =>
  (
    await pg.query<{ imageId: number; status: string; answers: number; failures: number }>(
      `SELECT "imageId","status","answers","failures" FROM "KnightsReferenceImage" ORDER BY "imageId"`
    )
  ).rows;
const statusOf = async () => Object.fromEntries((await rows()).map((r) => [r.imageId, r.status]));
const agree = (n: number, of: number, answer = '4', other = '8') => [
  ...Array(n).fill(answer),
  ...Array(of - n).fill(other),
];

describe('retireUnagreedHiddenChecks', () => {
  it('keeps only checks at least five players answered, most of them with the known answer', async () => {
    await reference(1, '4', agree(3, 5)); // 3 of 5 agree: kept
    await reference(2, '4', agree(4, 4)); // too few players
    await reference(3, '4', agree(2, 5)); // most disagree
    await reference(4, '4', agree(3, 6)); // a tie is not a majority
    await reference(5, '4', []); // never answered
    await reference(6, '16', agree(5, 6, '16', '4')); // kept, another level

    const result = await retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds: [] });

    expect(await statusOf()).toEqual({
      1: 'active',
      2: 'retired',
      3: 'retired',
      4: 'retired',
      5: 'retired',
      6: 'active',
    });
    expect(result).toEqual({
      before: { live: 6, keep: 2, retire: 4 },
      retired: 4,
      after: { live: 2, keep: 2, retire: 0 },
    });
  });

  it('retires an agreed check when its image is excluded or its ruling came from the moderator queue', async () => {
    await reference(1, '4', agree(5, 5));
    await reference(2, '4', agree(5, 5));
    await reference(3, '4', agree(5, 5), { reason: 'Moderator queue rating' });
    await reference(4, '4', agree(5, 5), { reason: 'Moderator rating review' });

    await retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds: [2] });

    expect(await statusOf()).toEqual({ 1: 'active', 2: 'retired', 3: 'retired', 4: 'active' });
  });

  it('changes only the status of harvested hidden checks: no row is deleted and trials and core are untouched', async () => {
    await reference(1, '4', agree(1, 5));
    await reference(2, '4', [], { pool: 'trials' });
    await reference(3, '4', [], { source: 'core' });
    await reference(4, '4', agree(1, 5), { pool: 'trials' });
    const before = await rows();

    await retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds: [] });

    const after = await rows();
    expect(after.map(({ status, ...rest }) => rest)).toEqual(
      before.map(({ status, ...rest }) => rest)
    );
    expect(await statusOf()).toEqual({ 1: 'retired', 2: 'active', 3: 'active', 4: 'active' });
  });

  it('does nothing more on a second run, and never brings back a retired check', async () => {
    await reference(1, '4', agree(5, 5));
    await reference(2, '4', agree(5, 5), { status: 'retired' });
    await reference(3, '4', agree(0, 5));

    await retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds: [] });
    const second = await retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds: [] });

    expect(second.retired).toBe(0);
    expect(await statusOf()).toEqual({ 1: 'active', 2: 'retired', 3: 'retired' });
  });

  it('plans without writing', async () => {
    await reference(1, '4', agree(5, 5));
    await reference(2, '4', agree(0, 5));

    expect(await planHiddenRebuild(db, { excludeImageIds: [] })).toEqual({
      live: 2,
      keep: 1,
      retire: 1,
      ids: [2],
    });
    expect(await statusOf()).toEqual({ 1: 'active', 2: 'active' });
  });

  it('counts players, not votes, and reads the votes rather than the stored counters', async () => {
    await reference(1, '4', agree(5, 5), { players: [7, 7, 7, 7, 7] }); // one player, five votes
    await reference(2, '4', agree(5, 5), { counters: { answers: 0, failures: 0 } });
    await reference(3, '4', agree(0, 5), { counters: { answers: 50, failures: 0 } });

    await retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds: [] });

    expect(await statusOf()).toEqual({ 1: 'retired', 2: 'active', 3: 'retired' });
  });

  it('retires a pending check players do not agree with and leaves an agreed one as it is', async () => {
    await reference(1, '4', agree(1, 5), { status: 'pending' });
    await reference(2, '4', agree(5, 5), { status: 'pending' });

    await retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds: [] });

    expect(await statusOf()).toEqual({ 1: 'retired', 2: 'pending' });
  });
});

describe('the SQL printed for a run by hand', () => {
  it('selects the planned ids and retires exactly those, with every value written in', async () => {
    await reference(1, '4', agree(5, 5));
    await reference(2, '4', agree(1, 5));
    await reference(3, '4', agree(5, 5));
    await reference(4, '4', []);
    const select = inlineSql(retirableIdsQuery(offlineDb(), { excludeImageIds: [3] }).compile());
    expect(select).not.toMatch(/\$\d/);

    const ids = (await pg.query<{ id: number }>(select)).rows.map((r) => r.id);
    expect(ids).toEqual((await planHiddenRebuild(db, { excludeImageIds: [3] })).ids);
    const update = inlineSql(
      retireIdsQuery(offlineDb(), { now: NOW, excludeImageIds: [3], ids }).compile()
    );
    const { affectedRows } = await pg.query(update);

    expect(affectedRows).toBe(ids.length);
    expect(await statusOf()).toEqual({ 1: 'active', 2: 'retired', 3: 'retired', 4: 'retired' });
  });

  it('retires fewer than planned, never more, when a check gains agreement or arrives in between', async () => {
    const late = await reference(1, '4', agree(4, 4));
    await reference(2, '4', []);
    const ids = (await planHiddenRebuild(db, { excludeImageIds: [] })).ids;
    await reference(3, '4', []); // arrives after the plan
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES ($1,999,$2,$3,1,'Knight','4',1)`,
      [-late, NOW.toISOString(), Q]
    );

    const { affectedRows } = await pg.query(
      inlineSql(retireIdsQuery(offlineDb(), { now: NOW, excludeImageIds: [], ids }).compile())
    );

    expect(ids).toHaveLength(2);
    expect(affectedRows).toBe(1);
    expect(await statusOf()).toEqual({ 1: 'active', 2: 'retired', 3: 'active' });
  });

  it('prints a transaction that commits only when exactly the planned ids were retired', async () => {
    await reference(1, '4', agree(5, 5));
    await reference(2, '4', []);
    await reference(3, '4', []);
    const ids = (await planHiddenRebuild(db, { excludeImageIds: [] })).ids;
    const block = checkedRetireSql(offlineDb(), { now: NOW, excludeImageIds: [], ids });
    expect(block).toMatch(/^BEGIN;\n[\s\S]*\nCOMMIT;$/);
    expect(block).not.toMatch(/\$\d/);

    await pg.exec(block);

    expect(await statusOf()).toEqual({ 1: 'active', 2: 'retired', 3: 'retired' });
  });

  it('rolls the whole transaction back when the count differs from the plan', async () => {
    await reference(1, '4', []);
    await reference(2, '4', []);
    const ids = (await planHiddenRebuild(db, { excludeImageIds: [] })).ids;
    await pg.query(`UPDATE "KnightsReferenceImage" SET status='retired' WHERE "imageId"=1`); // retired elsewhere since
    const block = checkedRetireSql(offlineDb(), { now: NOW, excludeImageIds: [], ids });

    await expect(pg.exec(block)).rejects.toThrow(/division by zero/);
    await pg.exec('ROLLBACK');

    expect(await statusOf()).toEqual({ 1: 'retired', 2: 'active' });
  });
});

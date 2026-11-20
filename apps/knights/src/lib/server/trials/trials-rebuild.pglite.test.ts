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
  retirableIdsQuery,
  retireUnagreedHiddenChecks,
} from './hidden-rebuild.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const trials = { pool: 'trials' as const };

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsApprenticeAnswer","KnightsVote","Image","Post" RESTART IDENTITY CASCADE`
  );
});

let nextPlayer = 100;
/** A reference with answer 4, answered by Acolytes: `answers` lists each one's answer. */
async function reference(
  imageId: number,
  answers: string[],
  o: { pool?: string; source?: string; reason?: string; players?: number[] } = {}
) {
  await seedImage(pg, imageId, { nsfwLevel: 4 });
  if (o.reason) {
    await pg.query(
      `UPDATE "Image" SET metadata=jsonb_build_object('nsfwLevelReason',$2::text) WHERE id=$1`,
      [imageId, o.reason]
    );
  }
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey","explanation")
     VALUES ($1,$2,'4',$3,$4,'x') RETURNING id`,
    [imageId, o.pool ?? 'trials', o.source ?? 'harvested', Q]
  );
  const id = rows[0].id;
  for (const [i, answer] of answers.entries()) {
    await pg.query(
      `INSERT INTO "KnightsApprenticeAnswer" ("playerId","referenceId","imageId","questionKey","answer","correctAnswer","correct")
       VALUES ($1,$2,$3,$4,$5,'4',$6)`,
      [o.players?.[i] ?? nextPlayer++, id, imageId, Q, answer, answer === '4']
    );
  }
  return id;
}

const agree = (n: number, disagree: number) => [
  ...Array(n).fill('4'),
  ...Array(disagree).fill('8'),
];
const statusOf = async (id: number) =>
  (
    await pg.query<{ status: string }>(`SELECT status FROM "KnightsReferenceImage" WHERE id=$1`, [
      id,
    ])
  ).rows[0].status;
const run = (excludeImageIds: number[] = []) =>
  retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds, ...trials });

describe('the trials pool', () => {
  it('keeps only references 5+ Acolytes answered, most of them with the known answer', async () => {
    const kept = await reference(1, agree(3, 2));
    const minority = await reference(2, agree(2, 3));
    const tie = await reference(3, agree(3, 3));
    const few = await reference(4, agree(4, 0));
    const none = await reference(5, []);

    expect(await run()).toEqual({
      before: { live: 5, keep: 1, retire: 4 },
      retired: 4,
      after: { live: 1, keep: 1, retire: 0 },
    });
    expect(await statusOf(kept)).toBe('active');
    for (const id of [minority, tie, few, none]) expect(await statusOf(id)).toBe('retired');
  });

  it('retires an agreed reference whose image is excluded or whose ruling came from the moderator queue', async () => {
    const excluded = await reference(1, agree(5, 0));
    const queue = await reference(2, agree(5, 0), { reason: 'Moderator queue rating' });
    await run([1]);
    expect(await statusOf(excluded)).toBe('retired');
    expect(await statusOf(queue)).toBe('retired');
  });

  it('leaves a pending reference, which waits for a moderator spot-check, alone', async () => {
    const pending = await reference(1, []);
    await pg.query(`UPDATE "KnightsReferenceImage" SET status='pending' WHERE id=$1`, [pending]);
    const active = await reference(2, []);
    await run();
    expect(await statusOf(pending)).toBe('pending');
    expect(await statusOf(active)).toBe('retired');
  });

  it('leaves hidden checks and core references alone, and reads Acolyte answers, not Knight votes', async () => {
    const hidden = await reference(1, [], { pool: 'hiddenCheck' });
    const core = await reference(2, [], { source: 'core' });
    const knightVoted = await reference(3, []);
    for (let p = 0; p < 5; p++) {
      await pg.query(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
         VALUES ($1,$2,$3,$4,3,'Knight','4',1)`,
        [-knightVoted, 500 + p, NOW.toISOString(), Q]
      );
    }
    await run();
    expect(await statusOf(hidden)).toBe('active');
    expect(await statusOf(core)).toBe('active');
    expect(await statusOf(knightVoted)).toBe('retired');
  });

  it('leaves trials references alone on a hidden-check run, and hidden checks alone on a trials run', async () => {
    const trialsRef = await reference(1, []);
    const hidden = await reference(2, [], { pool: 'hiddenCheck' });
    await run();
    expect(await statusOf(hidden)).toBe('active');
    expect(await statusOf(trialsRef)).toBe('retired');

    const trialsRef2 = await reference(3, []);
    await retireUnagreedHiddenChecks(db, { now: NOW, excludeImageIds: [] });
    expect(await statusOf(trialsRef2)).toBe('active');
    expect(await statusOf(hidden)).toBe('retired');
  });

  it('prints a SELECT and a checked transaction that retire exactly the planned trials references', async () => {
    const kept = await reference(1, agree(5, 0));
    const gone = [await reference(2, agree(0, 5)), await reference(3, [])];
    const select = inlineSql(
      retirableIdsQuery(offlineDb(), { excludeImageIds: [], ...trials }).compile()
    );
    const planned = (await pg.query<{ id: number }>(select)).rows.map((r) => r.id);
    expect(planned).toEqual(gone);
    expect((await planHiddenRebuild(db, { excludeImageIds: [], ...trials })).ids).toEqual(gone);

    await pg.exec(
      checkedRetireSql(offlineDb(), { now: NOW, excludeImageIds: [], ids: planned, ...trials })
    );
    expect(await statusOf(kept)).toBe('active');
    for (const id of gone) expect(await statusOf(id)).toBe('retired');
  });
});
